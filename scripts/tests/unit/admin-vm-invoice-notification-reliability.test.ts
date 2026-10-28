import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(path, "utf8")

test("VM edit only runs guest network automation when the IP actually changes", () => {
  const source = read("app/api/admin/vms/[id]/edit/route.ts")
  assert.match(source, /const changingIp = Boolean\(ipAddress && ipAddress !== vps\.ipAddress\)/)
  assert.match(source, /if \(changingIp && ipAddress\) \{\s*const currentIp/)
  assert.match(source, /guestChange = \{\s*kind: "network"/)
})

test("invoice list provides server-classified deletion safety and disables unsafe delete UI", () => {
  const api = read("app/api/admin/invoices/route.ts")
  const ui = read("app/admin/invoices/page.tsx")
  const safety = read("lib/invoice-deletion.ts")
  assert.match(api, /deletionSafety: classifyInvoiceDeletionSafety\(invoice\)/)
  assert.match(ui, /disabled=\{inv\.deletionSafety\?\.deletable !== true\}/)
  assert.match(ui, /selectedDeletableCount = invoices\.filter/)
  assert.match(safety, /if \(successfulPayment\) return \{ deletable: false/)
  assert.match(safety, /if \(paidInvoice && orderActive\) return \{ deletable: false/)
})

test("ordinary outbound WhatsApp messages use four attempts and a fixed five-minute backoff", () => {
  const queue = read("lib/whatsapp/queue.ts")
  assert.match(queue, /const defaultAttempts = reliableMessage \? 4 : 3/)
  assert.match(queue, /5 \* 60_000/)
  assert.match(queue, /type: "fixed"/)
  assert.match(queue, /\}, true\)/)
})

test("terminal queue failures alert admins only after the last attempt and suppress alert loops", () => {
  const worker = read("scripts/whatsapp-worker.ts")
  const queue = read("lib/whatsapp/queue.ts")
  const alerts = read("lib/admin-emergency-alert.ts")
  assert.match(worker, /const attemptNumber = job\.attemptsMade \+ 1/)
  assert.match(worker, /attemptNumber < attemptsLimit/)
  assert.match(worker, /if \(!willRetry && data\.metadata\?\.suppressEmergencyAlert !== true\)/)
  assert.match(queue, /job\.enqueue_failed/)
  assert.match(queue, /WHATSAPP_QUEUE_ENQUEUE_FAILED/)
  assert.match(queue, /REDIS_QUEUE_UNAVAILABLE/)
  assert.match(queue, /template\.resolve_failed/)
  assert.match(queue, /WHATSAPP_TEMPLATE_MISSING/)
  assert.match(alerts, /settings\.notificationEmail/)
  assert.match(alerts, /settings\.notificationNumber/)
  assert.match(alerts, /admin-emergency-alert:/)
  assert.match(alerts, /suppressEmergencyAlert: true/)
})

test("emergency email can be configured from the admin notifications page", () => {
  const settings = read("lib/admin-notifications.ts")
  const page = read("app/admin/notifications/page.tsx")
  const route = read("app/api/admin/notifications/settings/route.ts")
  const emailSender = read("lib/email/send.ts")
  const emailAlert = read("lib/admin-email-failure-alert.ts")
  assert.match(settings, /notificationEmail: string/)
  assert.match(page, /Emergency Email/)
  assert.match(page, /notificationEmail/)
  assert.match(route, /invalid_emergency_email/)
  assert.match(emailSender, /alertAdminEmailDeliveryFailure/)
  assert.match(emailSender, /success: !info\.rejected\?\.length/)
  assert.match(emailAlert, /suppressEmergencyAlert: true/)
  assert.match(emailAlert, /email_failure_alert_dispatched/)
  assert.match(emailAlert, /The recipient address and email content are intentionally omitted/)
  assert.match(emailAlert, /settings\.operationsNumbers/)
})

test("Cloudflare tunnel setup reuses the VPS login and exposes only the two intended hostnames", () => {
  const script = read("scripts/setup-cloudflare-tunnel-vps.sh")
  assert.match(script, /CLOUDFLARED_CERT.*CF_HOME.*cert\.pem/)
  assert.match(script, /dev\.zwscloud\.in/)
  assert.match(script, /api-panel\.zwscloud\.in/)
  assert.match(script, /127\.0\.0\.1:13000/)
  assert.match(script, /service: http_status:404/)
  assert.match(script, /cloudflared tunnel route dns/)
  assert.match(script, /cloudflared --config "\$CONFIG_FILE" tunnel ingress validate/)
  assert.match(script, /No existing record was overwritten/)
  assert.match(script, /does not modify firewall rules/)
  assert.doesNotMatch(script, /CF_API_TOKEN=|CF_TUNNEL_TOKEN=/)
})
