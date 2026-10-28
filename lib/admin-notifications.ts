import { prisma } from "@/lib/db"

export const ADMIN_NOTIFICATION_EVENTS = [
  "account_create",
  "login",
  "logout",
  "order_placed",
  "payment_success",
  "payment_failed",
  "invoice_generated",
  "vm_provisioned",
  "ticket_opened",
  "ticket_replied",
  "password_changed",
  "website_visit",
  "node_capacity_warning",
  "node_full",
  "provision_failover",
] as const

export type AdminNotificationEvent = (typeof ADMIN_NOTIFICATION_EVENTS)[number]

export type AdminNotificationSettings = {
  enabled: boolean
  notificationNumber: string
  operationsNumbers: string[]
  notificationEmail: string
  deliveryMode: "whatsapp_only" | "whatsapp_email" | "silent_log"
  provider: "evolution"
  events: Record<AdminNotificationEvent, boolean>
}

function defaultEvents() {
  return Object.fromEntries(ADMIN_NOTIFICATION_EVENTS.map((event) => [event, event !== "website_visit"])) as Record<AdminNotificationEvent, boolean>
}

export async function getDefaultAdminNotificationNumber() {
  const admin = await prisma.adminProfile.findFirst({
    where: { role: "super_admin", phone: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { phone: true },
  }).catch(() => null)
  return admin?.phone || ""
}

export async function getAdminNotificationSettings(): Promise<AdminNotificationSettings> {
  const row = await prisma.adminSetting.findUnique({ where: { key: "admin_notification_settings" } }).catch(() => null)
  const value = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value as any : {}
  return {
    enabled: value.enabled !== false,
    notificationNumber: String(value.notificationNumber || await getDefaultAdminNotificationNumber()),
    operationsNumbers: Array.isArray(value.operationsNumbers) ? value.operationsNumbers.map((item: unknown) => String(item || "").trim()).filter(Boolean) : [],
    notificationEmail: String(value.notificationEmail || ""),
    deliveryMode: ["whatsapp_only", "whatsapp_email", "silent_log"].includes(String(value.deliveryMode)) ? value.deliveryMode : "whatsapp_only",
    provider: "evolution",
    events: { ...defaultEvents(), ...(value.events || {}) },
  }
}

export async function updateAdminNotificationSettings(input: Partial<AdminNotificationSettings>, updatedBy?: string | null) {
  const current = await getAdminNotificationSettings()
  const next: AdminNotificationSettings = {
    enabled: input.enabled ?? current.enabled,
    notificationNumber: String(input.notificationNumber ?? current.notificationNumber ?? "").trim(),
    operationsNumbers: Array.isArray(input.operationsNumbers) ? input.operationsNumbers.map((item) => String(item || "").trim()).filter(Boolean) : current.operationsNumbers,
    notificationEmail: String(input.notificationEmail ?? current.notificationEmail ?? "").trim(),
    deliveryMode: input.deliveryMode || current.deliveryMode,
    provider: input.provider || current.provider,
    events: { ...current.events, ...(input.events || {}) },
  }
  await prisma.adminSetting.upsert({
    where: { key: "admin_notification_settings" },
    update: { value: next as any, updatedBy: updatedBy || null },
    create: {
      key: "admin_notification_settings",
      value: next as any,
      description: "Admin notification engine settings",
      updatedBy: updatedBy || null,
    },
  })
  return next
}
