import crypto from "node:crypto"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { normalizeStrictPhoneNumber } from "@/lib/phone-number"
import { enqueueWhatsAppOtp } from "@/lib/whatsapp/queue"
import { maskWhatsAppPhone, normalizeWhatsAppNumber } from "@/lib/whatsapp/format"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { extractClientIp } from "@/lib/request-context"
import { createOtpCorrelationId, normalizeOtpError, WhatsAppOtpError } from "@/lib/whatsapp/otp-errors"
import { writeWhatsAppQueueLog } from "@/lib/whatsapp/diagnostics"
import { blockSecurityContext, getSecurityContext, logSuspiciousRequest, type SecurityContext } from "@/lib/security/abuse"
import { requireSecret } from "@/lib/security/env-secret"

const OTP_TTL_MS = 5 * 60_000
const VERIFY_TOKEN_TTL_MS = 15 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const MAX_ATTEMPTS = 5
const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60_000
const MAX_PHONE_SENDS_PER_WINDOW = 3
const MAX_IP_SENDS_PER_WINDOW = 3
const OTP_DAILY_PHONE_LIMIT = 5

function authSecret() {
  return requireSecret(["AUTH_SECRET", "NEXTAUTH_SECRET"], "zws")
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function hashOtp(phone: string, otp: string) {
  return sha256(`signup-phone:${phone}:${otp}:${authSecret()}`)
}

function hashVerificationToken(token: string) {
  return sha256(`signup-token:${token}:${authSecret()}`)
}

function getRequestIp(request: NextRequest | Request) {
  const ip = extractClientIp(request)
  return ip === "unknown" ? null : ip
}

function getUserAgent(request: NextRequest | Request) {
  return request.headers.get("user-agent") || null
}

export function generateSignupOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

export function normalizeSignupPhone(phone: string, countryCode?: string | null) {
  try {
    const normalized = normalizeStrictPhoneNumber(phone, countryCode)
    const whatsapp = normalizeWhatsAppNumber(normalized.e164, normalized.countryCode)
    return {
      phone: normalized.e164,
      countryCode: normalized.countryCode,
      nationalNumber: normalized.nationalNumber,
      callingCode: normalized.callingCode,
      maskedPhone: maskWhatsAppPhone(normalized.e164),
      jid: whatsapp.jid,
      phoneHash: whatsapp.phoneHash,
    }
  } catch (error) {
    throw new WhatsAppOtpError({
      code: "invalid_phone",
      stage: "phone_normalization",
      message: error instanceof Error ? error.message : "Enter a valid phone number",
      status: 400,
      retryable: false,
    })
  }
}

async function assertRateLimits(input: { phone: string; ip: string | null; force?: boolean; ctx?: SecurityContext | null }) {
  if (input.force) return
  const now = Date.now()
  await cleanupStalePhoneVerifications(input.phone).catch(() => null)
  const windowStart = new Date(now - OTP_RATE_LIMIT_WINDOW_MS)
  const dayStart = new Date(now - 24 * 60 * 60_000)
  const cooldownAfter = new Date(now - RESEND_COOLDOWN_MS)
  const [recentForPhone, recentForIp, dailyForPhone, latestForPhone] = await Promise.all([
    (prisma as any).phoneVerification.count({
      where: {
        phone: input.phone,
        createdAt: { gte: windowStart },
        deliveryStatus: { notIn: ["failed", "expired", "abandoned"] },
      },
    }),
    input.ip ? (prisma as any).phoneVerification.count({
      where: {
        ip: input.ip,
        createdAt: { gte: windowStart },
        deliveryStatus: { notIn: ["failed", "expired", "abandoned"] },
      },
    }) : Promise.resolve(0),
    (prisma as any).phoneVerification.count({
      where: {
        phone: input.phone,
        createdAt: { gte: dayStart },
        deliveryStatus: { notIn: ["failed", "expired", "abandoned"] },
      },
    }),
    (prisma as any).phoneVerification.findFirst({
      where: {
        phone: input.phone,
        verifiedAt: null,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        deliveryStatus: { notIn: ["failed", "expired", "abandoned"] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ])
  if (latestForPhone?.createdAt && latestForPhone.createdAt > cooldownAfter && !latestForPhone.verifiedAt) {
    if (input.ctx) {
      await logSuspiciousRequest(input.ctx, "otp_cooldown_abuse", "warn", "rate_limited", { phone: input.phone })
    }
    const retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - (now - latestForPhone.createdAt.getTime())) / 1000)
    throw new WhatsAppOtpError({
      code: "rate_limited",
      stage: "rate_limit",
      message: "Please wait before requesting another code.",
      status: 429,
      retryable: true,
      retryAfterSeconds,
    })
  }
  if (dailyForPhone >= OTP_DAILY_PHONE_LIMIT) {
    if (input.ctx) {
      await logSuspiciousRequest(input.ctx, "otp_daily_abuse", "warn", "rate_limited", {
        phone: input.phone,
        count: dailyForPhone,
        limit: OTP_DAILY_PHONE_LIMIT,
      }, input.phone)
      if (dailyForPhone >= OTP_DAILY_PHONE_LIMIT + 2) {
        await blockSecurityContext(input.ctx, "otp_abuse", "otp_abuse", { phone: input.phone, count: dailyForPhone })
      }
    }
    throw new WhatsAppOtpError({
      code: "rate_limited",
      stage: "rate_limit",
      message: "Too many OTP requests for this number today. Try again later.",
      status: 429,
      retryable: true,
    })
  }
  if (recentForPhone >= MAX_PHONE_SENDS_PER_WINDOW || recentForIp >= MAX_IP_SENDS_PER_WINDOW) {
    if (input.ctx) {
      await logSuspiciousRequest(input.ctx, "otp_rate_limit_abuse", "warn", "rate_limited", {
        phone: input.phone,
        recentForPhone,
        recentForIp,
      }, input.phone)
    }
    throw new WhatsAppOtpError({
      code: "rate_limited",
      stage: "rate_limit",
      message: "Too many attempts. Try again later.",
      status: 429,
      retryable: true,
    })
  }
}

export async function cleanupStalePhoneVerifications(phone?: string | null) {
  const now = new Date()
  const staleQueuedBefore = new Date(Date.now() - 10 * 60_000)
  await (prisma as any).phoneVerification.updateMany({
    where: {
      ...(phone ? { phone } : {}),
      verifiedAt: null,
      consumedAt: null,
      expiresAt: { lt: now },
      deliveryStatus: { notIn: ["expired", "delivered", "acked", "whatsapp_server_ack", "whatsapp_device_ack", "read"] },
    },
    data: { deliveryStatus: "expired" },
  }).catch(() => null)
  await (prisma as any).phoneVerification.updateMany({
    where: {
      ...(phone ? { phone } : {}),
      verifiedAt: null,
      consumedAt: null,
      createdAt: { lt: staleQueuedBefore },
      deliveryStatus: { in: ["queued", "processing", "sending", "retrying"] },
    },
    data: { deliveryStatus: "failed" },
  }).catch(() => null)
}

export async function startSignupPhoneVerification(input: {
  request: NextRequest
  phone: string
  countryCode?: string | null
  firstName?: string | null
  force?: boolean
}) {
  const normalized = normalizeSignupPhone(input.phone, input.countryCode)
  await cleanupStalePhoneVerifications(normalized.phone).catch(() => null)
  const ip = getRequestIp(input.request)
  const ctx = await getSecurityContext(input.request).catch(() => null)
  await assertRateLimits({ phone: normalized.phone, ip, force: input.force, ctx })
  const otpCorrelationId = createOtpCorrelationId("signup_otp")

  const otp = generateSignupOtp()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
  const record = await (prisma as any).phoneVerification.create({
    data: {
      phone: normalized.phone,
      countryCode: normalized.countryCode,
      otpHash: hashOtp(normalized.phone, otp),
      expiresAt,
      ip,
      userAgent: getUserAgent(input.request),
      deliveryStatus: "queued",
      otpCorrelationId,
    },
  })

  try {
    const brandName = await resolveBrandIdentity()
    const job = await enqueueWhatsAppOtp({
      customerId: "",
      phone: normalized.phone,
      otp,
      minutes: 5,
      templateKey: WHATSAPP_TEMPLATE_KEYS.AUTH_SIGNUP_OTP,
      phoneVerificationId: record.id,
      variables: {
        first_name: input.firstName || "there",
        phone: normalized.phone,
        masked_phone: normalized.maskedPhone,
        company_name: brandName,
      },
      metadata: {
        otpCorrelationId,
        source: "signup_phone_verification",
        normalizedPhone: normalized.maskedPhone,
        countryCode: normalized.countryCode,
        jid: normalized.jid,
      },
      generatedAt: record.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    } as any)
    await (prisma as any).phoneVerification.update({
      where: { id: record.id },
      data: { deliveryStatus: "queued" },
    })
    await writeWhatsAppQueueLog({
      queueName: "whatsapp-auth",
      queueJobId: job.id || null,
      event: "otp.signup_enqueued",
      status: "queued",
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      metadata: {
        otpCorrelationId,
        phoneVerificationId: record.id,
        countryCode: normalized.countryCode,
        jid: normalized.jid,
      },
    })
  } catch (error) {
    await (prisma as any).phoneVerification.update({
      where: { id: record.id },
      data: { deliveryStatus: "failed" },
    }).catch(() => null)
    throw normalizeOtpError(error, "redis_queue")
  }

  return {
    verificationId: record.id,
    phone: normalized.phone,
    countryCode: normalized.countryCode,
    maskedPhone: normalized.maskedPhone,
    expiresAt: expiresAt.toISOString(),
    cooldownUntil: new Date(Date.now() + RESEND_COOLDOWN_MS).toISOString(),
    otpCorrelationId,
    deliveryStatus: "queued",
  }
}

export async function verifySignupPhoneOtp(input: {
  verificationId: string
  phone: string
  countryCode?: string | null
  otp: string
  request?: NextRequest
}) {
  const normalized = normalizeSignupPhone(input.phone, input.countryCode)
  const code = String(input.otp || "").replace(/\D/g, "")
  if (code.length !== 6) {
    const error = new Error("Enter the 6-digit OTP.")
    ;(error as Error & { status?: number }).status = 400
    throw error
  }
  const record = await (prisma as any).phoneVerification.findUnique({ where: { id: input.verificationId } })
  if (!record || record.phone !== normalized.phone) {
    const error = new Error("Verification session not found for this phone number.")
    ;(error as Error & { status?: number }).status = 404
    throw error
  }
  if (record.verifiedAt && !record.consumedAt && record.expiresAt.getTime() >= Date.now()) {
    const token = crypto.randomBytes(32).toString("hex")
    const tokenHash = hashVerificationToken(token)
    await (prisma as any).phoneVerification.update({ where: { id: record.id }, data: { verificationToken: tokenHash } })
    return {
      verificationToken: token,
      verificationId: record.id as string,
      verifiedAt: (record.verifiedAt as Date).toISOString(),
      phone: normalized.phone,
      countryCode: normalized.countryCode,
      verified: true,
    }
  }
  if (record.verifiedAt || record.consumedAt) {
    const error = new Error("Verification session expired. Please request a new code.")
    ;(error as Error & { status?: number }).status = 400
    throw error
  }
  if (record.expiresAt.getTime() < Date.now()) {
    await (prisma as any).phoneVerification.update({ where: { id: record.id }, data: { deliveryStatus: "expired" } }).catch(() => null)
    const error = new Error("OTP expired. Please request a new code.")
    ;(error as Error & { status?: number }).status = 400
    throw error
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    const error = new Error("Too many attempts. Try again later.")
    ;(error as Error & { status?: number; code?: string }).status = 429
    ;(error as Error & { code?: string }).code = "phone_verification_attempts_exceeded"
    throw error
  }
  if (record.otpHash !== hashOtp(normalized.phone, code)) {
    await (prisma as any).phoneVerification.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } })
    const error = new Error("Invalid OTP.")
    ;(error as Error & { status?: number }).status = 400
    throw error
  }

  const token = crypto.randomBytes(32).toString("hex")
  const tokenHash = hashVerificationToken(token)
  const verifiedAt = new Date()
  await (prisma as any).phoneVerification.update({
    where: { id: record.id },
    data: {
      verifiedAt,
      verificationToken: tokenHash,
      deliveryStatus: "delivered",
      ip: input.request ? getRequestIp(input.request) : record.ip,
      userAgent: input.request ? getUserAgent(input.request) : record.userAgent,
    },
  })
  return {
    verificationToken: token,
    verificationId: record.id as string,
    verifiedAt: verifiedAt.toISOString(),
    phone: normalized.phone,
    countryCode: normalized.countryCode,
    verified: true,
  }
}

export async function consumeSignupPhoneVerification(input: {
  phone: string
  countryCode?: string | null
  verificationToken: string
  verificationId?: string | null
}) {
  const normalized = normalizeSignupPhone(input.phone, input.countryCode)
  const tokenHash = hashVerificationToken(String(input.verificationToken || ""))
  const minCreatedAt = new Date(Date.now() - VERIFY_TOKEN_TTL_MS)
  const record = await (prisma as any).phoneVerification.findFirst({
    where: {
      id: input.verificationId ? String(input.verificationId) : undefined,
      phone: normalized.phone,
      verificationToken: tokenHash,
      verifiedAt: { not: null },
      consumedAt: null,
      createdAt: { gte: minCreatedAt },
    },
    orderBy: { verifiedAt: "desc" },
  })
  if (!record || record.expiresAt.getTime() < Date.now()) {
    const error = new Error("Verify your WhatsApp number before creating an account.")
    ;(error as Error & { status?: number; code?: string }).status = 403
    ;(error as Error & { code?: string }).code = "phone_verification_required"
    throw error
  }
  await (prisma as any).phoneVerification.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  })
  return {
    phone: normalized.phone,
    countryCode: normalized.countryCode,
    verifiedAt: record.verifiedAt as Date,
    verificationId: record.id as string,
  }
}
