import { NextRequest, NextResponse } from "next/server"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { buildSupportCode, safeApiErrorMessage } from "@/lib/api-error-safe"
import { sessionExpiredJson } from "@/lib/auth/session-expired-response"
import { prisma } from "@/lib/db"
import { getAdminNotificationSettings, updateAdminNotificationSettings } from "@/lib/admin-notifications"
import { getAdminFromCookies } from "@/lib/server-auth"

export const dynamic = "force-dynamic"

const DEFAULT_RULES = [
  { key: "invoice.unpaid.reminder", name: "Unpaid invoice reminders", eventType: "invoice_unpaid", channels: ["email", "dashboard"], schedule: { cadence: "daily" } },
  { key: "service.renewal.reminder", name: "Renewal reminders", eventType: "renewal_due", channels: ["email", "whatsapp", "dashboard"], schedule: { daysBefore: [7, 3, 1, 0] } },
  { key: "service.suspension.warning", name: "Suspension warnings", eventType: "suspension_warning", channels: ["email", "whatsapp", "dashboard"], schedule: { cadence: "daily" } },
  { key: "vm.created.notice", name: "VM creation notices", eventType: "vm_created", channels: ["email", "dashboard"], schedule: { trigger: "event" } },
  { key: "infra.downtime.alert", name: "Downtime alerts", eventType: "downtime_alert", channels: ["email", "telegram", "webhook", "dashboard"], schedule: { trigger: "event" } },
  { key: "backup.failed.alert", name: "Backup alerts", eventType: "backup_alert", channels: ["email", "telegram", "dashboard"], schedule: { trigger: "event" } },
]

function ruleModel() {
  return (prisma as any).notificationRule
}

export async function GET() {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) return sessionExpiredJson()
  const [rules, settings] = await Promise.all([
    ruleModel().findMany({ orderBy: { createdAt: "asc" } }).catch(() => []),
    getAdminNotificationSettings(),
  ])
  return NextResponse.json({ success: true, rules, defaults: DEFAULT_RULES, settings })
}

export async function PUT(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) return sessionExpiredJson()

  try {
    const body = await request.json().catch(() => ({}))
    if (body.notificationEmail !== undefined) {
      const email = String(body.notificationEmail || "").trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json({ success: false, error: "Enter a valid emergency alert email address", code: "invalid_emergency_email" }, { status: 400 })
      }
      body.notificationEmail = email
    }
    const settings = await updateAdminNotificationSettings(body, String(admin.email))
    return NextResponse.json({ success: true, settings })
  } catch (error: any) {
    const supportCode = buildSupportCode("NOTIF-SET")
    return NextResponse.json({
      success: false,
      error: safeApiErrorMessage(error, "Notification settings update failed"),
      code: "notification_settings_failed",
      supportCode,
    }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) return sessionExpiredJson()

  try {
    const body = await request.json().catch(() => ({}))
    const key = String(body.key || "").trim()
    const name = String(body.name || "").trim()
    const eventType = String(body.eventType || "").trim()
    if (!key || !name || !eventType) {
      return NextResponse.json({ success: false, error: "key, name, and eventType are required", code: "invalid_request" }, { status: 400 })
    }
    const rule = await ruleModel().upsert({
      where: { key },
      create: {
        key,
        name,
        eventType,
        channels: Array.isArray(body.channels) ? body.channels : [],
        schedule: body.schedule && typeof body.schedule === "object" ? body.schedule : {},
        template: body.template && typeof body.template === "object" ? body.template : {},
        enabled: body.enabled !== false,
        cooldownSec: Number.isFinite(Number(body.cooldownSec)) ? Math.max(0, Number(body.cooldownSec)) : 0,
        retryPolicy: body.retryPolicy && typeof body.retryPolicy === "object" ? body.retryPolicy : {},
        timezone: String(body.timezone || "UTC"),
        locale: typeof body.locale === "string" ? body.locale : null,
        updatedBy: String(admin.email),
      },
      update: {
        name,
        eventType,
        channels: Array.isArray(body.channels) ? body.channels : [],
        schedule: body.schedule && typeof body.schedule === "object" ? body.schedule : {},
        template: body.template && typeof body.template === "object" ? body.template : {},
        enabled: body.enabled !== false,
        cooldownSec: Number.isFinite(Number(body.cooldownSec)) ? Math.max(0, Number(body.cooldownSec)) : 0,
        retryPolicy: body.retryPolicy && typeof body.retryPolicy === "object" ? body.retryPolicy : {},
        timezone: String(body.timezone || "UTC"),
        locale: typeof body.locale === "string" ? body.locale : null,
        updatedBy: String(admin.email),
      },
    })
    return NextResponse.json({ success: true, rule })
  } catch (error: any) {
    const supportCode = buildSupportCode("NOTIF-SET")
    return NextResponse.json({
      success: false,
      error: safeApiErrorMessage(error, "Notification settings update failed"),
      code: "notification_settings_failed",
      supportCode,
    }, { status: 400 })
  }
}
