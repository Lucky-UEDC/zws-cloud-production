"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Block = {
  id: string
  ip?: string | null
  deviceFingerprint?: string | null
  reason: string
  attackType?: string | null
  createdAt: string
  kind?: "temporary" | "permanent"
  label?: string
  blockedUntil?: string | null
  remainingMinutes?: number | null
  expired?: boolean
  riskScore?: number | null
  eventCount?: number
  signalCount?: number | null
  route?: string | null
  method?: string | null
  customerId?: string | null
  reviewStatus?: string | null
  unblockedAt?: string | null
  unblockedBy?: string | null
  country?: string | null
}
type BlockSummary = {
  activeTemporary: number
  expiredTemporary: number
  permanent: number
  needsReview: number
  temporaryBlockMinutes: number
}
type EventRow = {
  id: string
  eventType?: string
  severity?: string
  attackType?: string
  ip?: string
  route?: string
  createdAt: string
  actionTaken?: string
  riskScore?: number | null
  expiresAt?: string | null
  requestId?: string | null
}

export default function AdminSecurityPage() {
  const [ips, setIps] = useState<Block[]>([])
  const [devices, setDevices] = useState<Block[]>([])
  const [summary, setSummary] = useState<BlockSummary | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [attacks, setAttacks] = useState<EventRow[]>([])
  const [failed, setFailed] = useState<EventRow[]>([])
  const [suspicious, setSuspicious] = useState<EventRow[]>([])
  const [report, setReport] = useState<any>(null)
  const [releasing, setReleasing] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [blocksRes, eventsRes, reportRes] = await Promise.all([
      fetch("/api/admin/security/blocks", { cache: "no-store" }),
      fetch("/api/admin/security/events", { cache: "no-store" }),
      fetch("/api/admin/security/report", { cache: "no-store" }),
    ])
    const blocks = await readJsonResponse<any>(blocksRes)
    const eventData = await readJsonResponse<any>(eventsRes)
    const reportData = await readJsonResponse<any>(reportRes).catch(() => null)
    if (blocksRes.ok) {
      setIps(blocks.ips || [])
      setDevices(blocks.devices || [])
      setSummary(blocks.summary || null)
    }
    if (eventsRes.ok) {
      setEvents(eventData.events || [])
      setAttacks(eventData.attacks || [])
      setFailed(eventData.failed || [])
      setSuspicious(eventData.suspicious || [])
    }
    if (reportRes.ok) setReport(reportData?.report || null)
  }, [])

  useEffect(() => { void load() }, [load])

  async function unblock(id: string, reviewStatus: string) {
    setReleasing(id)
    try {
      const res = await fetch(`/api/admin/security/blocks/${id}/unblock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewStatus,
          reason: reviewStatus === "false_positive" ? "Released by administrator as a false positive" : "Released by administrator",
        }),
      })
      const data = await readJsonResponse<any>(res).catch(() => null)
      if (!res.ok) return toast.error(data?.error || "Unable to release block")
      toast.success("Block released. Risk score reset; the identity can connect normally.")
      await load()
    } finally {
      setReleasing(null)
    }
  }

  const allBlocks = [...ips.map((item) => ({ ...item, type: "IP" })), ...devices.map((item) => ({ ...item, type: "Device" }))]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Security Center</h1>
        <p className="mt-1 text-muted-foreground">
          Temporary security blocks, suspicious devices, payload attacks, failed attempts, and abuse controls.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Metric label="Active temporary blocks" value={summary?.activeTemporary ?? 0} />
        <Metric label="Expired temporary blocks" value={summary?.expiredTemporary ?? 0} />
        <Metric label="Permanent blocks (manual)" value={summary?.permanent ?? 0} />
        <Metric label="Awaiting review" value={summary?.needsReview ?? 0} />
      </div>
      <Card className="border-border/40 bg-card">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Automatic mitigation is a ladder: a single suspicious request is recorded and scored, repeated
          requests raise the score, and only when the score crosses the threshold is a
          {" "}
          <strong className="text-foreground">
            temporary {summary?.temporaryBlockMinutes ?? 30}-minute security block
          </strong>{" "}
          applied. It expires automatically and never becomes permanent. Permanent blocks on this page were
          set by an administrator.
        </CardContent>
      </Card>
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Security Report</CardTitle><CardDescription>Host hardening recommendations, Cloudflare Tunnel validation, and secret scan status.</CardDescription></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <ReportTile label="Fail2Ban Recommendations" value={report?.fail2ban?.recommended ? "Recommended" : "Unavailable"} />
          <ReportTile label="UFW Recommendations" value={report?.ufw?.cloudflareOnlyMode ? "Cloudflare-only" : "Review"} />
          <ReportTile label="Cloudflare Tunnel Validation" value={report?.cloudflareTunnel?.ok ? "Healthy" : "Attention"} />
          <ReportTile label="Open Ports" value={String(report?.openPorts?.length || 0)} />
          <ReportTile label="Exposed Services" value={String((report?.exposedServices || []).filter((row: any) => row.exposedInCloudflareOnlyMode).length)} />
          <ReportTile label="SSL Health" value={report?.sslHealth?.ok ? "Healthy" : "Attention"} />
          <ReportTile label="Secret Scanner" value={report?.secretScanner?.ok ? "Clean" : `${report?.secretScanner?.findings?.length || 0} findings`} />
        </CardContent>
      </Card>
      <Card className="glass border-border/40">
        <CardHeader>
          <CardTitle>Security Blocks</CardTitle>
          <CardDescription>
            Temporary {summary?.temporaryBlockMinutes ?? 30}-minute holds expire on their own. Review any that
            look wrong and release them here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {allBlocks.map((item) => (
            <BlockRow key={`${item.type}-${item.id}`} item={item} onRelease={unblock} releasing={releasing === item.id} />
          ))}
          {!allBlocks.length ? <p className="text-sm text-muted-foreground">No active blocks.</p> : null}
        </CardContent>
      </Card>
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Recent Attacks</CardTitle><CardDescription>Rejected malicious payload attempts.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {attacks.map((row) => <LogRow key={row.id} row={row} label={row.attackType || "attack"} />)}
          {!attacks.length ? <p className="text-sm text-muted-foreground">No attack logs.</p> : null}
        </CardContent>
      </Card>
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Security Events</CardTitle><CardDescription>Rate limits, block decisions, and security failures.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {events.map((row) => <LogRow key={row.id} row={row} label={row.eventType || "event"} />)}
          {!events.length ? <p className="text-sm text-muted-foreground">No security events.</p> : null}
        </CardContent>
      </Card>
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Suspicious Requests</CardTitle><CardDescription>Captcha, OTP, rate-limit, and spam signals.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {suspicious.map((row: any) => <LogRow key={row.id} row={row} label={row.reason || "suspicious"} />)}
          {!suspicious.length ? <p className="text-sm text-muted-foreground">No suspicious requests.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return <Card className="glass border-border/40"><CardContent className="p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></CardContent></Card>
}

function ReportTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border/40 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>
}

function LogRow({ row, label }: { row: EventRow; label: string }) {
  return (
    <div className="rounded-lg border border-border/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{label}</Badge>
        <span>{row.route || "unknown route"}</span>
        <span className="text-muted-foreground">{row.ip || "unknown IP"}</span>
        {row.riskScore ? <Badge variant="secondary">risk {row.riskScore}</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {row.actionTaken || row.severity || "logged"} · {new Date(row.createdAt).toLocaleString()}
        {row.expiresAt ? ` · expires ${new Date(row.expiresAt).toLocaleString()}` : ""}
      </p>
    </div>
  )
}

function BlockRow({
  item,
  onRelease,
  releasing,
}: {
  item: Block & { type: string }
  onRelease: (id: string, reviewStatus: string) => void
  releasing: boolean
}) {
  const temporary = item.kind === "temporary"
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/40 p-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{item.type}</Badge>
          <Badge variant={temporary ? "secondary" : "destructive"}>{item.label || (temporary ? "Temporary block" : "Permanent block")}</Badge>
          <span className="font-mono text-sm">{item.ip || item.deviceFingerprint}</span>
          <span className="text-sm text-muted-foreground">{item.attackType || item.reason}</span>
          {item.country ? <span className="text-xs text-muted-foreground">{item.country}</span> : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Applied {new Date(item.createdAt).toLocaleString()}</span>
          {temporary && item.blockedUntil ? (
            <span>
              {item.expired ? "Expired" : "Releases"} {new Date(item.blockedUntil).toLocaleString()}
              {typeof item.remainingMinutes === "number" && !item.expired ? ` (${item.remainingMinutes} min left)` : ""}
            </span>
          ) : null}
          {typeof item.riskScore === "number" ? <span>Risk score {item.riskScore}</span> : null}
          <span>Events: {item.eventCount ?? 0}</span>
          {item.route ? <span>Route: {item.method ? `${item.method} ` : ""}{item.route}</span> : null}
          {item.customerId ? <span>Customer: {item.customerId}</span> : null}
          {item.reviewStatus ? <span>Review: {String(item.reviewStatus).replace(/_/g, " ")}</span> : null}
          {item.unblockedBy ? <span>Released by {item.unblockedBy}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={releasing}
          onClick={() => onRelease(item.id, "false_positive")}
          title="Release and mark this block as a false positive"
        >
          Mark false positive &amp; release
        </Button>
        <Button variant="outline" size="sm" disabled={releasing} onClick={() => onRelease(item.id, "reviewed")}>
          Release
        </Button>
      </div>
    </div>
  )
}
