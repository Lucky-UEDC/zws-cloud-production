import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/db"
import { getSetting, passwordMeetsRules, type PlatformSettings, type SecuritySettings } from "@/lib/settings"
import { isUserRole } from "@/lib/roles"
import { sendVerificationEmail } from "@/lib/email-verification"
import { sendTemplateEmail } from "@/lib/email/send-mail"
import { missingBillingAddressFields, normalizeBillingAddress, normalizeEmail } from "@/lib/checkout-identity"
import { normalizeStrictPhoneNumber } from "@/lib/phone-number"
import { sendNotification } from "@/lib/notifications/service"
import { consumeSignupPhoneVerification } from "@/lib/auth/phone-verification"
import { dispatchAdminNotification } from "@/lib/admin-notification-dispatcher"
import { issueClientSession } from "@/lib/auth-flows"
import { findDuplicateAccount, rememberAccountIdentity } from "@/lib/account-duplicate-protection"
import { markAttempt, requireRateLimit, requireTurnstile, securityGate } from "@/lib/security/forms"
import { validateSecurityField } from "@/lib/security/input"
import { rejectDetectedPayload } from "@/lib/security/abuse"
import { captureReferral, type CaptureReferralResult } from "@/lib/referrals/attribution"
import {
  attributeSignupToVisit,
  parseAttribution,
  REFERRAL_ATTRIBUTION_COOKIE,
} from "@/lib/referrals/visits"

function maskEmail(email: string) {
  const [name = "", domain = ""] = String(email || "").split("@")
  if (!domain) return "[invalid]"
  return `${name.slice(0, 2)}***@${domain}`
}

function maskPhone(phone: string) {
  return String(phone || "").replace(/\d(?=\d{2})/g, "*")
}

function registerLog(stage: string, details: Record<string, unknown>) {
  console.info("[REGISTER]", { stage, ...details })
}

function registerError(stage: string, error: unknown, details: Record<string, unknown> = {}) {
  console.error("[REGISTER]", {
    stage,
    ...details,
    error: error instanceof Error ? error.message : String(error),
    code: (error as any)?.code,
    status: (error as any)?.status,
  })
}

export async function POST(request: NextRequest) {
  const gate = await securityGate(request)
  if (!gate.ok) return gate.response

  try {
    const body = (await request.json()) as {
      name?: string
      email?: string
      phone?: string
      countryCode?: string
      verificationToken?: string
      verificationId?: string
      address?: string
      addressLine1?: string
      city?: string
      state?: string
      country?: string
      pinZip?: string
      postalCode?: string
      password?: string
      turnstileToken?: string
      referralCode?: string
    }

    const captcha = await requireTurnstile(gate.ctx, body.turnstileToken, "register")
    if (!captcha.ok) return captcha.response
    const rate = await requireRateLimit(gate.ctx, "register", 2, 60 * 60_000)
    if (!rate.ok) return rate.response
    const publicFields = [
      ["name", validateSecurityField(body.name, "name", "Name")],
      ["email", validateSecurityField(String(body.email || "").toLowerCase(), "email", "Email")],
      ["addressLine1", validateSecurityField(body.addressLine1 || body.address, "address", "Address")],
      ["city", validateSecurityField(body.city, "address", "City")],
      ["state", validateSecurityField(body.state, "address", "State")],
      ["country", validateSecurityField(body.country || "India", "address", "Country")],
      ["postalCode", validateSecurityField(body.pinZip || body.postalCode, "address", "Postal code")],
    ] as const
    for (const [field, result] of publicFields) {
      if (!result.ok) {
        if (result.detection.dangerous) return rejectDetectedPayload(gate.ctx, result.detection, field)
        await markAttempt(gate.ctx, "register", gate.ctx.ip, "validation_failed")
        return NextResponse.json({ error: result.error, code: "invalid_request", field }, { status: 400 })
      }
    }

    registerLog("request_received", {
      body: {
        namePresent: Boolean(body.name),
        email: maskEmail(String(body.email || "")),
        phonePresent: Boolean(body.phone),
        countryCode: body.countryCode || null,
        verificationTokenPresent: Boolean(body.verificationToken),
        verificationIdPresent: Boolean(body.verificationId),
        addressLine1Present: Boolean(body.addressLine1 || body.address),
        cityPresent: Boolean(body.city),
        statePresent: Boolean(body.state),
        countryPresent: Boolean(body.country),
        postalPresent: Boolean(body.pinZip || body.postalCode),
        passwordPresent: Boolean(body.password),
      },
    })

    const name = String(body.name || "").trim()
    const email = normalizeEmail(body.email)
    const countryCode = String(body.countryCode || "").trim()
    const normalizedPhone = normalizeStrictPhoneNumber(body.phone || "", countryCode)
    const phone = normalizedPhone.e164
    const verificationToken = String(body.verificationToken || "").trim()
    const verificationId = String(body.verificationId || "").trim()
    const password = String(body.password || "")
    registerLog("normalized_phone", {
      email: maskEmail(email),
      phone: maskPhone(phone),
      countryCode: normalizedPhone.countryCode,
      nationalNumberLength: normalizedPhone.nationalNumber.length,
      verificationTokenPresent: Boolean(verificationToken),
      verificationIdPresent: Boolean(verificationId),
    })
    const billingInput = {
      name,
      email,
      phone,
      addressLine1: body.addressLine1 || body.address,
      city: body.city,
      state: body.state,
      country: body.country || "India",
      postalCode: body.pinZip || body.postalCode,
    }
    const missingBillingFields = missingBillingAddressFields(billingInput, { requirePhone: true })
    if (missingBillingFields.length) {
      registerLog("validation_failed", { email: maskEmail(email), reason: "billing_address_required", missingFields: missingBillingFields })
      await markAttempt(gate.ctx, "register", gate.ctx.ip, "billing_address_required")
      return NextResponse.json({
        error: "Complete billing address is required",
        code: "billing_address_required",
        missingFields: missingBillingFields,
      }, { status: 400 })
    }
    const billingAddress = normalizeBillingAddress(billingInput)

    if (!name || !email || !phone || !password) {
      registerLog("validation_failed", { email: maskEmail(email), reason: "required_fields" })
      await markAttempt(gate.ctx, "register", gate.ctx.ip, "required_fields")
      return NextResponse.json({ error: "All fields are required" }, { status: 400 })
    }
    if (!verificationToken) {
      registerLog("validation_failed", { email: maskEmail(email), reason: "phone_verification_required" })
      await markAttempt(gate.ctx, "register", gate.ctx.ip, "phone_verification_required")
      return NextResponse.json({ error: "Verify your WhatsApp number before creating an account.", code: "phone_verification_required" }, { status: 403 })
    }

    const platform = await getSetting<PlatformSettings>("platform_settings")
    if (!platform.allowRegistration) {
      registerLog("validation_failed", { email: maskEmail(email), reason: "registration_disabled" })
      return NextResponse.json({ error: "Registration is currently disabled" }, { status: 403 })
    }

    const security = await getSetting<SecuritySettings>("security_settings")
    if (!passwordMeetsRules(password, security)) {
      registerLog("validation_failed", { email: maskEmail(email), reason: "password_policy" })
      return NextResponse.json({ error: "Password does not meet security policy" }, { status: 400 })
    }

    const duplicate = await findDuplicateAccount({ email, phone })
    if (duplicate.duplicate) {
      registerLog("validation_failed", { email: maskEmail(email), phone: maskPhone(phone), reason: `${duplicate.field}_taken` })
      const duplicateMessage = duplicate.field === "phone"
        ? "An account with this phone number already exists"
        : "An account with this email already exists"
      return NextResponse.json({ error: duplicateMessage, code: `${duplicate.field}_taken` }, { status: 409 })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const role = isUserRole(platform.defaultUserRole) ? platform.defaultUserRole : "client"

    if (role === "admin") {
      registerLog("validation_failed", { email: maskEmail(email), reason: "admin_default_role_blocked" })
      return NextResponse.json(
        { error: "Public registration cannot create admin accounts. Change the default role in settings." },
        { status: 403 }
      )
    }

    registerLog("verification_lookup_started", { email: maskEmail(email), phone: maskPhone(phone), countryCode, verificationIdPresent: Boolean(verificationId) })
    const verifiedPhone = await consumeSignupPhoneVerification({ phone, countryCode, verificationToken, verificationId })
    registerLog("verification_lookup_completed", {
      email: maskEmail(email),
      verificationId: verifiedPhone.verificationId,
      phone: maskPhone(verifiedPhone.phone),
      verifiedAt: verifiedPhone.verifiedAt,
    })

    if (role === "support_agent") {
      const baseUsername = email.split("@")[0]?.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "support-agent"
      const username = `${baseUsername}-${Math.random().toString(36).slice(2, 8)}`

      await prisma.adminProfile.create({
        data: {
          email,
          username,
          displayName: name,
          hashedPassword,
          role: "support_agent",
          isActive: false,
        },
      })
      registerLog("support_registration_created", { email: maskEmail(email), role })

      return NextResponse.json({
        success: true,
        pendingApproval: true,
        message: "Support agent registration submitted. An administrator must approve your account before login.",
      })
    }

    registerLog("db_create_started", { email: maskEmail(email), role, phone: maskPhone(verifiedPhone.phone) })
    const customer = await prisma.customer.create({
      data: {
        email,
        name,
        phone: verifiedPhone.phone,
        addressLine1: billingAddress.addressLine1,
        addressLine2: billingAddress.addressLine2,
        city: billingAddress.city,
        state: billingAddress.state,
        country: billingAddress.country,
        postalCode: billingAddress.postalCode,
        address: {
          line1: billingAddress.addressLine1,
          line2: billingAddress.addressLine2,
          city: billingAddress.city,
          state: billingAddress.state,
          country: billingAddress.country,
          postalCode: billingAddress.postalCode,
        } as any,
        hashedPassword,
        isActive: true,
        phoneVerified: true,
        phoneVerifiedAt: verifiedPhone.verifiedAt,
        whatsappOptIn: true,
        metadata: {
          role,
          notifyOnNewRegistration: platform.notifyOnNewRegistration,
          requiresEmailVerification: false,
          requiresPhoneVerification: false,
          phoneVerificationId: verifiedPhone.verificationId,
        } as any,
      },
    })
    await rememberAccountIdentity({ email: customer.email, phone: customer.phone || verifiedPhone.phone }).catch(() => undefined)
    registerLog("db_create_completed", { email: maskEmail(customer.email), customerId: customer.id, phoneVerified: customer.phoneVerified })

    // Referral attribution is best effort and must never fail a signup: the
    // code is only a hint, the referred customer is the one we just created,
    // and first-touch is enforced by the unique index on referred_customer_id.
    const referralResult = await captureReferral({
      referredCustomerId: customer.id,
      code: String(body.referralCode || ""),
      source: "link",
      metadata: { source: "public_registration" },
    }).catch((error) => {
      console.error("[REGISTER] referral_capture_failed", error instanceof Error ? error.message : String(error))
      return null as CaptureReferralResult | null
    })
    if (referralResult) registerLog("referral_attributed", { customerId: customer.id, status: referralResult.status })

    // Link the tracked visit to the account it produced, so the funnel can
    // separate clicks from real registrations. The visitor identity comes from
    // the server-set httpOnly cookie, never from the request body.
    await attributeSignupToVisit({
      customerId: customer.id,
      code: String(body.referralCode || ""),
      visitorId: parseAttribution(request.cookies.get(REFERRAL_ATTRIBUTION_COOKIE)?.value)?.visitorId || null,
    }).catch((error) => {
      console.error("[REGISTER] referral_visit_link_failed", error instanceof Error ? error.message : String(error))
      return { visitId: null, code: null }
    })

    await Promise.allSettled([
      sendTemplateEmail({
        templateKey: "account_created",
        to: customer.email,
        variables: { userName: customer.name || "there", email: customer.email },
        customerId: customer.id,
        metadata: { source: "public_registration" },
      }),
      sendVerificationEmail({ userId: customer.id, redirectTo: "/client-area", reason: "registration" }),
      sendNotification({
        type: "auth",
        channels: ["whatsapp"],
        user: { id: customer.id, email: customer.email, phone: customer.phone, name: customer.name },
        data: { templateKey: "signup_success", metadata: { source: "public_registration", category: "auth" } },
      }),
      dispatchAdminNotification({
        event: "account_create",
        message: `New account created: ${customer.email}`,
        request,
        metadata: { customerId: customer.id },
      }),
    ]).catch((error) => console.error("Registration notification failed:", error))

    registerLog("session_issue_started", { email: maskEmail(customer.email), customerId: customer.id })
    const session = await issueClientSession(customer, security.sessionTimeoutMinutes, request)
    registerLog("session_issue_completed", { email: maskEmail(customer.email), customerId: customer.id, redirectTo: session.redirectTo })

    return NextResponse.json({
      success: true,
      customerId: customer.id,
      phoneMasked: verifiedPhone.phone.replace(/\d(?=\d{2})/g, "*"),
      redirectTo: session.redirectTo,
      authenticated: session.authenticated,
      message: "Account created. Redirecting to your dashboard...",
    })
  } catch (error) {
    await markAttempt(gate.ctx, "register", gate.ctx.ip, "exception")
    registerError("thrown_error", error)
    if ((error as any)?.code === "invalid_phone") {
      return NextResponse.json({ success: false, error: "Enter a valid phone number", message: "Enter a valid phone number", code: "invalid_phone" }, { status: 400 })
    }
    if ((error as any)?.code === "phone_verification_required") {
      return NextResponse.json({ success: false, error: "Verify your WhatsApp number before creating an account.", message: "Verify your WhatsApp number before creating an account.", code: "phone_verification_required" }, { status: (error as any)?.status || 403 })
    }
    if ((error as any)?.code === "billing_address_required") {
      return NextResponse.json({
        success: false,
        error: "Complete billing address is required",
        message: "Complete billing address is required",
        code: "billing_address_required",
        missingFields: Array.isArray((error as any)?.fields) ? (error as any).fields : undefined,
      }, { status: 400 })
    }
    if ((error as any)?.code === "P2002") {
      return NextResponse.json({
        success: false,
        error: "An account with this email or phone already exists",
        message: "An account with this email or phone already exists",
        code: "duplicate_account",
      }, { status: 409 })
    }
    if (/phoneVerification|phone_verifications|prisma/i.test(String((error as Error)?.message || ""))) {
      return NextResponse.json({ success: false, error: "Unable to confirm WhatsApp verification right now.", message: "Unable to confirm WhatsApp verification right now.", code: "phone_verification_lookup_failed" }, { status: 503 })
    }
    return NextResponse.json({ success: false, error: "Internal server error", message: "Internal server error" }, { status: 500 })
  }
}
