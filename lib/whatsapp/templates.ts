import { prisma } from "@/lib/db"
import { configuredSiteDomain, publicOrigin } from "@/lib/public-url"
import { getBrandSettings } from "@/lib/settings"
import { getRedisClient } from "@/lib/redis"
import { maskWhatsAppPhone, redactWhatsAppPayload, writeWhatsAppLog } from "@/lib/whatsapp/diagnostics"
import {
  canonicalWhatsAppTemplateKey,
  LEGACY_WHATSAPP_TEMPLATE_KEY_ALIASES,
  REQUIRED_WHATSAPP_TEMPLATE_KEYS,
  WHATSAPP_TEMPLATE_KEYS,
} from "@/lib/whatsapp/template-registry"

export type WhatsAppTemplateVariables = Record<string, unknown>
export type WhatsAppTemplateCategory =
  | "authentication"
  | "utility"
  | "marketing"
  | "support"
  | "onboarding"
  | "billing"
  | "security"
  | "provisioning"

export type WhatsAppHeaderType = "none" | "text" | "image" | "video" | "document"
export type WhatsAppTemplateStatus = "draft" | "pending_review" | "approved" | "rejected" | "paused" | "archived"
export type WhatsAppButtonType = "quick_reply" | "url" | "call" | "copy_code"

export type WhatsAppTemplateButton = {
  id?: string
  type: WhatsAppButtonType
  label: string
  value?: string
}

export type WhatsAppTemplateDraft = {
  name: string
  slug?: string
  key?: string
  category: string
  language?: string
  status?: string
  headerType?: string
  headerText?: string | null
  body: string
  footer?: string | null
  buttons?: WhatsAppTemplateButton[]
  mediaUrl?: string | null
  templateVariables?: string[]
  isSystem?: boolean
  isActive?: boolean
}

export type WhatsAppRenderedTemplate = {
  header: string | null
  body: string
  footer: string | null
  buttons: WhatsAppTemplateButton[]
  mediaUrl: string | null
  message: string
  variables: string[]
  language: string
  category: WhatsAppTemplateCategory
}

export type WhatsAppResolvedRenderedTemplate = WhatsAppRenderedTemplate & {
  templateId: string
  templateKey: string
  requestedTemplateKey: string
  canonicalTemplateKey: string
  templateName: string
  templateVersionId: string | null
  templateVersion: number | null
  cacheHit: boolean
  fallbackReason: string | null
  fallbackLanguage: string | null
  renderDurationMs: number
}

export type WhatsAppTemplateValidationIssue = {
  level: "error" | "warning"
  code: string
  message: string
}

const SUPPORTED_CATEGORIES = new Set<WhatsAppTemplateCategory>([
  "authentication",
  "utility",
  "marketing",
  "support",
  "onboarding",
  "billing",
  "security",
  "provisioning",
])

const SUPPORTED_LANGUAGES = new Set(["en", "hi", "bn", "ar", "es"])
const SUPPORTED_STATUSES = new Set<WhatsAppTemplateStatus>(["draft", "pending_review", "approved", "rejected", "paused", "archived"])
const HEADER_TYPES = new Set<WhatsAppHeaderType>(["none", "text", "image", "video", "document"])
const PROMOTIONAL_PATTERN = /\b(discount|sale|offer|deal|promo|promotion|coupon|cashback|free|limited time|buy now|upgrade now|save|exclusive)\b/i
const SEPARATOR = "━━━━━━━━━━━━━━━"
const TEMPLATE_CACHE_TTL_SECONDS = 300
const TEMPLATE_CACHE_PREFIX = "whatsapp:template:"
const TEMPLATE_CACHE_VERSION_KEY = "whatsapp:template:cache_version"
let localTemplateCacheVersion = `boot:${Date.now()}`
const inMemoryTemplateCache = new Map<string, { expiresAt: number; value: CachedTemplate }>()

const sampleOrigin = () => publicOrigin() || "https://example.com"
const sampleDomain = () => configuredSiteDomain() || "example.com"
const sampleSupportEmail = () => `support@${sampleDomain()}`

type CachedTemplate = {
  templateId: string
  templateKey: string
  templateName: string
  templateVersionId: string | null
  templateVersion: number | null
  requestedLanguage: string
  resolvedLanguage: string
  fallbackLanguage: string | null
  draft: WhatsAppTemplateDraft
}

export const WHATSAPP_TEMPLATE_VARIABLES = [
  ["customer", "username", "Username", "asha_cloud", false, "none"],
  ["customer", "customer_name", "Customer name", "Asha Sharma", false, "none"],
  ["customer", "first_name", "First name", "Asha", false, "none"],
  ["customer", "last_name", "Last name", "Sharma", false, "none"],
  ["customer", "email", "Email", "asha@example.com", false, "email"],
  ["customer", "phone", "Phone", "+919876543210", true, "phone"],
  ["customer", "masked_phone", "Masked phone", "91******10", false, "none"],
  ["customer", "customer_id", "Customer ID", "CUS-1024", false, "none"],
  ["location", "ip", "IP address", "103.48.12.9", false, "none"],
  ["location", "country", "Country", "India", false, "none"],
  ["location", "city", "City", "Mumbai", false, "none"],
  ["location", "region", "Region", "Maharashtra", false, "none"],
  ["location", "timezone", "Timezone", "Asia/Kolkata", false, "none"],
  ["device", "browser", "Browser", "Chrome", false, "none"],
  ["device", "device", "Device", "Desktop", false, "none"],
  ["device", "platform", "Platform", "Web", false, "none"],
  ["device", "os", "Operating system", "Windows", false, "none"],
  ["order", "invoice_id", "Invoice ID", "INV-2026-0412", false, "none"],
  ["order", "invoice_total", "Invoice total", "2499.00", false, "none"],
  ["order", "invoice_due", "Invoice due date", "12 May 2026", false, "none"],
  ["order", "order_id", "Order ID", "ORD-8921", false, "none"],
  ["support", "ticket_id", "Ticket ID", "TKT-2048", false, "none"],
  ["order", "service_name", "Service name", "Mumbai VPS Pro", false, "none"],
  ["order", "service_plan", "Service plan", "4 vCPU / 8 GB RAM", false, "none"],
  ["order", "billing_cycle", "Billing cycle", "Monthly", false, "none"],
  ["server", "vm_name", "VM name", "zws-mum-1024", false, "none"],
  ["server", "server_name", "Server name", "zws-mum-1024", false, "none"],
  ["server", "hostname", "Hostname", `vps-1024.${sampleDomain()}`, false, "none"],
  ["server", "server_ip", "Server IP", "203.0.113.10", false, "none"],
  ["server", "ip_address", "IP address", "203.0.113.10", false, "none"],
  ["server", "rdp_ip", "RDP IP", "203.0.113.10", false, "none"],
  ["server", "rdp_username", "RDP username", "Administrator", false, "none"],
  ["server", "rdp_password", "RDP password", "SecurePass#123", true, "secret"],
  ["server", "os_template", "OS template", "Windows Server 2022", false, "none"],
  ["payment", "gateway_name", "Gateway name", "Cashfree", false, "none"],
  ["payment", "payment_amount", "Payment amount", "2499.00", false, "none"],
  ["payment", "payment_link", "Payment link", `${sampleOrigin()}/pay/INV-2026-0412`, false, "url"],
  ["payment", "payment_status", "Payment status", "Paid", false, "none"],
  ["payment", "transaction_id", "Transaction ID", "TXN-88F2", false, "none"],
  ["provisioning", "deployment_stage", "Deployment stage", "Configuring server settings", false, "none"],
  ["security", "otp_code", "OTP code", "829201", true, "otp"],
  ["security", "login_time", "Login time", "09 May 2026, 18:40", false, "none"],
  ["security", "login_location", "Login location", "Mumbai, India", false, "none"],
  ["security", "login_ip", "Login IP", "103.48.12.9", false, "none"],
  ["security", "reset_link", "Reset link", `${sampleOrigin()}/reset/secure-token`, true, "url"],
  ["campaign", "offer_name", "Offer name", "Cloud Launch Week", false, "none"],
  ["campaign", "discount", "Discount", "20%", false, "none"],
  ["campaign", "coupon_code", "Coupon code", "CLOUD20", false, "none"],
  ["campaign", "expiry_date", "Expiry date", "31 May 2026", false, "none"],
  ["campaign", "campaign_message", "Campaign message", "Your cloud offer is ready.", false, "none"],
  ["system", "message_text", "Message text", "Your {{company_name}} update is ready.", false, "none"],
  ["system", "fallback_reason", "Fallback reason", "Template unavailable", false, "none"],
  ["system", "company_name", "Company name", "Cloud", false, "none"],
  ["system", "support_email", "Support email", sampleSupportEmail(), false, "email"],
  ["system", "support_phone", "Support phone", "+911234567890", false, "phone"],
  ["system", "website_url", "Website URL", sampleOrigin(), false, "url"],
  ["system", "dashboard_url", "Dashboard URL", `${sampleOrigin()}/client-area`, false, "url"],
  ["system", "greeting", "Smart greeting", "Good evening", false, "none"],
] as const

export const WHATSAPP_TEMPLATE_VARIABLE_KEYS: string[] = WHATSAPP_TEMPLATE_VARIABLES.map((entry) => entry[1])
type VariableMeta = {
  group: string
  key: string
  label: string
  sampleValue: string
  sensitive: boolean
  maskingPolicy: string
}

const VARIABLE_META = new Map<string, VariableMeta>(WHATSAPP_TEMPLATE_VARIABLES.map((entry) => [entry[1], {
  group: entry[0],
  key: entry[1],
  label: entry[2],
  sampleValue: entry[3],
  sensitive: entry[4],
  maskingPolicy: entry[5],
} as VariableMeta]))

export const LEGACY_WHATSAPP_TEMPLATE_KEYS = [
  ...Object.keys(LEGACY_WHATSAPP_TEMPLATE_KEY_ALIASES),
] as const

export const DEFAULT_WHATSAPP_TEMPLATES: WhatsAppTemplateDraft[] = [
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
    name: "Login OTP",
    category: "authentication",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🛡 *Login Verification*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour login verification code:\n\n*{{otp_code}}*\n\n🌐 IP: {{ip}}\n📍 {{city}}, {{country}}\n\nValid for 5 minutes.\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    footer: "Secure login verification",
    templateVariables: ["first_name", "otp_code", "ip", "city", "country"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_SIGNUP_OTP,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_SIGNUP_OTP,
    name: "Signup OTP",
    category: "authentication",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🔐 *{{company_name}} Verification*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour verification code is:\n\n*{{otp_code}}*\n\n⏳ Valid for 5 minutes\n\n📱 Number:\n{{phone}}\n\n⚠ Never share this code with anyone.\n\n${SEPARATOR}\n{{company_name}}\nSecure Authentication\n${SEPARATOR}`,
    footer: "Verification code",
    templateVariables: ["first_name", "otp_code", "phone"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_PASSWORD_RESET,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_PASSWORD_RESET,
    name: "Password reset OTP",
    category: "authentication",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🔑 *{{company_name}} PASSWORD RESET*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour password reset code is:\n\n*{{otp_code}}*\n\n⏳ Expires in: 5 minutes\n\nIf you did not request this reset,\nplease secure your account immediately.\n\n${SEPARATOR}\n{{company_name}} Security\n${SEPARATOR}`,
    footer: "Do not share this code",
    templateVariables: ["first_name", "otp_code", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_DEVICE_VERIFY,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_DEVICE_VERIFY,
    name: "Device verification OTP",
    category: "authentication",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🛡 *{{company_name}} DEVICE VERIFICATION*\n${SEPARATOR}\n\nHello {{first_name}},\n\nUse this code to verify your device:\n\n*{{otp_code}}*\n\n💻 Device:\n{{browser}} on {{os}}\n\n📍 Location:\n{{city}}, {{country}}\n\n⏳ Expires in: 5 minutes\n\nNever share this code with anyone.\n\n${SEPARATOR}\n{{company_name}} Security\n${SEPARATOR}`,
    footer: "Do not share this code",
    templateVariables: ["first_name", "otp_code", "browser", "os", "city", "country"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_SUCCESS,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_SUCCESS,
    name: "Login successful",
    category: "security",
    language: "en",
    status: "approved",
    body: `LOGIN SUCCESSFUL\n\nHello {{first_name}},\n\nA successful login was detected.\n\n📍 Location:\n{{city}}, {{country}}\n\n💻 Device:\n{{browser}} on {{os}}\n\n🕒 Time:\n{{login_time}}\n\nIf this was not you,\nreset your password immediately.\n\n{{company_name}} Security`,
    templateVariables: ["first_name", "city", "country", "browser", "os", "login_time", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_FAILED_LOGIN,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_FAILED_LOGIN,
    name: "Failed login alert",
    category: "security",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n⚠ *SECURITY ALERT*\n${SEPARATOR}\n\nMultiple failed login attempts were detected.\n\n🌐 IP:\n{{ip}}\n\n📍 Location:\n{{city}}, {{country}}\n\n💻 Device:\n{{browser}} on {{os}}\n\nIf this activity was not yours,\nchange your password immediately.\n\n${SEPARATOR}\n{{company_name}} Security\n${SEPARATOR}`,
    templateVariables: ["ip", "city", "country", "browser", "os"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.AUTH_NEW_DEVICE,
    slug: WHATSAPP_TEMPLATE_KEYS.AUTH_NEW_DEVICE,
    name: "New device alert",
    category: "security",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🛡 *NEW DEVICE DETECTED*\n${SEPARATOR}\n\nHello {{first_name}},\n\nA new device is trying to access your account.\n\n🌐 IP Address:\n{{ip}}\n\n📍 Location:\n{{city}}, {{country}}\n\n💻 Device:\n{{browser}} on {{os}}\n\nIf this was not you,\nreset your password immediately.\n\n${SEPARATOR}\n{{company_name}} Security\n${SEPARATOR}`,
    templateVariables: ["first_name", "ip", "city", "country", "browser", "os"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.LOGIN_ALERT,
    slug: WHATSAPP_TEMPLATE_KEYS.LOGIN_ALERT,
    name: "Login alert",
    category: "security",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🛡 *LOGIN DETECTED*\n${SEPARATOR}\n\nHello {{first_name}},\n\nA login was detected on your account.\n\n🌐 IP: {{ip}}\n📍 Location: {{city}}, {{country}}\n💻 Device: {{browser}}\n🕒 Time: {{login_time}}\n\nIf this was not you, reset your password immediately.\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    buttons: [{ type: "url", label: "Review Account", value: "{{dashboard_url}}" }],
    templateVariables: ["first_name", "ip", "city", "country", "browser", "login_time", "company_name", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SECURITY_ALERT,
    slug: WHATSAPP_TEMPLATE_KEYS.SECURITY_ALERT,
    name: "Security alert",
    category: "security",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🛡 *SECURITY ALERT*\n${SEPARATOR}\n\nHello {{first_name}},\n\nWe detected a security event on your account.\n\nEvent: {{message_text}}\nIP: {{ip}}\nTime: {{login_time}}\n\nIf this was not you, reset your password immediately.\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    buttons: [{ type: "url", label: "Review Account", value: "{{dashboard_url}}" }],
    templateVariables: ["first_name", "message_text", "ip", "login_time", "company_name", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.BACKUP_COMPLETED,
    slug: WHATSAPP_TEMPLATE_KEYS.BACKUP_COMPLETED,
    name: "Backup completed",
    category: "utility",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n☁️ *{{company_name}} BACKUP*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour backup has been completed successfully.\n\n🖥 Server: {{server_name}}\n💾 Size: {{backup_size}}\n🗂 Storage: {{storage}}\n🕒 Completed: {{completed_at}}\n\n📦 Backup: {{backup_name}}\n\nView backups: {{dashboard_url}}\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    footer: "Secure server backup",
    templateVariables: ["first_name", "server_name", "backup_size", "storage", "completed_at", "backup_name", "dashboard_url", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.BACKUP_FAILED,
    slug: WHATSAPP_TEMPLATE_KEYS.BACKUP_FAILED,
    name: "Backup failed",
    category: "utility",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n⚠️ *{{company_name}} BACKUP*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour backup could not be completed.\n\n🖥 Server: {{server_name}}\nReason: {{failure_reason}}\n\nYou can retry it from the client area.\n\nView backups: {{dashboard_url}}\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    footer: "Action may be required",
    templateVariables: ["first_name", "server_name", "failure_reason", "dashboard_url", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
    slug: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
    name: "Modern fallback",
    category: "utility",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n☁️ *{{company_name}} Update*\n${SEPARATOR}\n\nHello {{first_name}},\n\n{{message_text}}\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    footer: "Secure account update",
    templateVariables: ["first_name", "message_text", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.ADMIN_TEST,
    slug: WHATSAPP_TEMPLATE_KEYS.ADMIN_TEST,
    name: "Admin test message",
    category: "utility",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n🧪 *WHATSAPP TEST*\n${SEPARATOR}\n\nHello {{first_name}},\n\nYour WhatsApp integration is working successfully.\n\n✅ Session Connected\n✅ Queue Operational\n✅ Delivery Tracking Active\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    footer: "WhatsApp delivery test",
    templateVariables: ["first_name", "company_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.CAMPAIGN_CUSTOM,
    slug: WHATSAPP_TEMPLATE_KEYS.CAMPAIGN_CUSTOM,
    name: "Campaign custom",
    category: "marketing",
    language: "en",
    status: "approved",
    body: `${SEPARATOR}\n☁️ *{{offer_name}}*\n${SEPARATOR}\n\nHello {{first_name}},\n\n{{campaign_message}}\n\nReply STOP to opt out of marketing messages.\n\n${SEPARATOR}\n{{company_name}}\n${SEPARATOR}`,
    buttons: [{ type: "url", label: "View Offer", value: "{{website_url}}" }],
    templateVariables: ["offer_name", "first_name", "campaign_message", "company_name", "website_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.INVOICE_READY,
    slug: WHATSAPP_TEMPLATE_KEYS.INVOICE_READY,
    name: "Invoice ready",
    category: "billing",
    language: "en",
    status: "approved",
    headerType: "document",
    body: `${SEPARATOR}\n🧾 *INVOICE READY*\n${SEPARATOR}\n\nHi {{first_name}},\n\nInvoice *#{{invoice_id}}* has been generated successfully.\n\n💰 Amount: {{invoice_total}}\n📅 Due Date: {{invoice_due}}\n💳 Gateway: {{gateway_name}}\n\n🧾 Invoice:\n{{payment_link}}\n\nUse the button below to complete payment securely.`,
    footer: "Secure billing update",
    buttons: [{ type: "url", label: "Pay Invoice", value: "{{payment_link}}" }],
    templateVariables: ["first_name", "invoice_id", "invoice_total", "invoice_due", "gateway_name", "company_name", "payment_link"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.INVOICE_REMINDER,
    slug: WHATSAPP_TEMPLATE_KEYS.INVOICE_REMINDER,
    name: "Invoice reminder",
    category: "billing",
    language: "en",
    status: "approved",
    body: "Hi {{first_name}}, invoice *#{{invoice_id}}* for {{invoice_total}} is due on {{invoice_due}}.\n\n🧾 Invoice:\n{{payment_link}}\n\nYou can complete payment securely using the button below to keep {{service_name}} active.",
    buttons: [{ type: "url", label: "Pay Invoice", value: "{{payment_link}}" }],
    templateVariables: ["first_name", "invoice_id", "invoice_total", "invoice_due", "service_name", "payment_link"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.PAYMENT_SUCCESS,
    slug: WHATSAPP_TEMPLATE_KEYS.PAYMENT_SUCCESS,
    name: "Payment success",
    category: "billing",
    language: "en",
    status: "approved",
    body: "✅ *Payment Received*\n\nHello {{customer_name}},\n\nYour payment for order {{order_id}} has been received successfully.\n\nYour cloud server deployment has started.\n\nMY RDP HUB",
    buttons: [{ type: "url", label: "Open Dashboard", value: "{{dashboard_url}}" }],
    templateVariables: ["customer_name", "order_id", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.PAYMENT_FAILED,
    slug: WHATSAPP_TEMPLATE_KEYS.PAYMENT_FAILED,
    name: "Payment failed",
    category: "billing",
    language: "en",
    status: "approved",
    body: "⚠️ *Payment not completed*\n\nHi {{first_name}}, payment for invoice *#{{invoice_id}}* did not complete.\n\nAmount: {{payment_amount}}\nStatus: {{payment_status}}\n\n🧾 Invoice:\n{{payment_link}}\n\nYou can try again securely below.",
    buttons: [{ type: "url", label: "Retry Payment", value: "{{payment_link}}" }],
    templateVariables: ["first_name", "invoice_id", "payment_amount", "payment_status", "payment_link"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.VPS_DEPLOYED,
    slug: WHATSAPP_TEMPLATE_KEYS.VPS_DEPLOYED,
    name: "VPS deployed",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "🎉 *VPS Ready*\n\nHello {{customer_name}},\n\nYour cloud server is now active and ready to use.\n\nServer:\n{{server_name}}\n\nIP:\n{{ip_address}}\n\nOpen Dashboard:\n{{dashboard_url}}\n\nMY RDP HUB",
    buttons: [{ type: "url", label: "Open Dashboard", value: "{{dashboard_url}}" }],
    templateVariables: ["customer_name", "server_name", "ip_address", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_STARTED,
    slug: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_STARTED,
    name: "VPS reinstall started",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "🔄 *Reinstall started*\n\nHello {{customer_name}},\n\nWe've started reinstalling your server *{{server_name}}*. The current disk will be wiped and a fresh OS installed — this usually takes a few minutes.\n\nWe'll message you as soon as it's ready.\n\nMY RDP HUB",
    templateVariables: ["customer_name", "server_name"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_COMPLETED,
    slug: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_COMPLETED,
    name: "VPS reinstall completed",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "✅ *Reinstall complete*\n\nHello {{customer_name}},\n\nYour server has been reinstalled and is active again.\n\nServer:\n{{server_name}}\n\nIP:\n{{ip_address}}\n\nOpen Dashboard:\n{{dashboard_url}}\n\nMY RDP HUB",
    buttons: [{ type: "url", label: "Open Dashboard", value: "{{dashboard_url}}" }],
    templateVariables: ["customer_name", "server_name", "ip_address", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.RDP_DELIVERED,
    slug: WHATSAPP_TEMPLATE_KEYS.RDP_DELIVERED,
    name: "RDP delivered",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "🖥️ *RDP access ready*\n\nHi {{first_name}}, your Windows RDP service is ready.\n\nIP: {{rdp_ip}}\nUsername: {{rdp_username}}\nPassword: {{rdp_password}}\nOS: {{os_template}}\n\nPlease change the password after first login.",
    templateVariables: ["first_name", "rdp_ip", "rdp_username", "rdp_password", "os_template"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
    slug: WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
    name: "Provisioning update",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "🚀 *Deployment In Progress*\n\nHello {{customer_name}},\n\nWe are preparing your cloud server:\n{{server_name}}\n\nCurrent stage:\n{{deployment_stage}}\n\nYou will receive another update once your VPS is ready.\n\nMY RDP HUB",
    templateVariables: ["customer_name", "server_name", "deployment_stage"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SERVICE_OPERATION_FAILED,
    slug: WHATSAPP_TEMPLATE_KEYS.SERVICE_OPERATION_FAILED,
    name: "Service operation failed",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "⚠️ *Action Needed*\n\nHello {{customer_name}},\n\nWe hit an issue while performing:\n{{operation}}\n\nOn server:\n{{server_name}}\n\nDetails:\n{{reason}}\n\nOur team has been notified and is looking into it. Your service has not been suspended.\n\nMY RDP HUB",
    templateVariables: ["customer_name", "server_name", "operation", "reason"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.ADDITIONAL_IP_ACTIVATED,
    slug: WHATSAPP_TEMPLATE_KEYS.ADDITIONAL_IP_ACTIVATED,
    name: "Additional IP activated",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "🌐 *Additional IP Activated*\n\nVM:\n{{server_name}}\n\nNew IP:\n{{ip_address}}\n\nMonthly Cost:\n{{monthly_cost}}\n\nRenewal:\n{{renewal_date}}\n\nStatus:\n{{status}}",
    templateVariables: ["server_name", "ip_address", "monthly_cost", "renewal_date", "status"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.BANDWIDTH_ADDON_ACTIVATED,
    slug: WHATSAPP_TEMPLATE_KEYS.BANDWIDTH_ADDON_ACTIVATED,
    name: "Bandwidth addon activated",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "📊 *Bandwidth Upgrade Activated*\n\nVM:\n{{server_name}}\n\nPlan:\n{{plan}}\n\nCost:\n{{monthly_cost}}\n\nStatus:\n{{status}}",
    templateVariables: ["server_name", "plan", "monthly_cost", "status"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SNAPSHOT_ADDON_ACTIVATED,
    slug: WHATSAPP_TEMPLATE_KEYS.SNAPSHOT_ADDON_ACTIVATED,
    name: "Snapshot addon activated",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "📸 *Snapshot Addon Activated*\n\nVM:\n{{server_name}}\n\nSlots:\n{{slots}}\n\nStatus:\n{{status}}",
    templateVariables: ["server_name", "slots", "status"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.BACKUP_ADDON_ACTIVATED,
    slug: WHATSAPP_TEMPLATE_KEYS.BACKUP_ADDON_ACTIVATED,
    name: "Backup addon activated",
    category: "provisioning",
    language: "en",
    status: "approved",
    body: "💾 *Backup Protection Enabled*\n\nVM:\n{{server_name}}\n\nSchedule:\n{{schedule}}\n\nStatus:\n{{status}}",
    templateVariables: ["server_name", "schedule", "status"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SERVICE_SUSPENDED,
    slug: WHATSAPP_TEMPLATE_KEYS.SERVICE_SUSPENDED,
    name: "Service suspended",
    category: "billing",
    language: "en",
    status: "approved",
    body: "⚠️ *Service suspended*\n\nHi {{first_name}}, {{service_name}} has been suspended because invoice *#{{invoice_id}}* is overdue.\n\nAmount due: {{invoice_total}}\nDue date: {{invoice_due}}\n\n🧾 Invoice:\n{{payment_link}}\n\nPay now to restore service.",
    buttons: [{ type: "url", label: "Renew Service", value: "{{payment_link}}" }],
    templateVariables: ["first_name", "service_name", "invoice_id", "invoice_total", "invoice_due", "payment_link"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.RENEWAL_REMINDER,
    slug: WHATSAPP_TEMPLATE_KEYS.RENEWAL_REMINDER,
    name: "Renewal reminder",
    category: "billing",
    language: "en",
    status: "approved",
    body: "Hi {{first_name}},\n\nYour VPS renewal is coming up.\n\nService:\n{{service_name}}\n\nPlan:\n{{service_plan}}\n\nInvoice:\n{{invoice_id}}\n\nAmount due:\n{{invoice_total}}\n\nDue date:\n{{invoice_due}}\n\nPay securely:\n{{payment_link}}\n\nView invoice:\n{{invoice_link}}\n\nDownload PDF:\n{{pdf_link}}\n\nIf you already paid, open the invoice link to view payment status.\n\n{{company_name}}",
    buttons: [{ type: "url", label: "Renew Service", value: "{{payment_link}}" }],
    templateVariables: ["first_name", "service_name", "service_plan", "invoice_id", "invoice_total", "invoice_due", "payment_link", "invoice_link", "pdf_link"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.SUPPORT_REPLY,
    slug: WHATSAPP_TEMPLATE_KEYS.SUPPORT_REPLY,
    name: "Support reply",
    category: "support",
    language: "en",
    status: "approved",
    body: "💬 *Support update*\n\nHi {{first_name}}, our support team replied to your ticket for {{service_name}}.\n\nOpen your dashboard to view the reply and continue the conversation.",
    buttons: [{ type: "url", label: "Open Support", value: "{{dashboard_url}}" }],
    templateVariables: ["first_name", "service_name", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.TICKET_UPDATE,
    slug: WHATSAPP_TEMPLATE_KEYS.TICKET_UPDATE,
    name: "Ticket update",
    category: "support",
    language: "en",
    status: "approved",
    body: "🎫 *Ticket update*\n\nHi {{first_name}}, ticket *#{{ticket_id}}* has an update.\n\n{{message_text}}\n\nOpen your dashboard to review the ticket.",
    buttons: [{ type: "url", label: "Open Support", value: "{{dashboard_url}}" }],
    templateVariables: ["first_name", "ticket_id", "message_text", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.MAINTENANCE_ALERT,
    slug: WHATSAPP_TEMPLATE_KEYS.MAINTENANCE_ALERT,
    name: "Maintenance alert",
    category: "utility",
    language: "en",
    status: "approved",
    body: "🛠️ *Maintenance notice*\n\nHi {{first_name}}, scheduled maintenance may affect {{service_name}}.\n\nRegion: {{region}}\nTimezone: {{timezone}}\n\nWe will keep downtime as low as possible.",
    templateVariables: ["first_name", "service_name", "region", "timezone"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.LOW_BALANCE,
    slug: WHATSAPP_TEMPLATE_KEYS.LOW_BALANCE,
    name: "Low balance",
    category: "billing",
    language: "en",
    status: "approved",
    body: "Hi {{first_name}}, your wallet balance is running low.\n\nAdd funds to keep invoices, renewals, and service automation running smoothly.",
    buttons: [{ type: "url", label: "Add Funds", value: "{{dashboard_url}}" }],
    templateVariables: ["first_name", "dashboard_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.CAMPAIGN_PROMO,
    slug: WHATSAPP_TEMPLATE_KEYS.CAMPAIGN_PROMO,
    name: "Campaign promo",
    category: "marketing",
    language: "en",
    status: "approved",
    headerType: "image",
    body: "Hi {{first_name}}, {{offer_name}} is live.\n\nUse code *{{coupon_code}}* for {{discount}} off eligible cloud plans.\n\nValid until {{expiry_date}}.\n\nReply STOP to opt out of marketing messages.",
    buttons: [{ type: "url", label: "View Offer", value: "{{website_url}}" }],
    templateVariables: ["first_name", "offer_name", "coupon_code", "discount", "expiry_date", "website_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.ABANDONED_CART,
    slug: WHATSAPP_TEMPLATE_KEYS.ABANDONED_CART,
    name: "Abandoned cart",
    category: "marketing",
    language: "en",
    status: "approved",
    body: "Hi {{first_name}}, your {{service_plan}} cloud server configuration is still saved.\n\nComplete checkout when you are ready, or reply if you need help choosing a plan.\n\nReply STOP to opt out.",
    buttons: [{ type: "url", label: "Resume Checkout", value: "{{website_url}}" }],
    templateVariables: ["first_name", "service_plan", "website_url"],
    isSystem: true,
  },
  {
    key: WHATSAPP_TEMPLATE_KEYS.ONBOARDING_WELCOME,
    slug: WHATSAPP_TEMPLATE_KEYS.ONBOARDING_WELCOME,
    name: "Onboarding welcome",
    category: "onboarding",
    language: "en",
    status: "approved",
    body: "Welcome to {{company_name}}, {{first_name}}.\n\nYour dashboard is ready for deployments, invoices, support, and service management.\n\nStart from your client area whenever you are ready.",
    buttons: [{ type: "url", label: "Open Dashboard", value: "{{dashboard_url}}" }],
    templateVariables: ["company_name", "first_name", "dashboard_url"],
    isSystem: true,
  },
]

const TRANSLATION_PRESETS: Record<string, Record<string, Partial<WhatsAppTemplateDraft>>> = {
  invoice_ready: {
    hi: { body: `🧾 *इनवॉइस तैयार है*\n\nनमस्ते {{first_name}}, invoice *#{{invoice_id}}* सफलतापूर्वक बना दिया गया है.\n\nAmount: {{invoice_total}}\nDue Date: {{invoice_due}}\n\nSecure payment के लिए नीचे दिया गया button इस्तेमाल करें.` },
    bn: { body: `🧾 *ইনভয়েস প্রস্তুত*\n\nHi {{first_name}}, invoice *#{{invoice_id}}* তৈরি হয়েছে.\n\nAmount: {{invoice_total}}\nDue Date: {{invoice_due}}\n\nনিরাপদ পেমেন্টের জন্য নিচের button ব্যবহার করুন.` },
    ar: { body: `🧾 *الفاتورة جاهزة*\n\nمرحباً {{first_name}}, تم إنشاء الفاتورة *#{{invoice_id}}* بنجاح.\n\nالمبلغ: {{invoice_total}}\nتاريخ الاستحقاق: {{invoice_due}}\n\nاستخدم الزر أدناه للدفع بأمان.` },
    es: { body: `🧾 *Factura lista*\n\nHola {{first_name}}, la factura *#{{invoice_id}}* se generó correctamente.\n\nImporte: {{invoice_total}}\nVence: {{invoice_due}}\n\nUsa el botón para pagar de forma segura.` },
  },
  login_alert: {
    hi: { body: `🔐 *LOGIN ALERT*\n\nHi {{first_name}}, आपके account में नया login detect हुआ.\n\nLocation: {{city}}, {{country}}\nIP: {{login_ip}}\nDevice: {{browser}} on {{os}}\nTime: {{login_time}}\n\nअगर यह आप नहीं थे, password तुरंत reset करें.` },
    bn: { body: `🔐 *LOGIN ALERT*\n\nHi {{first_name}}, আপনার account-এ নতুন login detect হয়েছে.\n\nLocation: {{city}}, {{country}}\nIP: {{login_ip}}\nDevice: {{browser}} on {{os}}\nTime: {{login_time}}\n\nএটি আপনি না হলে password reset করুন.` },
    ar: { body: `🔐 *تنبيه تسجيل دخول*\n\nمرحباً {{first_name}}, تم رصد تسجيل دخول جديد.\n\nالموقع: {{city}}, {{country}}\nIP: {{login_ip}}\nالجهاز: {{browser}} على {{os}}\nالوقت: {{login_time}}\n\nإذا لم تكن أنت، غيّر كلمة المرور فوراً.` },
    es: { body: `🔐 *Alerta de inicio de sesión*\n\nHola {{first_name}}, detectamos un nuevo inicio de sesión.\n\nUbicación: {{city}}, {{country}}\nIP: {{login_ip}}\nDispositivo: {{browser}} en {{os}}\nHora: {{login_time}}\n\nSi no fuiste tú, restablece tu contraseña ahora.` },
  },
  vps_deployed: {
    hi: { body: `🚀 *VPS DEPLOYED*\n\nHi {{first_name}}, आपका VPS ready है.\n\nHostname: {{hostname}}\nIP: {{server_ip}}\nUsername: {{rdp_username}}\nPassword: {{rdp_password}}\nOS: {{os_template}}\n\nDashboard: {{dashboard_url}}` },
    bn: { body: `🚀 *VPS DEPLOYED*\n\nHi {{first_name}}, আপনার VPS ready.\n\nHostname: {{hostname}}\nIP: {{server_ip}}\nUsername: {{rdp_username}}\nPassword: {{rdp_password}}\nOS: {{os_template}}\n\nDashboard: {{dashboard_url}}` },
    ar: { body: `🚀 *تم تجهيز VPS*\n\nمرحباً {{first_name}}, الخادم جاهز الآن.\n\nHostname: {{hostname}}\nIP: {{server_ip}}\nUsername: {{rdp_username}}\nPassword: {{rdp_password}}\nOS: {{os_template}}\n\nDashboard: {{dashboard_url}}` },
    es: { body: `🚀 *VPS desplegado*\n\nHola {{first_name}}, tu VPS ya está listo.\n\nHostname: {{hostname}}\nIP: {{server_ip}}\nUsuario: {{rdp_username}}\nContraseña: {{rdp_password}}\nOS: {{os_template}}\n\nDashboard: {{dashboard_url}}` },
  },
}

function stringifyVariable(value: unknown) {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toLocaleString("en-IN")
  return String(value)
}

function normalizeSlug(input: string) {
  return input.trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "")
}

function normalizeCategory(category: string): WhatsAppTemplateCategory {
  const value = String(category || "").toLowerCase().trim()
  if (value === "auth") return "authentication"
  if (value === "transactional" || value === "order" || value === "invoice") return "billing"
  if (value === "server" || value === "service" || value === "vps") return "provisioning"
  return SUPPORTED_CATEGORIES.has(value as WhatsAppTemplateCategory) ? value as WhatsAppTemplateCategory : "utility"
}

function normalizeLanguage(language: unknown) {
  const value = String(language || "en").trim().toLowerCase().split("-")[0]
  return SUPPORTED_LANGUAGES.has(value) ? value : "en"
}

function normalizeHeaderType(value: unknown): WhatsAppHeaderType {
  const headerType = String(value || "none").toLowerCase()
  return HEADER_TYPES.has(headerType as WhatsAppHeaderType) ? headerType as WhatsAppHeaderType : "none"
}

function normalizeStatus(value: unknown): WhatsAppTemplateStatus {
  const status = String(value || "draft").toLowerCase()
  return SUPPORTED_STATUSES.has(status as WhatsAppTemplateStatus) ? status as WhatsAppTemplateStatus : "draft"
}

function sanitizeValue(key: string, value: unknown, forLog = false) {
  const meta = VARIABLE_META.get(key)
  if (forLog && meta?.sensitive) return "[redacted]"
  const raw = stringifyVariable(value)
  if (meta?.maskingPolicy === "phone") return maskWhatsAppPhone(raw)
  if (forLog) return String(redactWhatsAppPayload(raw) ?? "")
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim()
}

export function extractTemplateVariables(...parts: Array<string | null | undefined>) {
  const text = parts.filter(Boolean).join("\n")
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)
  return Array.from(new Set(Array.from(matches).map((match) => match[1]).filter(Boolean)))
}

/**
 * Brand name for a message variable.
 *
 * The panel already resolves this authoritatively in `getBrandSettings()`
 * (platform brand -> general brand -> company name -> configured domain). This
 * used to default to the literal string "Cloud", so any send path that did not
 * itself pass a brand sent customers a message signed "Cloud" — including every
 * OTP template, which uses `{{company_name}}`.
 *
 * Resolution order is: explicit override, configured brand settings, configured
 * domain. The domain is the last resort because it is always present in a real
 * deployment and is at least an honest name for the operator.
 */
/**
 * Brand name for a message variable, resolved from the passed values alone.
 *
 * The synchronous render helpers cannot await a settings read, so this uses only
 * what the caller supplied, then the configured domain, then the panel default.
 * `resolveConfiguredBrandName()` below is the async form for send paths that can
 * read the settings, and callers should prefer it.
 */
function brandNameFromInput(input: WhatsAppTemplateVariables): string {
  const explicit = stringifyVariable(input.company_name || input.brandName || "").trim()
  if (explicit) return explicit
  const domain = configuredSiteDomain()
  return domain ? domain.split(".")[0] : "ZWS Cloud"
}

/**
 * Authoritative brand name, from the configured company/brand/domain.
 *
 * Order: explicit override, then `getBrandSettings()` (platform brand, general
 * brand, then company name), then the configured domain. Never a hardcoded
 * product name.
 */
export async function resolveConfiguredBrandName(override?: unknown): Promise<string> {
  const explicit = stringifyVariable(override || "").trim()
  if (explicit) return explicit
  const configured = await getBrandSettings()
    .then((settings) => String(settings.brandName || settings.appName || settings.legalCompanyName || "").trim())
    .catch(() => "")
  if (configured) return configured
  const domain = configuredSiteDomain()
  return domain ? domain.split(".")[0] : "ZWS Cloud"
}

export function buildSmartVariables(input: WhatsAppTemplateVariables = {}): Record<string, unknown> {
  const firstName = stringifyVariable(input.first_name || input.firstName || input.name || input.username || "there").split(/\s+/)[0] || "there"
  const timezone = stringifyVariable(input.timezone || "Asia/Kolkata")
  const now = new Date()
  let hour = now.getHours()
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now))
  } catch {
    hour = now.getHours()
  }
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
  const phone = stringifyVariable(input.phone || "")
  return {
    company_name: brandNameFromInput(input),
    brandName: brandNameFromInput(input),
    support_email: sampleSupportEmail(),
    support_phone: "",
    website_url: publicOrigin(),
    dashboard_url: `${publicOrigin()}/client-area`,
    ...input,
    username: input.username || input.userName || input.name || firstName,
    first_name: firstName,
    email: input.email || input.userEmail,
    invoice_id: input.invoice_id || input.invoiceId || input.invoiceNumber,
    invoice_total: input.invoice_total || input.amount || input.totalAmount,
    invoice_due: input.invoice_due || input.dueDate,
    invoice_link: input.invoice_link || input.invoiceLink || input.payment_link || input.paymentUrl,
    pdf_link: input.pdf_link || input.pdfLink || input.pdfUrl || input.invoicePdfUrl,
    order_id: input.order_id || input.orderId || input.orderNumber,
    ticket_id: input.ticket_id || input.ticketId || input.ticketNumber,
    service_name: input.service_name || input.serviceName || input.productName,
    service_plan: input.service_plan || input.servicePlan || input.planName,
    payment_amount: input.payment_amount || input.amount,
    payment_link: input.payment_link || input.paymentUrl,
    panel_link: input.panel_link || input.panelLink || input.serviceUrl || input.dashboard_url,
    ip: input.ip || input.login_ip || input.loginIp || "Unknown",
    city: input.city || "Unknown",
    country: input.country || "Unknown",
    browser: input.browser || input.device || "Unknown device",
    login_ip: input.login_ip || input.loginIp || input.ip,
    login_time: input.login_time || input.loginTime,
    otp_code: input.otp_code || input.otp,
    rdp_password: input.rdp_password || input.password || input.temporaryPassword,
    rdp_username: input.rdp_username || input.username || input.serverUsername,
    server_ip: input.server_ip || input.primaryIp || input.ip,
    renewal_date: input.renewal_date || input.renewalDate || input.invoice_due || input.dueDate,
    masked_phone: input.masked_phone || (phone ? maskWhatsAppPhone(phone) : ""),
    greeting,
    timezone,
  }
}

export function renderWhatsAppTemplate(body: string, variables: WhatsAppTemplateVariables) {
  const smartVariables: Record<string, unknown> = buildSmartVariables(variables)
  return String(body || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => sanitizeValue(key, smartVariables[key]))
}

function renderButtons(buttons: WhatsAppTemplateButton[] = [], variables: WhatsAppTemplateVariables) {
  return buttons.map((button, index) => ({
    id: button.id || `button_${index + 1}`,
    type: button.type,
    label: renderWhatsAppTemplate(button.label || "", variables).slice(0, 25),
    value: button.value ? renderWhatsAppTemplate(button.value, variables) : undefined,
  }))
}

function buttonsToText(buttons: WhatsAppTemplateButton[]) {
  if (!buttons.length) return ""
  return buttons.map((button) => {
    if (button.type === "url" && button.value) return `[ ${button.label} ]\n${button.value}`
    if (button.type === "call" && button.value) return `[ ${button.label} ]\nCall: ${button.value}`
    if (button.type === "copy_code" && button.value) return `[ ${button.label} ] ${button.value}`
    return `[ ${button.label} ]`
  }).join("\n")
}

export function renderWhatsAppComponents(template: WhatsAppTemplateDraft, variables: WhatsAppTemplateVariables = {}): WhatsAppRenderedTemplate {
  const category = normalizeCategory(template.category)
  const language = normalizeLanguage(template.language)
  const smartVariables: Record<string, unknown> = buildSmartVariables(variables)
  const headerType = normalizeHeaderType(template.headerType)
  const header = headerType === "text" && template.headerText ? renderWhatsAppTemplate(template.headerText, smartVariables) : null
  const body = renderWhatsAppTemplate(template.body, smartVariables)
  const footer = template.footer ? renderWhatsAppTemplate(template.footer, smartVariables) : null
  const buttons = renderButtons(template.buttons || [], smartVariables)
  const message = [header, body, footer, buttonsToText(buttons)].filter(Boolean).join("\n\n")
  return {
    header,
    body,
    footer,
    buttons,
    mediaUrl: template.mediaUrl || null,
    message,
    variables: extractTemplateVariables(template.headerText, template.body, template.footer, ...(template.buttons || []).flatMap((button) => [button.label, button.value])),
    language,
    category,
  }
}

function normalizeButtons(input: unknown): WhatsAppTemplateButton[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 10).map((button, index) => {
    const record = button && typeof button === "object" ? button as Record<string, unknown> : {}
    const type = String(record.type || "quick_reply") as WhatsAppButtonType
    const safeType: WhatsAppButtonType = ["quick_reply", "url", "call", "copy_code"].includes(type) ? type : "quick_reply"
    return {
      id: typeof record.id === "string" ? record.id : `button_${index + 1}`,
      type: safeType,
      label: String(record.label || "Open").trim().slice(0, 25),
      value: typeof record.value === "string" ? record.value.trim() : undefined,
    }
  }).filter((button) => button.label)
}

export function normalizeTemplateDraft(input: Partial<WhatsAppTemplateDraft>): WhatsAppTemplateDraft {
  const name = String(input.name || input.key || input.slug || "WhatsApp template").trim()
  const slug = normalizeSlug(String(input.slug || input.key || name))
  const body = String(input.body || "").trim()
  const buttons = normalizeButtons(input.buttons)
  const templateVariables = input.templateVariables?.length
    ? Array.from(new Set(input.templateVariables.map(String)))
    : extractTemplateVariables(input.headerText, body, input.footer, ...buttons.flatMap((button) => [button.label, button.value]))
  return {
    name,
    slug,
    key: normalizeSlug(String(input.key || slug || name)),
    category: normalizeCategory(String(input.category || "utility")),
    language: normalizeLanguage(input.language),
    status: normalizeStatus(input.status),
    headerType: normalizeHeaderType(input.headerType),
    headerText: input.headerText ? String(input.headerText).trim() : null,
    body,
    footer: input.footer ? String(input.footer).trim() : null,
    buttons,
    mediaUrl: input.mediaUrl ? String(input.mediaUrl).trim() : null,
    templateVariables,
    isSystem: Boolean(input.isSystem),
    isActive: typeof input.isActive === "boolean" ? input.isActive : true,
  }
}

export function validateWhatsAppTemplate(input: Partial<WhatsAppTemplateDraft>): WhatsAppTemplateValidationIssue[] {
  const draft = normalizeTemplateDraft(input)
  const issues: WhatsAppTemplateValidationIssue[] = []
  const buttons = draft.buttons || []
  const allText = [draft.headerText, draft.body, draft.footer, ...buttons.flatMap((button) => [button.label, button.value])].filter(Boolean).join("\n")
  const variables = extractTemplateVariables(allText)
  const unknown = variables.filter((variable) => !VARIABLE_META.has(variable))
  const bodyVariables = extractTemplateVariables(draft.body)

  if (!SUPPORTED_CATEGORIES.has(draft.category as WhatsAppTemplateCategory)) issues.push({ level: "error", code: "category_invalid", message: "Use a supported WhatsApp category." })
  if (!draft.body) issues.push({ level: "error", code: "body_required", message: "Template body is required." })
  if (draft.body.length > 1024) issues.push({ level: "error", code: "body_too_long", message: "WhatsApp template bodies should stay within 1,024 characters." })
  if ((draft.footer || "").length > 60) issues.push({ level: "error", code: "footer_too_long", message: "Footer must be 60 characters or fewer." })
  if ((draft.headerText || "").length > 60) issues.push({ level: "error", code: "header_too_long", message: "Text header must be 60 characters or fewer." })
  if (draft.footer && extractTemplateVariables(draft.footer).length) issues.push({ level: "error", code: "footer_variables", message: "Footer text cannot contain placeholders." })
  if (unknown.length) issues.push({ level: "warning", code: "unknown_variables", message: `Unknown variables: ${unknown.join(", ")}.` })
  if (/\}\}\s*\{\{/.test(allText)) issues.push({ level: "error", code: "adjacent_placeholders", message: "Avoid adjacent placeholders. Add contextual words between variables." })
  if (bodyVariables.length > 12) issues.push({ level: "warning", code: "too_many_variables", message: "This template uses many variables. Keep WhatsApp copy concise." })
  if (/(\n\s*){4,}/.test(draft.body)) issues.push({ level: "warning", code: "excess_spacing", message: "Reduce large blank sections for better mobile readability." })

  const urlButtons = buttons.filter((button) => button.type === "url")
  const callButtons = buttons.filter((button) => button.type === "call")
  if (urlButtons.length > 2) issues.push({ level: "error", code: "too_many_url_buttons", message: "Use at most two URL buttons." })
  if (callButtons.length > 1) issues.push({ level: "error", code: "too_many_call_buttons", message: "Use at most one call button." })
  for (const button of buttons) {
    if (button.label.length > 25) issues.push({ level: "error", code: "button_label_too_long", message: `Button "${button.label}" is longer than 25 characters.` })
    if ((button.type === "url" || button.type === "call") && !button.value) issues.push({ level: "error", code: "button_value_missing", message: `Button "${button.label}" needs a destination.` })
  }

  if (draft.category === "authentication") {
    if (draft.headerType !== "none" || draft.mediaUrl) issues.push({ level: "error", code: "auth_media", message: "Authentication templates should not use media or custom headers." })
    if (!bodyVariables.includes("otp_code")) issues.push({ level: "error", code: "auth_otp_required", message: "Authentication templates must include {{otp_code}}." })
    if (bodyVariables.length > 3) issues.push({ level: "warning", code: "auth_variable_count", message: "Authentication templates should use very few variables." })
    if (PROMOTIONAL_PATTERN.test(allText)) issues.push({ level: "error", code: "auth_promotional", message: "Authentication templates cannot include promotional wording." })
  }

  if ((draft.category === "utility" || draft.category === "billing" || draft.category === "security" || draft.category === "provisioning") && PROMOTIONAL_PATTERN.test(allText)) {
    issues.push({ level: "warning", code: "utility_marketing_risk", message: "This wording may be reclassified as marketing." })
  }
  if (draft.category === "marketing" && !/stop|unsubscribe|opt out/i.test(allText)) {
    issues.push({ level: "warning", code: "marketing_opt_out", message: "Marketing templates should include opt-out wording." })
  }

  return issues
}

export function sampleVariables(keys: string[] = WHATSAPP_TEMPLATE_VARIABLE_KEYS) {
  return Object.fromEntries(keys.map((key) => [key, VARIABLE_META.get(key)?.sampleValue || "Sample"]))
}

function stableJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function templateContentSignature(input: Partial<WhatsAppTemplateDraft>) {
  const draft = normalizeTemplateDraft(input)
  return stableJson({
    name: draft.name,
    slug: draft.slug,
    category: draft.category,
    language: draft.language || "en",
    status: draft.status || "approved",
    headerType: draft.headerType || "none",
    headerText: draft.headerText || null,
    body: draft.body,
    footer: draft.footer || null,
    buttons: draft.buttons || [],
    mediaUrl: draft.mediaUrl || null,
    templateVariables: draft.templateVariables || [],
  })
}

function toPrismaTemplateData(input: Partial<WhatsAppTemplateDraft>) {
  const draft = normalizeTemplateDraft(input)
  return {
    key: draft.key!,
    slug: draft.slug!,
    name: draft.name,
    category: draft.category,
    language: draft.language || "en",
    status: draft.status || "draft",
    headerType: draft.headerType || "none",
    headerText: draft.headerText || null,
    body: draft.body,
    footer: draft.footer || null,
    buttons: draft.buttons as any,
    mediaUrl: draft.mediaUrl || null,
    variables: draft.templateVariables as any,
    templateVariables: draft.templateVariables as any,
    isSystem: Boolean(draft.isSystem),
    isActive: draft.isActive !== false,
    enabled: draft.isActive !== false,
  }
}

export async function seedWhatsAppTemplateVariables() {
  await Promise.all(WHATSAPP_TEMPLATE_VARIABLES.map((entry) => (prisma as any).whatsAppTemplateVariable.upsert({
    where: { key: entry[1] },
    update: {
      group: entry[0],
      label: entry[2],
      sampleValue: entry[3],
      sensitive: entry[4],
      maskingPolicy: entry[5],
    },
    create: {
      id: `wa_var_${entry[1]}`,
      group: entry[0],
      key: entry[1],
      label: entry[2],
      sampleValue: entry[3],
      sensitive: entry[4],
      maskingPolicy: entry[5],
    },
  }))).catch(() => null)
}

export async function snapshotWhatsAppTemplate(templateId: string, createdBy?: string | null, validation?: WhatsAppTemplateValidationIssue[]) {
  const template = await (prisma as any).whatsAppTemplate.findUnique({ where: { id: templateId } })
  if (!template) return null
  const latest = await (prisma as any).whatsAppTemplateVersion.findFirst({
    where: { templateId },
    orderBy: { version: "desc" },
    select: { version: true },
  }).catch(() => null)
  const version = await (prisma as any).whatsAppTemplateVersion.create({
    data: {
      templateId,
      version: Number(latest?.version || 0) + 1,
      name: template.name,
      slug: template.slug || template.key,
      category: template.category,
      language: template.language || "en",
      status: template.status || "draft",
      headerType: template.headerType || "none",
      headerText: template.headerText || null,
      body: template.body,
      footer: template.footer || null,
      buttons: template.buttons || [],
      mediaUrl: template.mediaUrl || null,
      templateVariables: template.templateVariables || template.variables || [],
      validation: { issues: validation || validateWhatsAppTemplate(template) },
      createdBy: createdBy || null,
    },
  }).catch(() => null)
  await invalidateWhatsAppTemplateCache(template.key).catch(() => null)
  return version
}

async function ensureApprovedTemplateVersion(template: any, createdBy = "system") {
  const latestApproved = await (prisma as any).whatsAppTemplateVersion.findFirst({
    where: { templateId: template.id, status: "approved" },
    orderBy: { version: "desc" },
  }).catch(() => null)
  const currentSignature = templateContentSignature({
    key: template.key,
    slug: template.slug || template.key,
    name: template.name,
    category: template.category,
    language: template.language || "en",
    status: "approved",
    headerType: template.headerType || "none",
    headerText: template.headerText || null,
    body: template.body,
    footer: template.footer || null,
    buttons: template.buttons || [],
    mediaUrl: template.mediaUrl || null,
    templateVariables: template.templateVariables || template.variables || [],
    isSystem: template.isSystem,
    isActive: template.isActive ?? template.enabled,
  })
  const latestSignature = latestApproved ? templateContentSignature({
    key: template.key,
    slug: latestApproved.slug || template.slug || template.key,
    name: latestApproved.name,
    category: latestApproved.category,
    language: latestApproved.language || "en",
    status: latestApproved.status || "approved",
    headerType: latestApproved.headerType || "none",
    headerText: latestApproved.headerText || null,
    body: latestApproved.body,
    footer: latestApproved.footer || null,
    buttons: latestApproved.buttons || [],
    mediaUrl: latestApproved.mediaUrl || null,
    templateVariables: latestApproved.templateVariables || [],
    isSystem: template.isSystem,
    isActive: template.isActive ?? template.enabled,
  }) : null
  if (latestApproved && latestSignature === currentSignature) return latestApproved
  return snapshotWhatsAppTemplate(template.id, createdBy, validateWhatsAppTemplate(template))
}

async function ensureEnglishTranslation(template: any) {
  return (prisma as any).whatsAppTemplateTranslation.upsert({
    where: { templateId_language: { templateId: template.id, language: "en" } },
    update: {
      status: "approved",
      headerText: template.headerText || null,
      body: template.body,
      footer: template.footer || null,
      buttons: template.buttons || [],
      mediaUrl: template.mediaUrl || null,
      templateVariables: template.templateVariables || template.variables || [],
    },
    create: {
      templateId: template.id,
      language: "en",
      status: "approved",
      headerText: template.headerText || null,
      body: template.body,
      footer: template.footer || null,
      buttons: template.buttons || [],
      mediaUrl: template.mediaUrl || null,
      templateVariables: template.templateVariables || template.variables || [],
    },
  })
}

export async function ensureDefaultWhatsAppTemplates() {
  await seedWhatsAppTemplateVariables()
  await (prisma as any).whatsAppTemplate.updateMany({
    where: { key: { in: [...LEGACY_WHATSAPP_TEMPLATE_KEYS] } },
    data: { isActive: false, enabled: false, status: "archived" },
  }).catch(() => null)
  for (const preset of DEFAULT_WHATSAPP_TEMPLATES) {
    const data = toPrismaTemplateData(preset)
    const template = await (prisma as any).whatsAppTemplate.upsert({
      where: { key: data.key },
      update: {
        slug: data.slug,
        category: data.category,
        language: data.language,
        headerType: data.headerType,
        headerText: data.headerText,
        status: "approved",
        body: data.body,
        footer: data.footer,
        buttons: data.buttons,
        mediaUrl: data.mediaUrl,
        variables: data.variables,
        templateVariables: data.templateVariables,
        isSystem: true,
        isActive: true,
        enabled: true,
      },
      create: { ...data, isSystem: true, isActive: true, enabled: true },
    }).catch(() => null)

    if (template) {
      await ensureEnglishTranslation(template).catch(() => null)
      await ensureApprovedTemplateVersion(template, "system").catch(() => null)
      const translations = TRANSLATION_PRESETS[preset.slug || preset.key || ""]
      if (translations) {
        for (const [language, translation] of Object.entries(translations)) {
          const translated = normalizeTemplateDraft({ ...preset, ...translation, language })
          await (prisma as any).whatsAppTemplateTranslation.upsert({
            where: { templateId_language: { templateId: template.id, language } },
            update: {
              status: "approved",
              headerText: translated.headerText || null,
              body: translated.body,
              footer: translated.footer || null,
              buttons: translated.buttons as any,
              mediaUrl: translated.mediaUrl || null,
              templateVariables: translated.templateVariables as any,
            },
            create: {
              templateId: template.id,
              language,
              status: "approved",
              headerText: translated.headerText || null,
              body: translated.body,
              footer: translated.footer || null,
              buttons: translated.buttons as any,
              mediaUrl: translated.mediaUrl || null,
              templateVariables: translated.templateVariables as any,
            },
          }).catch(() => null)
        }
      }
    }
  }
  await validateWhatsAppRequiredTemplates({ autoHeal: false }).catch(() => null)
  await invalidateWhatsAppTemplateCache().catch(() => null)
}

function dbTemplateToDraft(template: any): WhatsAppTemplateDraft {
  return normalizeTemplateDraft({
    key: template.key,
    slug: template.slug || template.key,
    name: template.name,
    category: template.category,
    language: template.language,
    status: template.status,
    headerType: template.headerType,
    headerText: template.headerText,
    body: template.body,
    footer: template.footer,
    buttons: template.buttons || [],
    mediaUrl: template.mediaUrl,
    templateVariables: template.templateVariables || template.variables || [],
    isSystem: template.isSystem,
    isActive: template.isActive ?? template.enabled,
  })
}

async function getTemplateRedis() {
  const redis = getRedisClient()
  if (!redis) return null
  if (redis.status !== "ready") {
    try {
      await redis.connect()
    } catch {
      return null
    }
  }
  return redis
}

function cacheKey(input: { key: string; language?: string | null; versionId?: string | null }) {
  return `${TEMPLATE_CACHE_PREFIX}${localTemplateCacheVersion}:${normalizeSlug(input.key)}:${normalizeLanguage(input.language)}:${input.versionId || "latest"}`
}

async function readTemplateCache(key: string): Promise<CachedTemplate | null> {
  const memory = inMemoryTemplateCache.get(key)
  if (memory && memory.expiresAt > Date.now()) return memory.value
  inMemoryTemplateCache.delete(key)

  const redis = await getTemplateRedis()
  if (!redis) return null
  const raw = await redis.get(key).catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedTemplate
    inMemoryTemplateCache.set(key, { value: parsed, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_SECONDS * 1000 })
    return parsed
  } catch {
    return null
  }
}

async function writeTemplateCache(key: string, value: CachedTemplate) {
  inMemoryTemplateCache.set(key, { value, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_SECONDS * 1000 })
  const redis = await getTemplateRedis()
  await redis?.set(key, JSON.stringify(value), "EX", TEMPLATE_CACHE_TTL_SECONDS).catch(() => null)
}

export async function invalidateWhatsAppTemplateCache(templateKey?: string | null) {
  const normalized = templateKey ? normalizeSlug(templateKey) : null
  localTemplateCacheVersion = `${Date.now()}`
  for (const key of Array.from(inMemoryTemplateCache.keys())) {
    if (!normalized || key.includes(`:${normalized}:`)) inMemoryTemplateCache.delete(key)
  }
  const redis = await getTemplateRedis()
  if (!redis) return
  await redis.set(TEMPLATE_CACHE_VERSION_KEY, localTemplateCacheVersion).catch(() => null)
  const pattern = normalized ? `${TEMPLATE_CACHE_PREFIX}*:${normalized}:*` : `${TEMPLATE_CACHE_PREFIX}*`
  const keys = await redis.keys(pattern).catch(() => [])
  if (keys.length) await redis.del(...keys).catch(() => null)
}

function cachedFromTemplate(template: any, draft: WhatsAppTemplateDraft, version: any | null, requestedLanguage: string, fallbackLanguage: string | null): CachedTemplate {
  return {
    templateId: template.id,
    templateKey: template.key,
    templateName: template.name,
    templateVersionId: version?.id || null,
    templateVersion: Number.isInteger(version?.version) ? version.version : null,
    requestedLanguage,
    resolvedLanguage: normalizeLanguage(draft.language),
    fallbackLanguage,
    draft,
  }
}

async function loadTemplateForRender(input: { key: string; language?: string | null; versionId?: string | null }) {
  const canonicalKey = canonicalWhatsAppTemplateKey(input.key)
  const requestedLanguage = normalizeLanguage(input.language)
  const key = cacheKey(input)
  const cached = await readTemplateCache(key)
  if (cached) return { cached, cacheHit: true }

  if (input.versionId) {
    const version = await (prisma as any).whatsAppTemplateVersion.findUnique({
      where: { id: input.versionId },
      include: { template: true },
    }).catch(() => null)
    if (!version?.template || version.status !== "approved" || version.template.isActive === false || version.template.enabled === false) return null
    const cachedVersion = cachedFromTemplate(version.template, normalizeTemplateDraft({
      key: version.template.key,
      slug: version.slug || version.template.slug || version.template.key,
      name: version.name,
      category: version.category,
      language: version.language,
      status: version.status,
      headerType: version.headerType,
      headerText: version.headerText,
      body: version.body,
      footer: version.footer,
      buttons: version.buttons || [],
      mediaUrl: version.mediaUrl,
      templateVariables: version.templateVariables || [],
      isSystem: version.template.isSystem,
      isActive: version.template.isActive ?? version.template.enabled,
    }), version, requestedLanguage, null)
    await writeTemplateCache(key, cachedVersion)
    return { cached: cachedVersion, cacheHit: false }
  }

  const normalized = normalizeSlug(canonicalKey)
  const template = await (prisma as any).whatsAppTemplate.findFirst({
    where: {
      OR: [{ key: canonicalKey }, { slug: canonicalKey }, { key: normalized }, { slug: normalized }],
      isActive: true,
      enabled: true,
      status: { not: "archived" },
    },
    include: {
      translations: { where: { status: { not: "archived" } } },
      versions: { where: { status: "approved" }, orderBy: { version: "desc" }, take: 1 },
    },
  }).catch(() => null)
  if (!template) return null

  const baseDraft = dbTemplateToDraft(template)
  const baseLanguage = normalizeLanguage(template.language)
  const translations = template.translations || []
  const translation = requestedLanguage === baseLanguage
    ? null
    : translations.find((entry: any) => normalizeLanguage(entry.language) === requestedLanguage)
  const englishTranslation = requestedLanguage === "en" || baseLanguage === "en"
    ? null
    : translations.find((entry: any) => normalizeLanguage(entry.language) === "en")
  const selectedTranslation = translation || englishTranslation
  const fallbackLanguage = translation ? null : (requestedLanguage !== baseLanguage ? normalizeLanguage(selectedTranslation?.language || template.language || "en") : null)
  const draft = translation ? normalizeTemplateDraft({
    ...baseDraft,
    language: translation.language,
    headerText: translation.headerText,
    body: translation.body,
    footer: translation.footer,
    buttons: translation.buttons || template.buttons || [],
    mediaUrl: translation.mediaUrl || template.mediaUrl,
    templateVariables: translation.templateVariables || template.templateVariables || template.variables || [],
  }) : selectedTranslation ? normalizeTemplateDraft({
    ...baseDraft,
    language: selectedTranslation.language,
    headerText: selectedTranslation.headerText,
    body: selectedTranslation.body,
    footer: selectedTranslation.footer,
    buttons: selectedTranslation.buttons || template.buttons || [],
    mediaUrl: selectedTranslation.mediaUrl || template.mediaUrl,
    templateVariables: selectedTranslation.templateVariables || template.templateVariables || template.variables || [],
  }) : baseDraft
  const value = cachedFromTemplate(template, draft, template.versions?.[0] || null, requestedLanguage, fallbackLanguage)
  await writeTemplateCache(key, value)
  return { cached: value, cacheHit: false }
}

export async function findWhatsAppTemplate(keyOrSlug: string, language?: string | null) {
  const resolved = await loadTemplateForRender({ key: keyOrSlug, language })
  return resolved?.cached.draft || null
}

export async function renderWhatsAppTemplateByKey(key: string, variables: WhatsAppTemplateVariables, language?: string | null) {
  const rendered = await resolveAndRenderWhatsAppTemplate({ key, variables, language })
  return rendered?.message || null
}

export async function resolveAndRenderWhatsAppTemplate(input: {
  key: string
  variables?: WhatsAppTemplateVariables
  language?: string | null
  templateVersionId?: string | null
  fallbackKey?: string | null
}): Promise<WhatsAppResolvedRenderedTemplate | null> {
  const startedAt = Date.now()
  const requestedTemplateKey = input.key
  const canonicalTemplateKey = canonicalWhatsAppTemplateKey(input.key)
  const fallbackKey = canonicalWhatsAppTemplateKey(input.fallbackKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK)
  const primary = await loadTemplateForRender({ key: canonicalTemplateKey, language: input.language, versionId: input.templateVersionId || null })
  const fallbackReason = primary ? null : `missing_template:${canonicalTemplateKey}`
  const resolved = primary || (fallbackKey !== canonicalTemplateKey || canonicalTemplateKey !== WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK
    ? await loadTemplateForRender({ key: fallbackKey, language: input.language })
    : null)
  if (!resolved) {
    await writeWhatsAppLog({
      level: "error",
      event: "template.resolve_failed",
      status: "failed",
      failureReason: "template_missing",
      metadata: {
        requestedTemplateKey,
        canonicalTemplateKey,
        fallbackKey,
        language: input.language || "en",
        templateVersionId: input.templateVersionId || null,
        renderDurationMs: Date.now() - startedAt,
      },
    }).catch(() => null)
    return null
  }

  const variables = {
    fallback_reason: fallbackReason,
    message_text: "Your {{company_name}} update is ready.",
    ...(input.variables || {}),
  }
  const rendered = renderWhatsAppComponents(resolved.cached.draft, variables)
  if (fallbackReason) {
    await writeWhatsAppLog({
      level: "warn",
      event: "template.fallback_used",
      status: "degraded",
      failureReason: fallbackReason,
      metadata: {
        requestedTemplateKey,
        canonicalTemplateKey,
        resolvedTemplateId: resolved.cached.templateId,
        resolvedTemplateKey: resolved.cached.templateKey,
        resolvedVersionId: resolved.cached.templateVersionId,
        resolvedVersion: resolved.cached.templateVersion,
        language: rendered.language,
        fallbackLanguage: resolved.cached.fallbackLanguage,
        cacheHit: resolved.cacheHit,
        renderDurationMs: Date.now() - startedAt,
      },
    }).catch(() => null)
  }
  return {
    ...rendered,
    templateId: resolved.cached.templateId,
    templateKey: resolved.cached.templateKey,
    requestedTemplateKey,
    canonicalTemplateKey,
    templateName: resolved.cached.templateName,
    templateVersionId: resolved.cached.templateVersionId,
    templateVersion: resolved.cached.templateVersion,
    cacheHit: resolved.cacheHit,
    fallbackReason,
    fallbackLanguage: resolved.cached.fallbackLanguage,
    renderDurationMs: Date.now() - startedAt,
  }
}

export function redactRenderedWhatsAppVariables(variables: WhatsAppTemplateVariables) {
  return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, sanitizeValue(key, value, true)]))
}

export async function getWhatsAppTemplateCacheStatus() {
  const redis = await getTemplateRedis()
  const redisVersion = redis ? await redis.get(TEMPLATE_CACHE_VERSION_KEY).catch(() => null) : null
  return {
    memoryEntries: inMemoryTemplateCache.size,
    localVersion: localTemplateCacheVersion,
    redisConfigured: Boolean(redis),
    redisVersion,
    ttlSeconds: TEMPLATE_CACHE_TTL_SECONDS,
  }
}

export async function validateWhatsAppRequiredTemplates(input: { autoHeal?: boolean } = {}) {
  if (input.autoHeal) await ensureDefaultWhatsAppTemplates()
  const templates = await (prisma as any).whatsAppTemplate.findMany({
    where: { key: { in: REQUIRED_WHATSAPP_TEMPLATE_KEYS as string[] } },
    include: {
      translations: true,
      versions: { where: { status: "approved" }, orderBy: { version: "desc" }, take: 1 },
    },
  }).catch(() => [])
  const byKey = new Map<string, any>((templates || []).map((template: any) => [template.key, template]))
  const rows = REQUIRED_WHATSAPP_TEMPLATE_KEYS.map((key) => {
    const template = byKey.get(key)
    const activeVersion = template?.versions?.[0] || null
    const englishTranslation = (template?.translations || []).find((entry: any) => normalizeLanguage(entry.language) === "en" && entry.status !== "archived")
    const ok = Boolean(template?.isActive !== false && template?.enabled !== false && template?.status === "approved" && activeVersion && englishTranslation)
    return {
      key,
      ok,
      templateId: template?.id || null,
      status: template?.status || "missing",
      active: Boolean(template?.isActive !== false && template?.enabled !== false),
      activeVersionId: activeVersion?.id || null,
      activeVersion: activeVersion?.version || null,
      translationCount: template?.translations?.length || 0,
      hasEnglishTranslation: Boolean(englishTranslation),
      missingReasons: [
        !template ? "template_missing" : null,
        template && template.status !== "approved" ? "template_not_approved" : null,
        template && (template.isActive === false || template.enabled === false) ? "template_inactive" : null,
        template && !activeVersion ? "approved_version_missing" : null,
        template && !englishTranslation ? "english_translation_missing" : null,
      ].filter(Boolean),
    }
  })
  return {
    ok: rows.every((row) => row.ok),
    required: rows,
    missing: rows.filter((row) => !row.ok),
    cache: await getWhatsAppTemplateCacheStatus(),
  }
}

export async function getWhatsAppTemplateAnalytics(templateKey?: string | null) {
  const where = templateKey ? { templateKey } : {}
  const [statusGroups, recentFailures] = await Promise.all([
    (prisma as any).whatsAppMessageLog.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }).catch(() => []),
    (prisma as any).whatsAppMessageLog.findMany({
      where: { ...where, status: { in: ["failed", "abandoned", "retrying"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, status: true, templateKey: true, toMasked: true, failureReason: true, errorMessage: true, createdAt: true },
    }).catch(() => []),
  ])
  const counts = Object.fromEntries(statusGroups.map((entry: any) => [entry.status, entry._count?._all || 0]))
  const sent = Number(counts.sent || 0) + Number(counts.delivered || 0) + Number(counts.read || 0)
  const delivered = Number(counts.delivered || 0) + Number(counts.read || 0)
  const read = Number(counts.read || 0)
  const failed = Number(counts.failed || 0) + Number(counts.abandoned || 0)
  const total = sent + failed + Number(counts.queued || 0) + Number(counts.processing || 0) + Number(counts.sending || 0) + Number(counts.retrying || 0)
  return {
    total,
    sent,
    delivered,
    read,
    failed,
    clickRate: 0,
    conversionRate: 0,
    deliveryRate: sent ? Math.round((delivered / sent) * 1000) / 10 : 0,
    readRate: delivered ? Math.round((read / delivered) * 1000) / 10 : 0,
    recentFailures,
  }
}
