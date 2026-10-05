import { prisma } from "@/lib/db"
import { z } from "zod"
import { STAFF_ROLES, USER_ROLES } from "@/lib/roles"
import { decryptSecretValue, encryptSecretValue } from "@/lib/secret-crypto"
import {
  DEFAULT_CUSTOM_CONFIGURATION_SETTINGS,
  normalizeCustomConfigurationSettings,
  type CustomConfigurationSettings,
} from "@/lib/custom-configuration-pricing"
import {
  DEFAULT_BILLING_PRICING_SETTINGS,
  billingPricingSettingsSchema,
  type BillingPricingSettings,
} from "@/lib/billing-pricing"
import {
  DEFAULT_BACKUP_SERVICE_SETTINGS,
  DEFAULT_CREDIT_SETTINGS,
  DEFAULT_SNAPSHOT_SERVICE_SETTINGS,
  backupServiceSettingsSchema,
  creditSettingsSchema,
  snapshotServiceSettingsSchema,
} from "@/lib/billing/feature-settings"
import { configuredSiteDomain, publicOrigin, requirePublicOrigin } from "@/lib/public-url"
import { reinstallPolicySettingsSchema, type ReinstallPolicySettings } from "@/lib/reinstall-policy"

const categoryKeys = [
  "general_settings",
  "smtp_settings",
  "payment_settings",
  "security_settings",
  "platform_settings",
  "appearance_settings",
  "console_settings",
  "custom_configuration_settings",
  "billing_pricing_settings",
  "provisioning_settings",
  "marketing_cloud_comparison_settings",
  "backup_service_settings",
  "snapshot_service_settings",
  "credit_settings",
  "reinstall_policy_settings",
] as const

export type SettingsCategoryKey = (typeof categoryKeys)[number]

const defaultSiteDomain = () => configuredSiteDomain() || "example.com"
const defaultSiteUrl = () => publicOrigin() || "https://example.com"
const defaultSupportEmail = () => `support@${defaultSiteDomain()}`
const defaultAppName = () => process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || "Cloud"
const defaultLegalCompanyName = () => process.env.NEXT_PUBLIC_LEGAL_COMPANY_NAME || process.env.LEGAL_COMPANY_NAME || `${defaultAppName()} Services`
const skipSettingsDatabaseReads = () => process.env.ZWS_SKIP_SETTINGS_DB_DURING_BUILD === "1"
const optionalEmailSchema = z.string().trim().email().or(z.literal(""))
const optionalUrlSchema = z.string().trim().url().or(z.literal(""))
const assetUrlSchema = z.string().trim().refine((value) => {
  if (!value) return true
  if (/^https?:\/\//i.test(value)) return z.string().url().safeParse(value).success
  return value.startsWith("/") && !value.startsWith("//")
}, "Use a valid URL or site-relative path.")
const phoneSchema = z.string().trim().regex(/^$|^[+\d][+\d\s().-]{5,31}$/i, "Use a valid phone number.").default("")
const socialUrlSchema = optionalUrlSchema.default("")

export const generalSettingsSchema = z.object({
  version: z.number().default(1),
  companyName: z.string().trim().min(1).default(defaultAppName),
  brandName: z.string().default(defaultAppName),
  legalCompanyName: z.string().default(defaultLegalCompanyName),
  websiteName: z.string().trim().default(""),
  tagline: z.string().trim().default(""),
  registrationNumber: z.string().trim().default(""),
  gstNumber: z.string().trim().default(""),
  vatNumber: z.string().trim().default(""),
  companyEmail: z.string().email().default(defaultSupportEmail),
  supportEmail: z.string().email().default(defaultSupportEmail),
  salesEmail: optionalEmailSchema.default(""),
  billingEmail: optionalEmailSchema.default(""),
  abuseEmail: optionalEmailSchema.default(""),
  companyPhone: phoneSchema,
  supportPhone: phoneSchema,
  phoneNumber: phoneSchema,
  whatsappNumber: phoneSchema,
  telegramUsername: z.string().trim().default(""),
  companyAddress: z.string().default(""),
  addressLine1: z.string().trim().default(""),
  addressLine2: z.string().trim().default(""),
  city: z.string().trim().default(""),
  state: z.string().trim().default(""),
  zipCode: z.string().trim().default(""),
  country: z.string().trim().default(""),
  logoUrl: assetUrlSchema.default(""),
  footerLogoUrl: assetUrlSchema.default(""),
  invoiceLogoUrl: assetUrlSchema.default(""),
  openGraphImageUrl: assetUrlSchema.default(""),
  defaultCurrency: z.string().min(1).default("INR"),
  timezone: z.string().default("Asia/Kolkata"),
  siteDomain: z.string().default(defaultSiteDomain),
  siteUrl: z.string().default(defaultSiteUrl),
  clientAreaUrl: z.string().default(() => `${defaultSiteUrl()}/client-area`),
  supportUrl: z.string().default(""),
  ticketSystemUrl: z.string().default(""),
  termsUrl: optionalUrlSchema.default(""),
  tosUrl: z.string().default(""),
  privacyUrl: optionalUrlSchema.default(""),
  refundPolicyUrl: optionalUrlSchema.default(""),
  refundUrl: z.string().default(""),
  abusePolicyUrl: optionalUrlSchema.default(""),
  footerDescription: z.string().default("Professional cloud infrastructure and compute automation."),
  footerCopyrightText: z.string().trim().default(""),
  publicContactBox: z.string().trim().default(""),
  facebookUrl: socialUrlSchema,
  instagramUrl: socialUrlSchema,
  twitterUrl: socialUrlSchema,
  telegramUrl: socialUrlSchema,
  whatsappLink: socialUrlSchema,
  discordUrl: socialUrlSchema,
  youtubeUrl: socialUrlSchema,
  metaTitle: z.string().trim().max(180).default(""),
  metaDescription: z.string().trim().max(320).default(""),
  metaKeywords: z.string().trim().max(500).default(""),
  googleAnalyticsId: z.string().trim().max(40).default(""),
  defaultMetaTitle: z.string().trim().max(180).default(""),
  defaultMetaDescription: z.string().trim().max(320).default(""),
  robots: z.string().trim().default("index, follow"),
  sitemapEnabled: z.boolean().default(true),
  senderName: z.string().trim().default(""),
  senderEmail: optionalEmailSchema.default(""),
  founderEnabled: z.boolean().default(false),
  founderName: z.string().default(""),
  founderAge: z.coerce.number().int().min(0).max(130).optional().or(z.literal("")).default(""),
  founderPhotoUrl: z.string().url().or(z.literal("")).default(""),
  founderTitle: z.string().default(""),
  founderExperienceYears: z.coerce.number().int().min(0).max(80).optional().or(z.literal("")).default(""),
  founderSpecialties: z.string().default(""),
  founderShortBio: z.string().default(""),
  founderLongDescription: z.string().default(""),
  founderLinkedInUrl: z.string().url().or(z.literal("")).default(""),
  founderXUrl: z.string().url().or(z.literal("")).default(""),
  founderEmail: z.string().email().or(z.literal("")).default(""),
  founderLocation: z.string().default(""),
  aboutCompanyHeadline: z.string().default(""),
  aboutCompanyDescription: z.string().default(""),
  missionStatement: z.string().default(""),
  visionStatement: z.string().default(""),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const smtpSettingsSchema = z.object({
  version: z.number().default(1),
  enabled: z.boolean().default(true),
  provider: z.enum(["hostinger", "custom", "gmail", "ses", "mailgun", "resend"]).default("custom"),
  mailFromName: z.string().default(defaultAppName),
  mailFromAddress: z.string().email().default(() => `noreply@${defaultSiteDomain()}`),
  replyTo: z.string().email().or(z.literal("")).default(""),
  testEmailRecipient: z.string().email().or(z.literal("")).default(""),
  host: z.string().default(""),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  username: z.string().default(""),
  password: z.string().default(""),
  encryption: z.preprocess((value) => {
    const normalized = String(value || "").toLowerCase()
    if (normalized === "ssl") return "ssl_tls"
    if (normalized === "tls") return "starttls"
    return value
  }, z.enum(["none", "ssl_tls", "starttls"]).default("starttls")),
  supportFromAddress: z.string().email().or(z.literal("")).default(""),
  billingFromAddress: z.string().email().or(z.literal("")).default(""),
  accountsFromAddress: z.string().email().or(z.literal("")).default(""),
  adminFromAddress: z.string().email().or(z.literal("")).default(""),
  smtpLastTestStatus: z.enum(["success", "failed", "not_tested"]).default("not_tested"),
  smtpLastTestAt: z.string().optional().default(""),
  smtpLastErrorCode: z.string().optional().default(""),
  smtpLastErrorMessage: z.string().optional().default(""),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const paymentSettingsSchema = z.object({
  version: z.number().default(1),
  cashfreeEnabled: z.boolean().default(true),
  phonepeEnabled: z.boolean().default(false),
  manualPaymentEnabled: z.boolean().default(false),
  paymentMode: z.enum(["mock", "sandbox", "production"]).default("sandbox"),
  gatewayDisplayName: z.string().default("Cashfree"),
  gatewayPriority: z.enum(["cashfree_first", "phonepe_first", "phonepe_only", "cashfree_only", "manual_only"]).default("phonepe_first"),
  defaultGateway: z.enum(["cashfree", "phonepe", "manual"]).default("phonepe"),
  allowFallbackGateway: z.boolean().default(true),
  paymentBypassTestMode: z.boolean().default(false),
  allowProductionEndpointInTest: z.boolean().default(false),
  cashfreeAppId: z.string().default(""),
  cashfreeSecretKey: z.string().default(""),
  cashfreeWebhookSecret: z.string().default(""),
  cashfreeApiVersion: z.string().default("2023-08-01"),
  cashfreeEnvironment: z.preprocess(
    (value) => String(value || "sandbox").toLowerCase() === "test" ? "sandbox" : value,
    z.enum(["sandbox", "production"]).default("sandbox"),
  ),
  phonepeMerchantId: z.string().default(""),
  phonepeClientId: z.string().default(""),
  phonepeClientSecret: z.string().default(""),
  phonepeWebhookSecret: z.string().default(""),
  phonepeWebhookUsername: z.string().default(""),
  phonepeWebhookPassword: z.string().default(""),
  phonepeEnvironment: z.enum(["sandbox", "production"]).default("sandbox"),
  phonepeApiVersion: z.string().default("pg-v1"),
  phonepeIntegrationType: z.string().default("pay-page"),
  phonepeCallbackUrl: z.string().default(""),
  phonepeWebhookUrl: z.string().default(""),
  cashfreeCallbackUrl: z.string().default(""),
  cashfreeWebhookUrl: z.string().default(""),
  defaultPaymentBehavior: z.enum(["gateway_first", "manual_only", "hybrid"]).default("gateway_first"),
  allowWalletPayments: z.boolean().default(true),
  walletTopupMinimumAmount: z.coerce.number().min(0).default(10),
  autoCreateInvoiceOnPaymentSuccess: z.boolean().default(true),
  autoProvisionOnPaymentSuccess: z.boolean().default(true),
  requireManualVerification: z.boolean().default(false),
  paymentNotifyEmail: z.string().email().or(z.literal("")).default(""),
  autoInvoice: z.boolean().default(true),
  gstRate: z.coerce.number().min(0).max(100).default(18),
  invoicePrefix: z.string().default("INV"),
  invoiceFooterText: z.string().default(""),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const securitySettingsSchema = z.object({
  version: z.number().default(1),
  minPasswordLength: z.coerce.number().int().min(8).max(64).default(8),
  requireNumber: z.boolean().default(true),
  requireUppercase: z.boolean().default(false),
  requireSpecialChar: z.boolean().default(false),
  sessionTimeoutMinutes: z.coerce.number().int().min(5).max(43200).default(43200),
  logoutScope: z.enum(["current", "all"]).default("current"),
  maxLoginAttempts: z.coerce.number().int().min(1).max(20).default(5),
  lockoutDurationMinutes: z.coerce.number().int().min(1).max(1440).default(15),
  allowedAdminRoles: z.array(z.enum(STAFF_ROLES)).default(["super_admin", "admin", "support_agent", "seo_agent"]),
  require2faAdmin: z.boolean().default(false),
  ipWhitelistAdmin: z.string().default(""),
  enableSshCheckoutOptions: z.boolean().default(false),
  auditLogRetentionDays: z.coerce.number().int().min(7).max(3650).default(365),
  requirePhoneVerificationOnLogin: z.boolean().default(false),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const platformSettingsSchema = z.object({
  version: z.number().default(1),
  appName: z.string().trim().min(1, "App name is required").default(defaultAppName),
  brandName: z.string().trim().min(1, "Brand name is required").default(defaultAppName),
  environmentLabel: z.string().default("Production"),
  environmentMode: z.enum(["test", "production"]).default("test"),
  allowRegistration: z.boolean().default(true),
  defaultUserRole: z.enum(USER_ROLES).default("client"),
  notifyOnNewRegistration: z.boolean().default(true),
  notifyOnPayment: z.boolean().default(true),
  googleAnalyticsEnabled: z.boolean().default(false),
  googleAnalyticsMeasurementId: z.string().trim().max(40).default(""),
  googleAnalyticsInAdmin: z.boolean().default(false),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const customConfigurationSettingsSchema = z.object({
  version: z.number().default(1),
  enableCustomConfiguration: z.boolean().default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.enableCustomConfiguration),
  currency: z.string().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.currency),
  vcpuPricePerCoreInr: z.coerce.number().min(0).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.vcpuPricePerCoreInr),
  ramPricePerGbInr: z.coerce.number().min(0).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.ramPricePerGbInr),
  nvmeStoragePricePerGbInr: z.coerce.number().min(0).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.nvmeStoragePricePerGbInr),
  ssdStoragePricePerGbInr: z.coerce.number().min(0).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.ssdStoragePricePerGbInr),
  bandwidthPricePerTbInr: z.coerce.number().min(0).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.bandwidthPricePerTbInr),
  minimumVcpu: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.minimumVcpu),
  maximumVcpu: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.maximumVcpu),
  defaultVcpu: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultVcpu),
  minimumRamGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.minimumRamGb),
  maximumRamGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.maximumRamGb),
  defaultRamGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultRamGb),
  minimumStorageGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.minimumStorageGb),
  maximumStorageGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.maximumStorageGb),
  defaultStorageGb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultStorageGb),
  minimumBandwidthTb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.minimumBandwidthTb),
  maximumBandwidthTb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.maximumBandwidthTb),
  defaultBandwidthTb: z.coerce.number().int().min(1).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultBandwidthTb),
  maximumDisks: z.coerce.number().int().min(1).max(20).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.maximumDisks),
  defaultRegion: z.string().default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultRegion),
  defaultOs: z.string().default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.defaultOs),
  taxPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.taxPercent),
  monthlyDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.monthlyDiscountPercent),
  threeMonthDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.threeMonthDiscountPercent),
  sixMonthDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.sixMonthDiscountPercent),
  twelveMonthDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.twelveMonthDiscountPercent),
  twentyFourMonthDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.twentyFourMonthDiscountPercent),
  thirtySixMonthDiscountPercent: z.coerce.number().min(0).max(100).default(DEFAULT_CUSTOM_CONFIGURATION_SETTINGS.thirtySixMonthDiscountPercent),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
}).superRefine((value, ctx) => {
  const checks: Array<[number, number, string]> = [
    [value.minimumVcpu, value.maximumVcpu, "maximumVcpu"],
    [value.minimumRamGb, value.maximumRamGb, "maximumRamGb"],
    [value.minimumStorageGb, value.maximumStorageGb, "maximumStorageGb"],
    [value.minimumBandwidthTb, value.maximumBandwidthTb, "maximumBandwidthTb"],
  ]
  for (const [min, max, path] of checks) {
    if (max < min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Maximum must be greater than or equal to minimum" })
    }
  }
})

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a HEX color like #14b8a6")

export const appearanceSettingsSchema = z.object({
  version: z.number().default(1),
  logoUrl: assetUrlSchema.default(""),
  faviconUrl: assetUrlSchema.default(""),
  footerLogoUrl: assetUrlSchema.default(""),
  invoiceLogoUrl: assetUrlSchema.default(""),
  openGraphImageUrl: assetUrlSchema.default(""),
  primaryAccent: z.string().default("teal"),
  primaryColor: hexColorSchema.default("#e5e7eb"),
  secondaryColor: hexColorSchema.default("#0f172a"),
  accentColor: hexColorSchema.default("#14b8a6"),
  successColor: hexColorSchema.default("#22c55e"),
  dangerColor: hexColorSchema.default("#ef4444"),
  warningColor: hexColorSchema.default("#f59e0b"),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const consoleSettingsSchema = z.object({
  version: z.number().default(1),
  globalConsoleEnabled: z.boolean().default(true),
  linuxTerminalEnabled: z.boolean().default(true),
  graphicalConsoleEnabled: z.boolean().default(true),
  allowSuspendedConsole: z.boolean().default(false),
  defaultConsoleType: z.enum(["auto", "novnc", "xtermjs"]).default("auto"),
  templateGroupConsoleTypes: z.record(z.enum(["auto", "novnc", "xtermjs"])).default({}),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const provisioningSettingsSchema = z.object({
  version: z.number().default(1),
  autoProvisioningEnabled: z.boolean().default(true),
  requestRateLimitPerMinute: z.coerce.number().int().min(10).max(10000).default(600),
  adminRateLimitPerMinute: z.coerce.number().int().min(10).max(10000).default(1200),
  nodeRateLimitPerMinute: z.coerce.number().int().min(1).max(10000).default(120),
  apiRateLimitPerMinute: z.coerce.number().int().min(10).max(10000).default(900),
  allowProvisioningFailover: z.boolean().default(true),
  preserveIpOnCompatibleReinstall: z.boolean().default(true),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export const marketingCloudComparisonSettingsSchema = z.object({
  version: z.number().default(1),
  zwsIncludedBandwidthText: z.string().default("Predictable bandwidth included with every cloud instance. Traffic quota included upfront — no surprise egress billing."),
  savingPercentageHeadline: z.string().default("Save up to 60% with fixed monthly pricing"),
  example1Label: z.string().default("2 vCPU, 8GB RAM, 100GB NVMe, 3TB bandwidth"),
  example1BandwidthGb: z.coerce.number().min(0).default(3072),
  example1ZwsFixedPrice: z.coerce.number().min(0).default(2499),
  example1AwsVmMonthlyCost: z.coerce.number().min(0).default(4200),
  example1AzureVmMonthlyCost: z.coerce.number().min(0).default(4400),
  example1GcpVmMonthlyCost: z.coerce.number().min(0).default(4300),
  example2Label: z.string().default("6 vCPU, 32GB RAM, 400GB NVMe, 10TB bandwidth"),
  example2BandwidthGb: z.coerce.number().min(0).default(10240),
  example2ZwsFixedPrice: z.coerce.number().min(0).default(8499),
  example2AwsVmMonthlyCost: z.coerce.number().min(0).default(16500),
  example2AzureVmMonthlyCost: z.coerce.number().min(0).default(17100),
  example2GcpVmMonthlyCost: z.coerce.number().min(0).default(16800),
  example3Label: z.string().default("Custom Cloud Instance with high traffic"),
  example3BandwidthGb: z.coerce.number().min(0).default(20480),
  example3ZwsFixedPrice: z.coerce.number().min(0).default(14999),
  example3AwsVmMonthlyCost: z.coerce.number().min(0).default(26500),
  example3AzureVmMonthlyCost: z.coerce.number().min(0).default(27200),
  example3GcpVmMonthlyCost: z.coerce.number().min(0).default(26900),
  awsEgressCostPerGb: z.coerce.number().min(0).default(7.5),
  azureEgressCostPerGb: z.coerce.number().min(0).default(7.2),
  gcpEgressCostPerGb: z.coerce.number().min(0).default(7.8),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

const schemaByCategory = {
  general_settings: generalSettingsSchema,
  smtp_settings: smtpSettingsSchema,
  payment_settings: paymentSettingsSchema,
  security_settings: securitySettingsSchema,
  platform_settings: platformSettingsSchema,
  appearance_settings: appearanceSettingsSchema,
  console_settings: consoleSettingsSchema,
  custom_configuration_settings: customConfigurationSettingsSchema,
  billing_pricing_settings: billingPricingSettingsSchema,
  provisioning_settings: provisioningSettingsSchema,
  marketing_cloud_comparison_settings: marketingCloudComparisonSettingsSchema,
  backup_service_settings: backupServiceSettingsSchema,
  snapshot_service_settings: snapshotServiceSettingsSchema,
  credit_settings: creditSettingsSchema,
  reinstall_policy_settings: reinstallPolicySettingsSchema,
} as const

export type GeneralSettings = z.infer<typeof generalSettingsSchema>
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>
export type SecuritySettings = z.infer<typeof securitySettingsSchema>
export type PlatformSettings = z.infer<typeof platformSettingsSchema>
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>
export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>
export type ProvisioningSettings = z.infer<typeof provisioningSettingsSchema>
export type { CustomConfigurationSettings }
export type { BillingPricingSettings }
export type MarketingCloudComparisonSettings = z.infer<typeof marketingCloudComparisonSettingsSchema>
export type BackupServiceSettings = z.infer<typeof backupServiceSettingsSchema>
export type SnapshotServiceSettings = z.infer<typeof snapshotServiceSettingsSchema>
export type CreditSettings = z.infer<typeof creditSettingsSchema>
export type { ReinstallPolicySettings }

type CacheEntry = { expiresAt: number; value: unknown }
const cache = new Map<string, CacheEntry>()
const CACHE_MS = 0
const MASKED_SECRET = "__MASKED__"

const appSettingGroups = {
  mail: "mail",
  payments: "payments",
  customConfiguration: "custom_configuration",
  billingPricing: "billing_pricing",
} as const

const mailSecretFields = new Set<keyof SmtpSettings>(["password"])
const paymentSecretFields = new Set<keyof PaymentSettings>([
  "cashfreeSecretKey",
  "cashfreeWebhookSecret",
  "phonepeClientSecret",
  "phonepeWebhookSecret",
  "phonepeWebhookPassword",
])

const mailDefaults = smtpSettingsSchema.parse({})
const paymentDefaults = paymentSettingsSchema.parse({})
const customConfigurationDefaults = DEFAULT_CUSTOM_CONFIGURATION_SETTINGS
const billingPricingDefaults = DEFAULT_BILLING_PRICING_SETTINGS
const backupServiceDefaults = DEFAULT_BACKUP_SERVICE_SETTINGS
const snapshotServiceDefaults = DEFAULT_SNAPSHOT_SERVICE_SETTINGS
const creditDefaults = DEFAULT_CREDIT_SETTINGS
const generalDefaults = generalSettingsSchema.parse({})
const platformDefaults = platformSettingsSchema.parse({})
const appearanceDefaults = appearanceSettingsSchema.parse({})

function appSettingKey(group: string, field: string) {
  return `${group}.${field}`
}

export function clearSettingsCache(category?: SettingsCategoryKey) {
  if (category) {
    cache.delete(`settings:${category}`)
    return
  }
  cache.clear()
}

export function maskSecret(value: unknown) {
  const raw = String(value || "")
  if (!raw) return ""
  return raw.length > 4 ? `••••••••${raw.slice(-4)}` : MASKED_SECRET
}

export function maskAdminSecrets<T extends Record<string, any>>(category: SettingsCategoryKey, value: T): T {
  const copy: Record<string, any> = { ...value }
  if (category === "smtp_settings") {
    for (const field of mailSecretFields) copy[String(field)] = maskSecret(copy[String(field)])
  }
  if (category === "payment_settings") {
    for (const field of paymentSecretFields) copy[String(field)] = maskSecret(copy[String(field)])
  }
  return copy as T
}

function unmaskLike(value: unknown) {
  const text = String(value || "")
  return text === MASKED_SECRET || text.startsWith("••••")
}

function mergeMaskedSecrets<T extends Record<string, any>>(
  incoming: Record<string, any>,
  previous: T,
  secretFields: Set<keyof T>,
) {
  const next = { ...incoming }
  for (const field of secretFields) {
    const key = String(field)
    if (unmaskLike(next[key]) || next[key] === "") {
      next[key] = previous[key] || ""
    }
  }
  return next
}

function legacyCategoryForGroup(group: string): SettingsCategoryKey | null {
  if (group === appSettingGroups.mail) return "smtp_settings"
  if (group === appSettingGroups.payments) return "payment_settings"
  return null
}

async function getLegacyAdminSetting(category: SettingsCategoryKey) {
  if (skipSettingsDatabaseReads()) return null
  const row = await prisma.adminSetting.findUnique({ where: { key: category } }).catch(() => null)
  return row?.value ?? null
}

async function getAppSettingObject(group: keyof typeof appSettingGroups) {
  if (skipSettingsDatabaseReads()) return null
  const groupName = appSettingGroups[group]
  const rows = await prisma.appSetting.findMany({ where: { group: groupName } }).catch(() => [])
  if (!rows.length) {
    const legacyCategory = legacyCategoryForGroup(groupName)
    if (legacyCategory) return getLegacyAdminSetting(legacyCategory)
    return null
  }

  return Object.fromEntries(
    rows.map((row) => {
      const field = row.key.replace(`${groupName}.`, "")
      const legacyCategory = legacyCategoryForGroup(groupName)
      const shouldDecrypt = Boolean(row.isSecret || legacyCategory === "smtp_settings" && mailSecretFields.has(field as keyof SmtpSettings) || legacyCategory === "payment_settings" && paymentSecretFields.has(field as keyof PaymentSettings))
      return [field, shouldDecrypt ? decryptSecretValue(String(row.value || "")) : row.value]
    }),
  )
}

async function writeAppSettingObject(
  group: keyof typeof appSettingGroups,
  value: Record<string, unknown>,
  secretFields: Set<string>,
  updatedBy?: string,
) {
  const groupName = appSettingGroups[group]
  const writes = Object.entries(value).map(([field, fieldValue]) => prisma.appSetting.upsert({
    where: { key: appSettingKey(groupName, field) },
    update: {
      value: (secretFields.has(field) ? encryptSecretValue(String(fieldValue || "")) : fieldValue) as any,
      group: groupName,
      isSecret: secretFields.has(field),
      updatedBy: updatedBy || null,
    },
    create: {
      key: appSettingKey(groupName, field),
      value: (secretFields.has(field) ? encryptSecretValue(String(fieldValue || "")) : fieldValue) as any,
      group: groupName,
      isSecret: secretFields.has(field),
      updatedBy: updatedBy || null,
    },
  }))
  await Promise.all(writes)
}

function readCache<T>(key: string): T | null {
  if (CACHE_MS <= 0) return null
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value as T
}

function writeCache(key: string, value: unknown): void {
  if (CACHE_MS <= 0) return
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS })
}

function sanitizeSettingsValue(category: SettingsCategoryKey, value: unknown) {
  if (category !== "security_settings") {
    return value
  }

  const input = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}

  const allowedAdminRoles = Array.isArray(input.allowedAdminRoles)
    ? input.allowedAdminRoles.filter((role): role is (typeof STAFF_ROLES)[number] => STAFF_ROLES.includes(String(role) as (typeof STAFF_ROLES)[number]))
    : undefined

  delete input.twoFactorEnabled
  delete input.twoFactorCode

  return {
    ...input,
    allowedAdminRoles: allowedAdminRoles && allowedAdminRoles.length ? allowedAdminRoles : ["super_admin", "admin", "support_agent", "seo_agent"],
  }
}

export function validateSettingsByCategory(category: SettingsCategoryKey, value: unknown) {
  const parsed = schemaByCategory[category].parse(sanitizeSettingsValue(category, value))
  if (category === "payment_settings") validatePaymentSettings(parsed as PaymentSettings)
  if (category === "custom_configuration_settings") {
    return normalizeCustomConfigurationSettings(parsed as CustomConfigurationSettings)
  }
  return parsed
}

export function validatePaymentSettings(settings: PaymentSettings) {
  const envMode = String((settings as any).environmentMode || "").toLowerCase()
  if (settings.phonepeEnvironment === "production" && envMode === "test" && !settings.allowProductionEndpointInTest) {
    throw new Error("PhonePe production endpoint cannot be used while global environment mode is Test.")
  }
  if (settings.cashfreeEnvironment === "production" && envMode === "test" && !settings.allowProductionEndpointInTest) {
    throw new Error("Cashfree production endpoint cannot be used while global environment mode is Test.")
  }
  if (envMode === "production") {
    if (settings.paymentBypassTestMode) {
      throw new Error("Payment bypass/test mode cannot be enabled in Production.")
    }
  }
}

async function getSettingRaw(category: SettingsCategoryKey): Promise<unknown | null> {
  if (skipSettingsDatabaseReads()) return null

  if (category === "smtp_settings") {
    return getAppSettingObject("mail")
  }
  if (category === "payment_settings") {
    return getAppSettingObject("payments")
  }
  if (category === "custom_configuration_settings") {
    return getAppSettingObject("customConfiguration")
  }
  if (category === "billing_pricing_settings") {
    return getAppSettingObject("billingPricing")
  }

  const row = await prisma.adminSetting.findUnique({ where: { key: category } })
  return row?.value ?? null
}

export async function getSetting<T>(category: SettingsCategoryKey, fallback?: T): Promise<T> {
  const cacheKey = `settings:${category}`
  const cached = readCache<T>(cacheKey)
  if (cached) return cached

  const raw = await getSettingRaw(category)
  const parsed = schemaByCategory[category].parse(raw ?? fallback ?? {}) as T
  const value = category === "custom_configuration_settings"
    ? normalizeCustomConfigurationSettings(parsed as CustomConfigurationSettings) as T
    : category === "platform_settings"
      ? validateSettingsByCategory(category, parsed) as T
      : parsed
  writeCache(cacheKey, value)
  return value
}

export async function getMailSettings(): Promise<SmtpSettings> {
  return getSetting<SmtpSettings>("smtp_settings")
}

export async function getPaymentSettings(): Promise<PaymentSettings> {
  return getSetting<PaymentSettings>("payment_settings")
}

export async function getCustomConfigurationSettings(): Promise<CustomConfigurationSettings> {
  return getSetting<CustomConfigurationSettings>("custom_configuration_settings", customConfigurationDefaults)
}

export async function getBillingPricingSettings(): Promise<BillingPricingSettings> {
  return getSetting<BillingPricingSettings>("billing_pricing_settings", billingPricingDefaults)
}

export async function getBackupServiceSettings(): Promise<BackupServiceSettings> {
  return getSetting<BackupServiceSettings>("backup_service_settings", backupServiceDefaults)
}

export async function getSnapshotServiceSettings(): Promise<SnapshotServiceSettings> {
  return getSetting<SnapshotServiceSettings>("snapshot_service_settings", snapshotServiceDefaults)
}

export async function getCreditSettings(): Promise<CreditSettings> {
  return getSetting<CreditSettings>("credit_settings", creditDefaults)
}

export async function getAdminSettings(group: "mail" | "payments") {
  if (group === "mail") return maskAdminSecrets("smtp_settings", await getMailSettings())
  return maskAdminSecrets("payment_settings", await getPaymentSettings())
}

export async function updateAdminSettings(group: "mail" | "payments", payload: unknown, updatedBy?: string) {
  if (group === "mail") {
    const previous = await getMailSettings()
    const merged = mergeMaskedSecrets(
      payload && typeof payload === "object" ? payload as Record<string, any> : {},
      previous,
      mailSecretFields as Set<keyof SmtpSettings>,
    )
    const parsed = smtpSettingsSchema.parse({
      ...mailDefaults,
      ...previous,
      ...merged,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy || "system",
    })
    await writeAppSettingObject("mail", parsed as any, new Set(Array.from(mailSecretFields, String)), updatedBy)
    await Promise.all([
      setFlatSetting("email_support", String(parsed.supportFromAddress || parsed.mailFromAddress || "")),
      setFlatSetting("email_billing", String(parsed.billingFromAddress || parsed.mailFromAddress || "")),
      setFlatSetting("email_noreply", String(parsed.mailFromAddress || "")),
      setFlatSetting("email_accounts", String(parsed.accountsFromAddress || parsed.mailFromAddress || "")),
      setFlatSetting("email_admin", String(parsed.adminFromAddress || parsed.mailFromAddress || "")),
    ])
    clearSettingsCache("smtp_settings")
    writeCache("settings:smtp_settings", parsed)
    return { key: "smtp_settings", value: parsed }
  }

  const previous = await getPaymentSettings()
  const merged = mergeMaskedSecrets(
    payload && typeof payload === "object" ? payload as Record<string, any> : {},
    previous,
    paymentSecretFields as Set<keyof PaymentSettings>,
  )
  const parsed = paymentSettingsSchema.parse({
    ...paymentDefaults,
    ...previous,
    ...merged,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || "system",
  })
  validatePaymentSettings({ ...parsed, environmentMode: (await getSetting<PlatformSettings>("platform_settings")).environmentMode } as any)
  await writeAppSettingObject("payments", parsed as any, new Set(Array.from(paymentSecretFields, String)), updatedBy)
  clearSettingsCache("payment_settings")
  writeCache("settings:payment_settings", parsed)
  return { key: "payment_settings", value: parsed }
}

export async function getAllSettings() {
  const [general, smtp, payment, security, platform, appearance, console, customConfiguration, billingPricing, backupService, snapshotService, credit, marketingCloudComparison] = await Promise.all([
    getSetting<GeneralSettings>("general_settings"),
    getSetting<SmtpSettings>("smtp_settings"),
    getSetting<PaymentSettings>("payment_settings"),
    getSetting<SecuritySettings>("security_settings"),
    getSetting<PlatformSettings>("platform_settings"),
    getSetting<AppearanceSettings>("appearance_settings"),
    getSetting<ConsoleSettings>("console_settings"),
    getCustomConfigurationSettings(),
    getBillingPricingSettings(),
    getBackupServiceSettings(),
    getSnapshotServiceSettings(),
    getCreditSettings(),
    getSetting<MarketingCloudComparisonSettings>("marketing_cloud_comparison_settings"),
  ])

  return { general, smtp, payment, security, platform, appearance, console, customConfiguration, billingPricing, backupService, snapshotService, credit, marketingCloudComparison }
}

export async function upsertSetting(
  category: SettingsCategoryKey,
  value: unknown,
  updatedBy?: string,
) {
  if (category === "smtp_settings") {
    return updateAdminSettings("mail", value, updatedBy)
  }
  if (category === "payment_settings") {
    return updateAdminSettings("payments", value, updatedBy)
  }
  if (category === "custom_configuration_settings") {
    const parsed = normalizeCustomConfigurationSettings(
      customConfigurationSettingsSchema.parse({
        ...customConfigurationDefaults,
        ...(value && typeof value === "object" ? value : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || "system",
      }) as CustomConfigurationSettings,
    )
    await writeAppSettingObject("customConfiguration", parsed as any, new Set(), updatedBy)
    clearSettingsCache(category)
    writeCache(`settings:${category}`, parsed)
    return { key: category, value: parsed }
  }
  if (category === "billing_pricing_settings") {
    const parsed = billingPricingSettingsSchema.parse({
      ...billingPricingDefaults,
      ...(value && typeof value === "object" ? value : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy || "system",
    })
    await writeAppSettingObject("billingPricing", parsed as any, new Set(), updatedBy)
    clearSettingsCache(category)
    writeCache(`settings:${category}`, parsed)
    return { key: category, value: parsed }
  }

  const parsed = validateSettingsByCategory(category, value) as Record<string, unknown>
  const payload = {
    ...parsed,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || "system",
  }

  const saved = await prisma.adminSetting.upsert({
    where: { key: category },
    update: {
      value: payload as any,
      updatedBy: updatedBy || null,
    },
    create: {
      key: category,
      value: payload as any,
      updatedBy: updatedBy || null,
      description: `Settings for ${category}`,
    },
  })

  clearSettingsCache(category)
  writeCache(`settings:${category}`, payload)

  if (category === "general_settings") {
    const general = payload as Record<string, unknown>
    const writes = [
      setFlatSetting("site_domain", String(general.siteDomain || "")),
      setFlatSetting("support_url", String(general.supportUrl || "")),
      setFlatSetting("ticket_system_url", String(general.ticketSystemUrl || "")),
    ]
    await Promise.all(writes)
  }

  return saved
}

export type BrandSettings = {
  appName: string
  brandName: string
  legalCompanyName: string
  websiteName: string
  tagline: string
  registrationNumber: string
  siteUrl: string
  clientAreaUrl: string
  supportEmail: string
  salesEmail: string
  billingEmail: string
  abuseEmail: string
  logoUrl: string
  faviconUrl: string
  footerLogoUrl: string
  invoiceLogoUrl: string
  openGraphImageUrl: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  successColor: string
  dangerColor: string
  warningColor: string
  footerDescription: string
  footerCopyrightText: string
  publicContactBox: string
  companyAddress: string
  gstNumber: string
  vatNumber: string
  phoneNumber: string
  whatsappNumber: string
  telegramUsername: string
  environmentMode: "test" | "production"
  allowRegistration: boolean
  notifyOnNewRegistration: boolean
  notifyOnPayment: boolean
}

export async function getBrandSettings(): Promise<BrandSettings> {
  try {
    const [general, platform, appearance] = await Promise.all([
      getSetting<GeneralSettings>("general_settings"),
      getSetting<PlatformSettings>("platform_settings"),
      getSetting<AppearanceSettings>("appearance_settings"),
    ])
    const appName = platform.appName || general.brandName || general.companyName || defaultAppName()
    return {
      appName,
      brandName: platform.brandName || general.brandName || appName,
      legalCompanyName: general.legalCompanyName || general.companyName || appName,
      websiteName: general.websiteName || platform.appName || appName,
      tagline: general.tagline || "",
      registrationNumber: general.registrationNumber || "",
      siteUrl: requirePublicOrigin(),
      clientAreaUrl: `${requirePublicOrigin()}/client-area`,
      supportEmail: general.supportEmail || general.companyEmail,
      salesEmail: general.salesEmail || general.companyEmail,
      billingEmail: general.billingEmail || general.companyEmail,
      abuseEmail: general.abuseEmail || general.supportEmail || general.companyEmail,
      logoUrl: appearance.logoUrl || general.logoUrl,
      faviconUrl: appearance.faviconUrl,
      footerLogoUrl: appearance.footerLogoUrl || general.footerLogoUrl || appearance.logoUrl || general.logoUrl,
      invoiceLogoUrl: appearance.invoiceLogoUrl || general.invoiceLogoUrl || appearance.logoUrl || general.logoUrl,
      openGraphImageUrl: appearance.openGraphImageUrl || general.openGraphImageUrl || appearance.logoUrl || general.logoUrl,
      primaryColor: appearance.primaryColor,
      secondaryColor: appearance.secondaryColor,
      accentColor: appearance.accentColor,
      successColor: appearance.successColor,
      dangerColor: appearance.dangerColor,
      warningColor: appearance.warningColor,
      footerDescription: general.footerDescription,
      footerCopyrightText: general.footerCopyrightText,
      publicContactBox: general.publicContactBox,
      companyAddress: general.companyAddress,
      gstNumber: general.gstNumber,
      vatNumber: general.vatNumber,
      phoneNumber: general.phoneNumber || general.companyPhone,
      whatsappNumber: general.whatsappNumber,
      telegramUsername: general.telegramUsername,
      environmentMode: platform.environmentMode,
      allowRegistration: platform.allowRegistration,
      notifyOnNewRegistration: platform.notifyOnNewRegistration,
      notifyOnPayment: platform.notifyOnPayment,
    }
  } catch {
    return {
      appName: platformDefaults.appName,
      brandName: platformDefaults.brandName,
      legalCompanyName: generalDefaults.legalCompanyName,
      websiteName: generalDefaults.websiteName,
      tagline: generalDefaults.tagline,
      registrationNumber: generalDefaults.registrationNumber,
      siteUrl: generalDefaults.siteUrl,
      clientAreaUrl: generalDefaults.clientAreaUrl,
      supportEmail: generalDefaults.supportEmail,
      salesEmail: generalDefaults.salesEmail || generalDefaults.companyEmail,
      billingEmail: generalDefaults.billingEmail || generalDefaults.companyEmail,
      abuseEmail: generalDefaults.abuseEmail || generalDefaults.supportEmail,
      logoUrl: appearanceDefaults.logoUrl || generalDefaults.logoUrl,
      faviconUrl: appearanceDefaults.faviconUrl,
      footerLogoUrl: appearanceDefaults.footerLogoUrl || generalDefaults.footerLogoUrl,
      invoiceLogoUrl: appearanceDefaults.invoiceLogoUrl || generalDefaults.invoiceLogoUrl,
      openGraphImageUrl: appearanceDefaults.openGraphImageUrl || generalDefaults.openGraphImageUrl,
      primaryColor: appearanceDefaults.primaryColor,
      secondaryColor: appearanceDefaults.secondaryColor,
      accentColor: appearanceDefaults.accentColor,
      successColor: appearanceDefaults.successColor,
      dangerColor: appearanceDefaults.dangerColor,
      warningColor: appearanceDefaults.warningColor,
      footerDescription: generalDefaults.footerDescription,
      footerCopyrightText: generalDefaults.footerCopyrightText,
      publicContactBox: generalDefaults.publicContactBox,
      companyAddress: generalDefaults.companyAddress,
      gstNumber: generalDefaults.gstNumber,
      vatNumber: generalDefaults.vatNumber,
      phoneNumber: generalDefaults.phoneNumber || generalDefaults.companyPhone,
      whatsappNumber: generalDefaults.whatsappNumber,
      telegramUsername: generalDefaults.telegramUsername,
      environmentMode: platformDefaults.environmentMode,
      allowRegistration: platformDefaults.allowRegistration,
      notifyOnNewRegistration: platformDefaults.notifyOnNewRegistration,
      notifyOnPayment: platformDefaults.notifyOnPayment,
    }
  }
}

export function getCategoryFromParam(param: string): SettingsCategoryKey | null {
  if ((categoryKeys as readonly string[]).includes(param)) {
    return param as SettingsCategoryKey
  }
  return null
}

export async function getFlatSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function setFlatSetting(key: string, value: string, updatedBy?: string) {
  return prisma.setting.upsert({
    where: { key },
    update: { value, updatedBy: updatedBy || null, updatedAt: new Date() },
    create: { key, value, updatedBy: updatedBy || null },
  })
}

export function passwordMeetsRules(password: string, rules: SecuritySettings) {
  if (password.length < rules.minPasswordLength) return false
  if (rules.requireNumber && !/[0-9]/.test(password)) return false
  if (rules.requireUppercase && !/[A-Z]/.test(password)) return false
  if (rules.requireSpecialChar && !/[^A-Za-z0-9]/.test(password)) return false
  return true
}
