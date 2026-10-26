"use client"

import { useEffect, useState } from "react"
import { RefreshCw, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { readJsonResponse } from "@/lib/client/safe-json"

const eventLabels: Record<string, string> = {
  account_create: "Account create",
  login: "Login",
  logout: "Logout",
  order_placed: "Order placed",
  payment_success: "Payment success",
  payment_failed: "Payment failed",
  invoice_generated: "Invoice generated",
  vm_provisioned: "VM provisioned",
  ticket_opened: "Ticket opened",
  ticket_replied: "Ticket replied",
  password_changed: "Password changed",
  website_visit: "Website visit notification",
  node_capacity_warning: "Node capacity warning",
  node_full: "Node full",
  provision_failover: "Provision failover",
}

export default function AdminNotificationsPage() {
  const [settings, setSettings] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  async function load() {
    const [settingsRes, logsRes] = await Promise.all([
      fetch("/api/admin/notifications/settings", { cache: "no-store" }),
      fetch("/api/admin/notifications/logs?sensitive=masked", { cache: "no-store" }),
    ])
    const data = await readJsonResponse<any>(settingsRes)
    const logData = await readJsonResponse<any>(logsRes)
    if (settingsRes.ok) setSettings(data.settings)
    if (logsRes.ok) setLogs(logData.logs || [])
  }

  useEffect(() => {
    void load()
  }, [])

  async function save() {
    const res = await fetch("/api/admin/notifications/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
    const data = await readJsonResponse<any>(res)
    if (!res.ok) return toast.error(data.error || "Unable to save notifications")
    setSettings(data.settings)
    toast.success("Notification settings saved")
  }

  async function refreshLogs() {
    setLogsLoading(true)
    const res = await fetch("/api/admin/notifications/logs?sensitive=masked", { cache: "no-store" })
    const data = await readJsonResponse<any>(res)
    if (res.ok) setLogs(data.logs || [])
    setLogsLoading(false)
  }

  if (!settings) return <p className="text-sm text-muted-foreground">Loading notification settings...</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Notifications</h1>
        <p className="text-muted-foreground">Control admin WhatsApp and email notification delivery.</p>
      </div>

      <Tabs defaultValue="settings" className="space-y-4">
        <TabsList>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="logs">Delivery Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="space-y-6">
          <Card className="glass border-border/40">
            <CardHeader><CardTitle>Delivery Controls</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-4">
              <div className="flex items-center gap-3 rounded-md border border-border/40 p-3">
                <Switch checked={settings.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, enabled })} />
                <Label>Enable Notifications</Label>
              </div>
              <div className="space-y-2"><Label>Emergency WhatsApp Number</Label><Input value={settings.notificationNumber || ""} onChange={(e) => setSettings({ ...settings, notificationNumber: e.target.value })} placeholder="+911234567890" /><p className="text-xs text-muted-foreground">Used for urgent terminal delivery failures.</p></div>
              <div className="space-y-2"><Label>Emergency Email</Label><Input type="email" value={settings.notificationEmail || ""} onChange={(e) => setSettings({ ...settings, notificationEmail: e.target.value })} placeholder="admin@example.com" /><p className="text-xs text-muted-foreground">Independent fallback if WhatsApp delivery fails.</p></div>
              <div className="space-y-2"><Label>Operations Numbers</Label><Input value={(settings.operationsNumbers || []).join(", ")} onChange={(e) => setSettings({ ...settings, operationsNumbers: e.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="+911234567890, +919876543210" /></div>
              <div className="space-y-2">
                <Label>Delivery mode</Label>
                <select value={settings.deliveryMode} onChange={(e) => setSettings({ ...settings, deliveryMode: e.target.value })} className="h-10 w-full rounded-md border border-border/40 bg-background px-3 text-sm">
                  <option value="whatsapp_only">WhatsApp only</option>
                  <option value="whatsapp_email">WhatsApp + Email</option>
                  <option value="silent_log">Silent Log</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <select value={settings.provider} onChange={(e) => setSettings({ ...settings, provider: e.target.value })} className="h-10 w-full rounded-md border border-border/40 bg-background px-3 text-sm">
                  <option value="evolution">Evolution API</option>
                </select>
              </div>
            </CardContent>
          </Card>

          <Card className="glass border-border/40">
            <CardHeader><CardTitle>Event Toggles</CardTitle></CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {Object.entries(eventLabels).map(([event, label]) => (
                <div key={event} className="flex items-center justify-between rounded-md border border-border/40 p-3">
                  <Label>{label}</Label>
                  <Switch
                    checked={Boolean(settings.events?.[event])}
                    onCheckedChange={(enabled) => setSettings({ ...settings, events: { ...settings.events, [event]: enabled } })}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Button onClick={save}><Save className="mr-2 h-4 w-4" />Save settings</Button>
        </TabsContent>
        <TabsContent value="logs">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Delivery Logs</CardTitle>
              <Button variant="outline" size="sm" onClick={() => void refreshLogs()} className="gap-2">
                <RefreshCw className={`h-4 w-4 ${logsLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="border-b text-left text-muted-foreground">
                  <tr><th className="py-2">Time</th><th>Destination</th><th>Type</th><th>Status</th><th>Provider</th><th>Template</th><th>Customer</th><th>Failure</th></tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-border/30">
                      <td className="py-2">{log.createdAt ? new Date(log.createdAt).toLocaleString() : "-"}</td>
                      <td>{log.maskedDestination || log.destination}</td>
                      <td>{log.notificationType}</td>
                      <td>{log.statusLabel}</td>
                      <td>{log.provider}</td>
                      <td>{log.template}</td>
                      <td>{log.customer}</td>
                      <td className="max-w-[220px] truncate">{log.failureReason || "-"}</td>
                    </tr>
                  ))}
                  {!logs.length ? <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">No notification delivery logs found.</td></tr> : null}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
