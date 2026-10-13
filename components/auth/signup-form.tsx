"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronsUpDown, Copy, Eye, EyeOff, MessageCircle, RefreshCw, ShieldCheck } from "lucide-react"
import { City, Country, State } from "country-state-city"
import flags from "react-phone-number-input/flags"
import { parsePhoneNumberFromString } from "libphonenumber-js"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldError,
  FieldDescription,
} from "@/components/ui/field"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { PasswordStrengthMeter } from "@/components/auth/password-strength"
import { TurnstileWidget, useTurnstileConfig } from "@/components/security/turnstile-widget"
import { isValidEmail, scorePassword } from "@/lib/auth-validation"
import { hasOnlyPhoneInputCharacters, normalizeStrictPhoneNumber, PHONE_VALIDATION_MESSAGE, sanitizePhoneInput } from "@/lib/phone-number"
import { filterCountrySearchOptions } from "@/lib/country-search"
import { cn } from "@/lib/utils"
import type { ResolvedLocation } from "@/lib/geo/resolve-location"
import { safeClientReturnPath } from "@/lib/client/checkout-resume"

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string; field?: keyof Values }
  | { status: "success"; message?: string; customerId?: string; redirectTo?: string }

type OtpState = {
  status: "idle" | "typing" | "ready" | "sending" | "sent" | "verifying" | "verified" | "failed" | "provider_unavailable"
  message?: string
  verificationId?: string
  verificationToken?: string
  maskedPhone?: string
  cooldownUntil?: string
  deliveryStatus?: string
}

type VerifiedSession = {
  phone: string
  countryCode: string
  verificationToken: string
  verificationId: string
  verifiedAt: string
}

type Values = {
  name: string
  email: string
  phone: string
  phoneCountryCode: string
  addressLine1: string
  city: string
  state: string
  country: string
  addressCountryCode: string
  addressStateCode: string
  pinZip: string
  password: string
}

const DEFAULT_COUNTRY = "IN"
const VERIFIED_SESSION_STORAGE_KEY = "zws.signup.verifiedSession"
const PROVIDER_UNAVAILABLE_MESSAGE = "WhatsApp is not available on this number."
const EXPECTED_NATIONAL_LENGTH: Record<string, number> = { IN: 10, US: 10 }
const COUNTRIES = Country.getAllCountries().sort((a, b) => a.name.localeCompare(b.name))
const FLAG_COMPONENTS = flags as Record<string, React.ComponentType<{ title?: string }>>

function normalizeDialCode(phonecode: string) {
  const digits = String(phonecode || "").replace(/\D/g, "")
  return digits ? `+${digits}` : ""
}

function countryByCode(countryCode: string) {
  return COUNTRIES.find((country) => country.isoCode === countryCode) || COUNTRIES.find((country) => country.isoCode === DEFAULT_COUNTRY)!
}

function flag(countryCode: string) {
  const code = countryCode.toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ""
  return Array.from(code).map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join("")
}

function countryLabel(countryCode: string) {
  const country = countryByCode(countryCode)
  return `${flag(country.isoCode)} ${country.name} (${normalizeDialCode(country.phonecode)})`
}

function countrySearchOption(country: (typeof COUNTRIES)[number]) {
  const dialCode = normalizeDialCode(country.phonecode)
  return {
    value: country.isoCode,
    name: country.name,
    isoCode: country.isoCode,
    dialCode,
    label: `${country.name} ${country.isoCode} ${dialCode}`,
    display: <CountrySelectLabel countryCode={country.isoCode} />,
  }
}

function countryTextSearchOption(country: (typeof COUNTRIES)[number]) {
  const option = countrySearchOption(country)
  return {
    ...option,
    display: countryLabel(country.isoCode),
  }
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || "there"
}

function emailDomain(email: string) {
  return String(email || "").split("@")[1]?.toLowerCase() || ""
}

function maskPhoneForLog(phone: string) {
  return String(phone || "").replace(/\d(?=\d{2})/g, "*")
}

function isVerifiedSession(value: unknown): value is VerifiedSession {
  const session = value as Partial<VerifiedSession> | null
  return Boolean(
    session &&
    typeof session.phone === "string" &&
    typeof session.countryCode === "string" &&
    typeof session.verificationToken === "string" &&
    typeof session.verificationId === "string" &&
    typeof session.verifiedAt === "string"
  )
}

function readStoredVerifiedSession(): VerifiedSession | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(VERIFIED_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isVerifiedSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeStoredVerifiedSession(session: VerifiedSession | null) {
  if (typeof window === "undefined") return
  try {
    if (session) {
      window.sessionStorage.setItem(VERIFIED_SESSION_STORAGE_KEY, JSON.stringify(session))
    } else {
      window.sessionStorage.removeItem(VERIFIED_SESSION_STORAGE_KEY)
    }
  } catch {
    // Session storage is an optional resilience layer; React state remains canonical.
  }
}

function initialValues(geo: ResolvedLocation): Values {
  const country = countryByCode(geo.countryCode || DEFAULT_COUNTRY)
  const indiaFallback = country.isoCode === "IN" ? indiaAddressFallback(geo.state, geo.city) : null
  return {
    name: "",
    email: "",
    phone: "",
    phoneCountryCode: country.isoCode,
    addressLine1: "",
    city: geo.city || indiaFallback?.city || "",
    state: geo.state || indiaFallback?.state || "",
    country: country.name,
    addressCountryCode: country.isoCode,
    addressStateCode: geo.stateCode || indiaFallback?.stateCode || "",
    pinZip: geo.postalCode || "",
    password: "",
  }
}

export function SignupForm({ initialGeo, nextTo = "", referralCode = "" }: { initialGeo: ResolvedLocation; nextTo?: string; referralCode?: string }) {
  const router = useRouter()
  const [values, setValues] = useState<Values>(() => initialValues(initialGeo))
  const [touched, setTouched] = useState<Partial<Record<keyof Values, boolean>>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [state, setState] = useState<FormState>({ status: "idle" })
  const [otpState, setOtpState] = useState<OtpState>({ status: "idle" })
  const [otp, setOtp] = useState("")
  const [modalOpen, setModalOpen] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [phoneRejected, setPhoneRejected] = useState(false)
  const [phoneVerifyAttempted, setPhoneVerifyAttempted] = useState(false)
  const [verifiedSession, setVerifiedSession] = useState<VerifiedSession | null>(null)
  const [turnstileToken, setTurnstileToken] = useState("")
  const turnstile = useTurnstileConfig()
  const captchaRequired = turnstile.enabled && turnstile.protect.signup
  const touchedRef = useRef(touched)

  useEffect(() => {
    touchedRef.current = touched
  }, [touched])

  const selectedAddressCountry = useMemo(() => countryByCode(values.addressCountryCode), [values.addressCountryCode])
  const states = useMemo(() => State.getStatesOfCountry(values.addressCountryCode), [values.addressCountryCode])
  const cities = useMemo(() => values.addressStateCode ? City.getCitiesOfState(values.addressCountryCode, values.addressStateCode) : [], [values.addressCountryCode, values.addressStateCode])
  const countryOptions = useMemo(() => COUNTRIES.map(countrySearchOption), [])
  const countryTextOptions = useMemo(() => COUNTRIES.map(countryTextSearchOption), [])
  const e164Phone = useMemo(() => normalizeE164(values.phone, values.phoneCountryCode), [values.phone, values.phoneCountryCode])
  const normalizedPhone = useMemo(() => {
    try {
      return normalizeStrictPhoneNumber(values.phone, values.phoneCountryCode)
    } catch {
      return null
    }
  }, [values.phone, values.phoneCountryCode])
  const errors = useMemo(() => validate(values, e164Phone, phoneRejected, phoneVerifyAttempted), [values, e164Phone, phoneRejected, phoneVerifyAttempted])
  const hasErrors = Object.keys(errors).length > 0
  const isSubmitting = state.status === "submitting"
  const verified = Boolean(
    verifiedSession?.verificationToken &&
    verifiedSession.verificationId &&
    verifiedSession.phone &&
    verifiedSession.phone === e164Phone &&
    verifiedSession.countryCode === values.phoneCountryCode
  )
  const submitReadiness = useMemo(() => {
    if (isSubmitting) return { ready: false, reason: "submitting" as const }
    if (!verified || !verifiedSession) return { ready: false, reason: "unverified" as const }
    if (hasErrors) return { ready: false, reason: "invalid" as const }
    if (captchaRequired && !turnstileToken) return { ready: false, reason: "captcha" as const }
    return { ready: true, reason: "ready" as const }
  }, [captchaRequired, hasErrors, isSubmitting, turnstileToken, verified, verifiedSession])
  const canCreate = submitReadiness.ready
  const lockedPhoneLabel = verifiedSession ? formatNationalPreview(verifiedSession.phone) : ""
  const verifiedPhoneDisplay = verifiedSession?.phone || ""
  const showPhoneError = Boolean((phoneVerifyAttempted || touched.phone) && errors.phone)
  const passwordStrength = useMemo(() => scorePassword(values.password), [values.password])
  const passwordRequirements = useMemo(() => passwordRequirementRows(values.password), [values.password])

  useEffect(() => {
    if (verifiedSession || !e164Phone) return
    const stored = readStoredVerifiedSession()
    if (!stored) return
    if (stored.phone === e164Phone && stored.countryCode === values.phoneCountryCode) {
      setVerifiedSession(stored)
      setOtpState((current) => ({
        ...current,
        status: "verified",
        verificationId: stored.verificationId,
        verificationToken: stored.verificationToken,
        maskedPhone: current.maskedPhone || stored.phone,
        message: "WhatsApp number verified.",
      }))
      console.info("[SIGNUP] verified_session_restored", {
        phone: maskPhoneForLog(stored.phone),
        countryCode: stored.countryCode,
        verificationId: stored.verificationId,
        verificationTokenPresent: Boolean(stored.verificationToken),
      })
    } else {
      writeStoredVerifiedSession(null)
    }
  }, [e164Phone, values.phoneCountryCode, verifiedSession])

  useEffect(() => {
    const timezone = browserTimezone()
    fetch("/api/geo", {
      cache: "no-store",
      headers: timezone ? { "x-zws-browser-timezone": timezone } : undefined,
    })
      .then((response) => response.ok ? readJsonResponse<ResolvedLocation>(response) : null)
      .then((data: ResolvedLocation | null) => {
        const browserCountry = browserLocaleCountry()
        const countryCode = data?.countryCode && data.source !== "default" ? data.countryCode : browserCountry || data?.countryCode
        if (!countryCode) return
        const touchedNow = touchedRef.current
        const country = countryByCode(countryCode)
        setValues((current) => {
          const indiaFallback = country.isoCode === "IN" ? indiaAddressFallback(data?.state || "", data?.city || "") : null
          const nextStateCode = data?.stateCode || matchStateCode(country.isoCode, data?.state || "") || indiaFallback?.stateCode || ""
          const nextState = nextStateCode ? State.getStateByCodeAndCountry(nextStateCode, country.isoCode)?.name || data?.state || indiaFallback?.state || "" : data?.state || ""
          return {
            ...current,
            phoneCountryCode: touchedNow.phone ? current.phoneCountryCode : country.isoCode,
            addressCountryCode: touchedNow.country ? current.addressCountryCode : country.isoCode,
            country: touchedNow.country ? current.country : country.name,
            addressStateCode: touchedNow.state ? current.addressStateCode : nextStateCode,
            state: touchedNow.state ? current.state : nextState,
            city: touchedNow.city ? current.city : data?.city || indiaFallback?.city || current.city,
            pinZip: touchedNow.pinZip ? current.pinZip : data?.postalCode || current.pinZip,
          }
        })
      })
      .catch(() => null)
  }, [])

  useEffect(() => {
    if (!otpState.cooldownUntil) {
      setCountdown(0)
      return
    }
    const tick = () => {
      setCountdown(Math.max(0, Math.ceil((new Date(otpState.cooldownUntil || "").getTime() - Date.now()) / 1000)))
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [otpState.cooldownUntil])

  useEffect(() => {
    if (!otpState.verificationId || !["sent", "sending"].includes(otpState.status)) return
    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/auth/phone/signup/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            verificationId: otpState.verificationId,
            phone: e164Phone,
            countryCode: values.phoneCountryCode,
          }),
          cache: "no-store",
        })
        const data = await readJsonResponse<any>(response)
        if (cancelled || !response.ok) return
        if (data.providerUnavailable || data.deliveryStatus === "provider_unavailable") {
          setOtpState((current) => ({
            ...current,
            status: "provider_unavailable",
            deliveryStatus: data.deliveryStatus,
            message: PROVIDER_UNAVAILABLE_MESSAGE,
          }))
          setModalOpen(false)
        } else if (typeof data.deliveryStatus === "string") {
          setOtpState((current) => ({ ...current, deliveryStatus: data.deliveryStatus }))
        }
      } catch {
        // Delivery polling is best effort; the verification modal remains usable.
      }
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [e164Phone, otpState.status, otpState.verificationId, values.phoneCountryCode])

  useEffect(() => {
    if (state.status !== "success") return
    const redirectTo = safeClientReturnPath(nextTo) || state.redirectTo || "/client-area"
    const timer = window.setTimeout(() => {
      console.info("[SIGNUP] redirecting", { redirectTo })
      router.replace(redirectTo)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [nextTo, router, state])

  function resetOtp() {
    setOtpState({ status: "idle" })
    setVerifiedSession(null)
    writeStoredVerifiedSession(null)
    setOtp("")
    setPhoneVerifyAttempted(false)
  }

  function changeVerifiedNumber() {
    resetOtp()
    setPhoneRejected(false)
    setModalOpen(false)
    setState({ status: "idle" })
  }

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    if (verified && (key === "phone" || key === "phoneCountryCode")) return
    if (state.status === "error") setState({ status: "idle" })
    setValues((current) => ({ ...current, [key]: value }))
    if (key === "phone" || key === "phoneCountryCode") resetOtp()
  }

  function setPhone(value: string) {
    if (verified) return
    if (state.status === "error") setState({ status: "idle" })
    const sanitized = sanitizePhoneInput(value)
    setPhoneRejected(!hasOnlyPhoneInputCharacters(value))
    setPhoneVerifyAttempted(false)
    setTouched((current) => ({ ...current, phone: false }))
    setValues((current) => ({ ...current, phone: sanitized }))
    resetOtp()
    setOtpState({ status: sanitized && isCompletedPhone(sanitized, values.phoneCountryCode) ? "ready" : sanitized ? "typing" : "idle" })
  }

  function blur(key: keyof Values) {
    setTouched((current) => ({ ...current, [key]: true }))
  }

  function blurPhone() {
    if (isCompletedPhone(values.phone, values.phoneCountryCode)) {
      setTouched((current) => ({ ...current, phone: true }))
    }
  }

  function selectPhoneCountry(countryCode: string) {
    if (verified) return
    if (state.status === "error") setState({ status: "idle" })
    const country = countryByCode(countryCode)
    const shouldMirrorBilling = !touchedRef.current.country
    setValues((current) => ({
      ...current,
      phoneCountryCode: country.isoCode,
      phone: sanitizePhoneInput(current.phone),
      addressCountryCode: shouldMirrorBilling ? country.isoCode : current.addressCountryCode,
      country: shouldMirrorBilling ? country.name : current.country,
      addressStateCode: shouldMirrorBilling ? "" : current.addressStateCode,
      state: shouldMirrorBilling ? "" : current.state,
      city: shouldMirrorBilling ? "" : current.city,
    }))
    setPhoneRejected(false)
    setTouched((current) => ({ ...current, phone: false }))
    resetOtp()
  }

  function selectAddressCountry(countryCode: string) {
    if (state.status === "error") setState({ status: "idle" })
    const country = countryByCode(countryCode)
    setValues((current) => ({
      ...current,
      addressCountryCode: country.isoCode,
      country: country.name,
      state: "",
      addressStateCode: "",
      city: "",
    }))
    setTouched((current) => ({ ...current, country: true }))
  }

  function selectState(stateCode: string) {
    if (state.status === "error") setState({ status: "idle" })
    const selected = states.find((entry) => entry.isoCode === stateCode)
    setValues((current) => ({
      ...current,
      addressStateCode: stateCode,
      state: selected?.name || "",
      city: "",
    }))
    setTouched((current) => ({ ...current, state: true }))
  }

  function generatePassword() {
    const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*"]
    const charset = groups.join("")
    const bytes = new Uint8Array(18)
    globalThis.crypto?.getRandomValues(bytes)
    const required = groups.map((group, index) => group[bytes[index] % group.length])
    const rest = Array.from(bytes.slice(required.length), (byte) => charset[byte % charset.length])
    const password = [...required, ...rest].sort(() => Math.random() - 0.5).join("")
    set("password", password)
    setTouched((current) => ({ ...current, password: true }))
  }

  async function copyPassword() {
    if (!values.password || typeof navigator === "undefined" || !navigator.clipboard) return
    await navigator.clipboard.writeText(values.password).catch(() => null)
  }

  async function sendOtp(resend = false) {
    if (verified) return
    setPhoneVerifyAttempted(true)
    setTouched((current) => ({ ...current, phone: true, name: true }))
    const phoneError = validatePhone(values.phone, values.phoneCountryCode, e164Phone, phoneRejected, true)
    if (phoneError) {
      setOtpState({ status: "failed", message: undefined })
      return
    }
    setOtpState((current) => ({ ...current, status: "sending", message: undefined }))
    try {
      const response = await fetch(resend ? "/api/auth/phone/signup/resend" : "/api/auth/phone/signup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: e164Phone,
          countryCode: values.phoneCountryCode,
          firstName: firstName(values.name),
        }),
      })
      const data = await readJsonResponse<any>(response)
      if (!response.ok) {
        setOtpState({ status: providerUnavailable(data) ? "provider_unavailable" : "failed", message: safeSendOtpMessage(response.status, data) })
        return
      }
      setOtp("")
      setOtpState({
        status: "sent",
        verificationId: data.verificationId,
        maskedPhone: data.maskedPhone,
        cooldownUntil: data.cooldownUntil,
        deliveryStatus: data.deliveryStatus,
        message: "Verification request queued. Enter the code when it arrives.",
      })
      setModalOpen(true)
    } catch (error: any) {
      setOtpState({ status: "failed", message: error?.message || "Unable to reach verification service. Please retry." })
    }
  }

  async function verifyOtp() {
    if (verified) return
    const code = otp
    if (!otpState.verificationId || code.length !== 6 || !e164Phone) return
    setOtpState((current) => ({ ...current, status: "verifying", message: undefined }))
    try {
      const response = await fetch("/api/auth/phone/signup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationId: otpState.verificationId,
          phone: e164Phone,
          countryCode: values.phoneCountryCode,
          otp: code,
        }),
      })
      const data = await readJsonResponse<any>(response)
      if (!response.ok) {
        setOtpState((current) => ({ ...current, status: providerUnavailable(data) ? "provider_unavailable" : "failed", message: otpErrorMessage(response.status, data) }))
        return
      }
      const confirmedPhone = data.phone || e164Phone
      const confirmedCountryCode = data.countryCode || values.phoneCountryCode
      if (!data.verificationToken || !(data.verificationId || otpState.verificationId)) {
        setOtpState((current) => ({ ...current, status: "failed", message: "Verification succeeded but the secure token was not returned. Please retry." }))
        console.error("[SIGNUP] otp_verify_missing_token", {
          verificationIdPresent: Boolean(data.verificationId || otpState.verificationId),
          verificationTokenPresent: Boolean(data.verificationToken),
        })
        return
      }
      const nextVerifiedSession: VerifiedSession = {
        phone: confirmedPhone,
        countryCode: confirmedCountryCode,
        verificationToken: data.verificationToken,
        verificationId: data.verificationId || otpState.verificationId,
        verifiedAt: data.verifiedAt || new Date().toISOString(),
      }
      setVerifiedSession(nextVerifiedSession)
      writeStoredVerifiedSession(nextVerifiedSession)
      setOtpState((current) => ({
        ...current,
        status: "verified",
        verificationId: nextVerifiedSession.verificationId,
        verificationToken: data.verificationToken,
        maskedPhone: current.maskedPhone || confirmedPhone,
        message: "WhatsApp number verified.",
      }))
      console.info("[SIGNUP] otp_verified", {
        phone: maskPhoneForLog(nextVerifiedSession.phone),
        countryCode: nextVerifiedSession.countryCode,
        verificationId: nextVerifiedSession.verificationId,
        verificationTokenPresent: Boolean(nextVerifiedSession.verificationToken),
        verifiedAt: nextVerifiedSession.verifiedAt,
      })
      console.info("[SIGNUP] verified_token_stored", {
        phone: maskPhoneForLog(nextVerifiedSession.phone),
        countryCode: nextVerifiedSession.countryCode,
        verificationId: nextVerifiedSession.verificationId,
        persisted: true,
      })
      setModalOpen(false)
    } catch (error: any) {
      setOtpState((current) => ({ ...current, status: "failed", message: error?.message || "Unable to reach verification service. Please retry." }))
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setTouched({
      name: true,
      email: true,
      phone: true,
      addressLine1: true,
      city: true,
      state: true,
      country: true,
      pinZip: true,
      password: true,
    })
    console.info("[SIGNUP] submit_clicked", {
      canCreate,
      hasErrors,
      verified,
      readiness: submitReadiness.reason,
      verificationTokenPresent: Boolean(verifiedSession?.verificationToken),
      verificationIdPresent: Boolean(verifiedSession?.verificationId),
      normalizedPhonePresent: Boolean(verifiedSession?.phone),
    })
    console.info("[SIGNUP] validation_result", {
      valid: !hasErrors,
      fields: Object.keys(errors),
    })
    if (!canCreate || !verifiedSession?.phone) {
      const message = !verified
        ? "Verify your WhatsApp number before creating an account."
        : hasErrors
          ? "Complete the highlighted fields before creating an account."
          : "Complete signup before creating an account."
      setState({ status: "error", message })
      return
    }

    setState({ status: "submitting" })
    try {
      console.info("[SIGNUP] payload", {
        namePresent: Boolean(values.name.trim()),
        emailDomain: emailDomain(values.email),
        phoneCountryCode: verifiedSession.countryCode,
        phonePresent: Boolean(verifiedSession.phone),
        verificationTokenPresent: Boolean(verifiedSession.verificationToken),
        verificationIdPresent: Boolean(verifiedSession.verificationId),
        verificationId: verifiedSession.verificationId,
        addressPresent: Boolean(values.addressLine1.trim()),
        cityPresent: Boolean(values.city.trim()),
        statePresent: Boolean(values.state.trim()),
        postalPresent: Boolean(values.pinZip.trim()),
      })
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          phone: verifiedSession.phone,
          countryCode: verifiedSession.countryCode,
          verificationToken: verifiedSession.verificationToken,
          verificationId: verifiedSession.verificationId,
          addressLine1: values.addressLine1,
          city: values.city,
          state: values.state,
          country: values.country || selectedAddressCountry.name,
          pinZip: values.pinZip,
          password: values.password,
          turnstileToken,
          referralCode: referralCode || undefined,
        }),
      })

      const data = await readJsonResponse<any>(response)
      console.info("[SIGNUP] register_response", {
        ok: response.ok,
        status: response.status,
        code: data?.code,
        success: Boolean(data?.success),
        redirectTo: data?.redirectTo,
      })
      if (!response.ok) {
        const message = data.error || "Could not create account."
        if (data?.code === "phone_verification_required" || /verify your whatsapp|verification/i.test(String(message))) {
          resetOtp()
        }
        setState({
          status: "error",
          field: message.toLowerCase().includes("email") ? "email" : undefined,
          message,
        })
        return
      }

      setState({ status: "success", message: data.message, customerId: data.customerId, redirectTo: safeClientReturnPath(nextTo) || data.redirectTo || "/client-area" })
    } catch (error: any) {
      console.error("[SIGNUP] submit_failed", { message: error?.message || "unknown" })
      setState({
        status: "error",
        message: "Connection error. Please try again.",
      })
    }
  }

  if (state.status === "success") {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="glass accent-glow relative flex h-12 w-12 items-center justify-center rounded-full text-accent">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold">Account created</h2>
        <p className="text-sm text-muted-foreground text-balance">
          {state.message || "Your account is ready. Redirecting..."}
        </p>
        <div className="mt-2 inline-flex items-center gap-2 text-sm text-cyan-300">
          <Spinner className="size-4" />
          Redirecting...
        </div>
      </div>
    )
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
        {state.status === "error" && !state.field && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.message}</span>
          </div>
        )}

        <FieldGroup>
          <Field data-invalid={shouldShow(touched.name, errors.name) || undefined}>
            <FieldLabel htmlFor="signup-name">Full name</FieldLabel>
            <Input id="signup-name" autoComplete="name" value={values.name} onChange={(e) => set("name", e.target.value)} onBlur={() => blur("name")} aria-invalid={shouldShow(touched.name, errors.name)} required />
          {shouldShow(touched.name, errors.name) && <FieldError>{errors.name}</FieldError>}
          </Field>

          <Field data-invalid={shouldShow(touched.email, errors.email) || (state.status === "error" && state.field === "email") || undefined}>
            <FieldLabel htmlFor="signup-email">Email</FieldLabel>
            <Input id="signup-email" type="email" autoComplete="email" placeholder="you@company.com" value={values.email} onChange={(e) => set("email", e.target.value)} onBlur={() => blur("email")} aria-invalid={shouldShow(touched.email, errors.email)} required />
            {shouldShow(touched.email, errors.email) && <FieldError>{errors.email}</FieldError>}
            {state.status === "error" && state.field === "email" && <FieldError>{state.message}</FieldError>}
            <FieldDescription>Email verification is a secondary security check; WhatsApp verification unlocks account creation.</FieldDescription>
          </Field>

          <Field data-invalid={showPhoneError || otpState.status === "failed" || otpState.status === "provider_unavailable" || undefined}>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor="signup-phone">Phone verification</FieldLabel>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2 sm:overflow-hidden">
              <SearchSelect
                id="signup-phone-country"
                value={values.phoneCountryCode}
                label={<CompactCountrySelectLabel countryCode={values.phoneCountryCode} />}
                placeholder="Search country"
                disabled={verified}
                options={countryOptions}
                onChange={(value) => selectPhoneCountry(value)}
                onBlur={blurPhone}
                triggerClassName="zws-phone-country-trigger h-11 w-full px-[10px] pr-[26px] sm:w-[108px] sm:min-w-[108px] sm:max-w-[108px] sm:shrink-0"
              />
              <Input
                id="signup-phone"
                className="zws-phone-input min-w-0 sm:min-w-[160px] sm:max-w-[220px] sm:flex-1"
                value={values.phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder={values.phoneCountryCode === "IN" ? "98765 43210" : "Phone number"}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                aria-invalid={showPhoneError}
                onBlur={blurPhone}
                disabled={verified}
              />
              <input type="hidden" name="verificationTokenPresent" value={verifiedSession?.verificationToken ? "true" : "false"} />
              <input type="hidden" name="verificationId" value={verifiedSession?.verificationId || ""} />
              {!verified ? (
                <Button type="button" className="h-11 w-full gap-2 px-3 sm:w-[92px] sm:min-w-[92px] sm:shrink-0" onClick={() => sendOtp(false)} disabled={otpState.status === "sending"}>
                  {otpState.status === "sending" ? <Spinner className="size-4" /> : <MessageCircle className="h-4 w-4" />}
                  {otpState.status === "sending" ? "Sending" : "Verify"}
                </Button>
              ) : null}
            </div>
            {verified ? (
              <div className="rounded-lg border border-emerald-400/35 bg-emerald-500/10 p-3 text-emerald-100 shadow-[0_0_28px_rgba(16,185,129,0.12)] transition-all duration-300">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-200 ring-1 ring-emerald-300/30">
                      <CheckCircle2 className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">WhatsApp Verified</div>
                      <div className="mt-0.5 truncate font-mono text-sm text-emerald-50" title={verifiedPhoneDisplay}>{lockedPhoneLabel || verifiedPhoneDisplay}</div>
                      <div className="mt-1 text-xs text-emerald-200/75">This number is secured for account creation.</div>
                    </div>
                  </div>
                  <button type="button" className="self-start rounded-md border border-emerald-300/25 px-2.5 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:border-emerald-200/50 hover:bg-emerald-300/10 sm:self-center" onClick={changeVerifiedNumber}>
                    Change Number
                  </button>
                </div>
              </div>
            ) : null}
            {!verified && otpState.status === "sent" && otpState.message ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                {otpState.message}
              </div>
            ) : null}
            {showPhoneError && <FieldError>{errors.phone}</FieldError>}
            {(otpState.status === "failed" || otpState.status === "provider_unavailable") && otpState.message ? <FieldError>{otpState.message}</FieldError> : null}
          </Field>

          <Field data-invalid={shouldShow(touched.addressLine1, errors.addressLine1) || undefined}>
            <FieldLabel htmlFor="signup-address-line-1">Address line 1</FieldLabel>
            <Input id="signup-address-line-1" autoComplete="street-address" value={values.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} onBlur={() => blur("addressLine1")} aria-invalid={shouldShow(touched.addressLine1, errors.addressLine1)} required />
            {shouldShow(touched.addressLine1, errors.addressLine1) && <FieldError>{errors.addressLine1}</FieldError>}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={shouldShow(touched.country, errors.country) || undefined}>
              <FieldLabel htmlFor="signup-country">Country</FieldLabel>
              <SearchSelect
                id="signup-country"
                value={values.addressCountryCode}
                label={countryLabel(values.addressCountryCode)}
                placeholder="Search country"
                options={countryTextOptions}
                onChange={(value) => selectAddressCountry(value)}
                onBlur={() => blur("country")}
              />
              {shouldShow(touched.country, errors.country) && <FieldError>{errors.country}</FieldError>}
            </Field>

            <Field data-invalid={shouldShow(touched.state, errors.state) || undefined}>
              <FieldLabel htmlFor="signup-state">State</FieldLabel>
              {states.length ? (
                <SearchSelect
                  id="signup-state"
                  value={values.addressStateCode}
                  label={values.state || "Select state"}
                  placeholder="Search state"
                  options={states.map((entry) => ({ value: entry.isoCode, label: entry.name, display: entry.name }))}
                  onChange={(value) => selectState(value)}
                  onBlur={() => blur("state")}
                />
              ) : (
                <Input id="signup-state" autoComplete="address-level1" value={values.state} onChange={(e) => set("state", e.target.value)} onBlur={() => blur("state")} required />
              )}
              {shouldShow(touched.state, errors.state) && <FieldError>{errors.state}</FieldError>}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={shouldShow(touched.city, errors.city) || undefined}>
              <FieldLabel htmlFor="signup-city">City</FieldLabel>
              {cities.length ? (
                <SearchSelect
                  id="signup-city"
                  value={values.city}
                  label={values.city || "Select city"}
                  placeholder="Search city"
                  options={cities.map((entry) => ({ value: entry.name, label: entry.name, display: entry.name }))}
                  onChange={(value) => {
                    set("city", value)
                    setTouched((current) => ({ ...current, city: true }))
                  }}
                  onBlur={() => blur("city")}
                />
              ) : (
                <Input id="signup-city" autoComplete="address-level2" value={values.city} onChange={(e) => set("city", e.target.value)} onBlur={() => blur("city")} required />
              )}
              {shouldShow(touched.city, errors.city) && <FieldError>{errors.city}</FieldError>}
            </Field>

            <Field data-invalid={shouldShow(touched.pinZip, errors.pinZip) || undefined}>
              <FieldLabel htmlFor="signup-pinzip">PIN / ZIP</FieldLabel>
              <Input id="signup-pinzip" autoComplete="postal-code" value={values.pinZip} onChange={(e) => set("pinZip", e.target.value)} onBlur={() => blur("pinZip")} aria-invalid={shouldShow(touched.pinZip, errors.pinZip)} required />
              {shouldShow(touched.pinZip, errors.pinZip) && <FieldError>{errors.pinZip}</FieldError>}
            </Field>
          </div>

          <Field data-invalid={shouldShow(touched.password, errors.password) || undefined}>
            <FieldLabel htmlFor="signup-password">Password</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input id="signup-password" type={showPassword ? "text" : "password"} autoComplete="new-password" value={values.password} onChange={(e) => set("password", e.target.value)} onBlur={() => blur("password")} aria-invalid={shouldShow(touched.password, errors.password)} className="pr-10" required />
                <button type="button" onClick={() => setShowPassword((current) => !current)} className="absolute inset-y-0 right-2 flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground" aria-label={showPassword ? "Hide password" : "Show password"} tabIndex={-1}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button type="button" variant="outline" className="gap-2" onClick={generatePassword}>Generate</Button>
              <Button type="button" variant="outline" size="icon" onClick={() => void copyPassword()} disabled={!values.password} aria-label="Copy password">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <PasswordStrengthMeter password={values.password} />
            <div className="grid gap-1.5 rounded-lg border border-border/40 bg-background/30 p-3 text-xs text-muted-foreground sm:grid-cols-2">
              {passwordRequirements.map((item) => (
                <span key={item.label} className={cn("flex items-center gap-1.5", item.met && "text-emerald-300")}>
                  <Check className="h-3.5 w-3.5" />
                  {item.label}
                </span>
              ))}
              <span className={cn("flex items-center gap-1.5", passwordStrength.score >= 3 && "text-emerald-300")}>
                <Check className="h-3.5 w-3.5" />
                Strength: {passwordStrength.label}
              </span>
            </div>
            {shouldShow(touched.password, errors.password) && <FieldError>{errors.password}</FieldError>}
          </Field>
        </FieldGroup>

        <TurnstileWidget value={turnstileToken} onChange={setTurnstileToken} action="register" surface="signup" siteKey={turnstile.siteKey} />

        <Button type="submit" className="h-11 w-full gap-1.5" disabled={!canCreate}>
          {state.status === "submitting" ? <><Spinner className="size-4" />Launching Workspace...</> : <>Launch Workspace<ArrowRight className="h-4 w-4" /></>}
        </Button>
        {!canCreate ? (
          <FieldDescription className="text-center">
            {!verified ? "Verify your WhatsApp number to create an account." : hasErrors ? "Complete the highlighted fields to create an account." : "Account creation is almost ready."}
          </FieldDescription>
        ) : null}

        <FieldDescription className="text-center">
          Already have an account? <Link href="/login" className="text-accent hover:underline">Log in</Link>
        </FieldDescription>
      </form>

      <Dialog open={!verified && modalOpen} onOpenChange={(next) => {
        if (!verified) setModalOpen(next)
      }}>
        <DialogContent className="max-w-sm border-[rgba(255,255,255,0.08)] bg-[rgba(15,23,42,0.94)] text-white">
          <DialogHeader className="items-center text-center">
            <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-cyan-500/10 text-cyan-300">
              <MessageCircle className="h-5 w-5" />
            </div>
            <DialogTitle>Verify your phone number</DialogTitle>
            <DialogDescription className="text-[rgba(255,255,255,0.68)]">Enter the 6-digit code sent to your WhatsApp.</DialogDescription>
          </DialogHeader>

          <InputOTP
            maxLength={6}
            value={otp}
            onChange={(value) => setOtp(value.replace(/\D/g, ""))}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            containerClassName="justify-center"
          >
            <InputOTPGroup className="gap-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-12 w-10 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(15,23,42,0.88)] text-lg font-semibold text-white data-[active=true]:border-[#00D4FF] sm:w-11" />
              ))}
            </InputOTPGroup>
          </InputOTP>

          {otpState.message ? (
            <div className={`rounded-lg border p-3 text-sm ${otpState.status === "failed" || otpState.status === "provider_unavailable" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
              {otpState.message}
            </div>
          ) : null}

          <Button type="button" className="h-11 w-full gap-2" onClick={verifyOtp} disabled={otp.length !== 6 || otpState.status === "verifying"}>
            {otpState.status === "verifying" ? <Spinner className="size-4" /> : <ShieldCheck className="h-4 w-4" />}
            {otpState.status === "verifying" ? "Verifying..." : "Verify code"}
          </Button>
          <div className="flex items-center justify-between gap-3 text-sm">
            <button type="button" className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" onClick={() => sendOtp(true)} disabled={countdown > 0 || otpState.status === "sending"}>
              <RefreshCw className="h-4 w-4" />
              {countdown > 0 ? `Resend in ${countdown}s` : otpState.status === "sending" ? "Sending" : "Resend code"}
            </button>
            <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setModalOpen(false)}>Close</button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CompactCountrySelectLabel({ countryCode }: { countryCode: string }) {
  const country = countryByCode(countryCode)
  const Flag = FLAG_COMPONENTS[country.isoCode]
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-hover)] text-[13px] leading-none [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:rounded-full [&_svg]:object-cover [&_svg]:filter-none">
        {Flag ? <Flag title={country.name} /> : <span>{flag(country.isoCode)}</span>}
      </span>
      <span className="shrink-0 text-[var(--text-primary)]">{normalizeDialCode(country.phonecode)}</span>
    </span>
  )
}

function CountrySelectLabel({ countryCode }: { countryCode: string }) {
  const country = countryByCode(countryCode)
  const Flag = FLAG_COMPONENTS[country.isoCode]
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-hover)] text-[13px] leading-none [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:rounded-full [&_svg]:object-cover [&_svg]:filter-none">
        {Flag ? <Flag title={country.name} /> : <span>{flag(country.isoCode)}</span>}
      </span>
      <span className="truncate text-[var(--text-primary)]">{country.name}</span>
      <span className="shrink-0 text-[var(--text-muted)]">({normalizeDialCode(country.phonecode)})</span>
    </span>
  )
}

function SearchSelect({
  id,
  value,
  label,
  placeholder,
  options,
  onChange,
  onBlur,
  disabled,
  triggerClassName,
}: {
  id: string
  value: string
  label: React.ReactNode
  placeholder: string
  options: Array<{ value: string; label: string; display: React.ReactNode; name?: string; isoCode?: string; dialCode?: string }>
  onChange: (value: string) => void
  onBlur?: () => void
  disabled?: boolean
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const filteredOptions = useMemo(() => filterSearchOptions(options, query), [options, query])
  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) setQuery("")
      if (!next) onBlur?.()
    }}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={`${id}-trigger`}
          className={cn("h-9 w-full justify-between overflow-hidden px-3 font-normal", triggerClassName)}
        >
          <span className="min-w-0 truncate text-left">{label}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="z-[60] w-[min(22rem,calc(100vw-1rem))] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:font-medium">
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[min(18rem,calc(100dvh-10rem))] overscroll-contain">
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className="min-h-10 touch-pan-y"
                >
                  <Check className={cn("h-4 w-4 text-[var(--text-selected-secondary)]", value === option.value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{option.display}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function shouldShow(touched: boolean | undefined, error: string | undefined) {
  return Boolean(touched && error)
}

function normalizeE164(phone: string, countryCode: string) {
  try {
    return normalizeStrictPhoneNumber(phone, countryCode).e164
  } catch {
    return ""
  }
}

function matchStateCode(countryCode: string, stateName: string) {
  const wanted = String(stateName || "").trim().toLowerCase()
  if (!wanted) return ""
  return State.getStatesOfCountry(countryCode).find((entry) => entry.name.toLowerCase() === wanted || entry.isoCode.toLowerCase() === wanted)?.isoCode || ""
}

function filterSearchOptions<T extends { value: string; label: string; name?: string; isoCode?: string; dialCode?: string }>(options: T[], query: string): T[] {
  if (options.every((option) => option.name && option.isoCode && option.dialCode)) {
    return filterCountrySearchOptions(options.map((option) => ({
      ...option,
      name: option.name || "",
      isoCode: option.isoCode || option.value,
      dialCode: option.dialCode || "",
    })), query)
  }

  const normalizedQuery = String(query || "").trim().toLowerCase()
  if (!normalizedQuery) return options
  return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
}

function browserLocaleCountry() {
  if (typeof navigator === "undefined") return ""
  const locales = [navigator.language, ...(navigator.languages || [])]
  for (const locale of locales) {
    const country = String(locale || "").split("-")[1]?.toUpperCase()
    if (country && COUNTRIES.some((entry) => entry.isoCode === country)) return country
  }
  return ""
}

function browserTimezone() {
  if (typeof Intl === "undefined") return ""
  return Intl.DateTimeFormat().resolvedOptions().timeZone || ""
}

function indiaAddressFallback(state: string, city: string) {
  if (state || city) return null
  return { country: "India", state: "Odisha", stateCode: "OR", city: "Kaptipada" }
}

function formatNationalPreview(phone: string) {
  return parsePhoneNumberFromString(phone)?.formatNational() || phone
}

function nationalDigits(phone: string, countryCode: string) {
  const digits = sanitizePhoneInput(phone).replace(/\D/g, "")
  const dialCode = normalizeDialCode(countryByCode(countryCode).phonecode).replace(/\D/g, "")
  return dialCode && digits.startsWith(dialCode) ? digits.slice(dialCode.length) : digits
}

function isCompletedPhone(phone: string, countryCode: string) {
  const expected = EXPECTED_NATIONAL_LENGTH[countryCode.toUpperCase()]
  const digits = nationalDigits(phone, countryCode)
  return expected ? digits.length >= expected : digits.length >= 8
}

function validatePhone(phone: string, countryCode: string, e164Phone: string, phoneRejected = false, force = false) {
  if (phoneRejected) return PHONE_VALIDATION_MESSAGE
  if (!phone) return force ? "Phone number is required." : undefined
  if (!force && !isCompletedPhone(phone, countryCode)) return undefined
  if (!e164Phone) return PHONE_VALIDATION_MESSAGE
  return undefined
}

function otpPayloadMessage(payload?: unknown) {
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message.trim()
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim()
  return ""
}

function providerUnavailable(payload?: unknown) {
  if (!payload || typeof payload !== "object") return false
  const code = String((payload as { code?: unknown }).code || "")
  const stage = String((payload as { stage?: unknown }).stage || "")
  const message = otpPayloadMessage(payload)
  return /number_not_registered|invalid_recipient|invalid_jid|provider_unavailable|delivery_unavailable/i.test(`${code} ${stage} ${message}`)
}

function otpErrorMessage(status: number, payload?: unknown) {
  if (providerUnavailable(payload)) return PROVIDER_UNAVAILABLE_MESSAGE
  const fallback = otpPayloadMessage(payload)
  if (status === 429) return "Too many attempts. Try again later."
  if (status === 400) return fallback || "Invalid code."
  if (status === 410) return "Code expired. Please request a new code."
  return fallback || "Unable to verify verification code."
}

function safeSendOtpMessage(status: number, payload?: unknown) {
  if (providerUnavailable(payload)) return PROVIDER_UNAVAILABLE_MESSAGE
  const fallback = otpPayloadMessage(payload)
  if (status === 429) {
    return /wait/i.test(String(fallback || ""))
      ? "Please wait before requesting another code."
      : "Too many attempts. Try again later."
  }
  if (status === 400) return fallback || "Enter a valid WhatsApp phone number."
  return fallback || "Unable to send verification code."
}

function validate(v: Values, e164Phone: string, phoneRejected = false, forcePhone = false): Partial<Record<keyof Values, string>> {
  const errors: Partial<Record<keyof Values, string>> = {}
  if (v.name.trim().length < 2) errors.name = "Enter your full name."
  if (!v.email) errors.email = "Email is required."
  else if (!isValidEmail(v.email)) errors.email = "Enter a valid email address."
  const phoneError = validatePhone(v.phone, v.phoneCountryCode, e164Phone, phoneRejected, forcePhone)
  if (phoneError) errors.phone = phoneError
  if (v.addressLine1.trim().length < 6) errors.addressLine1 = "Enter a complete street address."
  if (v.city.trim().length < 2) errors.city = "City is required."
  if (v.state.trim().length < 2) errors.state = "State is required."
  if (v.country.trim().length < 2) errors.country = "Country is required."
  if (v.pinZip.trim().length < 4) errors.pinZip = "PIN or ZIP is required."
  if (!v.password) errors.password = "Password is required."
  else if (scorePassword(v.password).score < 2) errors.password = "Use at least 8 characters with a mix of letters and numbers."
  return errors
}

function passwordRequirementRows(password: string) {
  return [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Uppercase letter", met: /[A-Z]/.test(password) },
    { label: "Lowercase letter", met: /[a-z]/.test(password) },
    { label: "Number", met: /[0-9]/.test(password) },
    { label: "Symbol", met: /[^A-Za-z0-9]/.test(password) },
  ]
}
