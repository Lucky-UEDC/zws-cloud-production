"use client"

/**
 * Central node health and capability dashboard.
 *
 * ## What it renders and why it is shaped this way
 *
 * One card per node the Proxmox API disclosed, and the card answers three
 * questions an operator actually has: is this node up, what can it do, and what
 * is stopping it from doing the rest.
 *
 * The five statuses are kept distinct because they call for different people and
 * different actions:
 *
 * | Status               | Means                                              |
 * |----------------------|----------------------------------------------------|
 * | Healthy              | Every checked capability was verified             |
 * | Degraded             | Reachable, but a capability is genuinely missing  |
 * | Permission Required  | A specific Proxmox grant is missing               |
 * | Unsupported          | The Proxmox build or storage cannot do this       |
 * | Offline              | The node is not answering                         |
 *
 * The distinction that matters most is **Permission Required vs Unsupported**,
 * and the second that matters most is **API reachable vs operational**. A node
 * whose API answers perfectly, whose token is valid, and which cannot take a
 * snapshot or open a console is *not* healthy — connectivity was never the claim.
 *
 * ## Where the data comes from
 *
 * `/api/admin/proxmox-nodes/discover`, which runs server-side against Proxmox
 * with the stored token. No Proxmox token, secret or host reaches this component:
 * it receives a finished report and renders it. Refreshing re-fetches that
 * endpoint rather than polling Proxmox from the browser.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Activity, CircleAlert, RefreshCw, Server, ShieldAlert, Unplug } from "lucide-react"
import { readJsonResponse } from "@/lib/client/safe-json"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"

export type ProbeState = "verified" | "denied" | "failed" | "unmeasured"

export type ProbeOutcome = {
  state: ProbeState
  message: string
  endpoint: string | null
  status: number | null
}

export type DiscoveredNode = {
  node: string
  availability: "online" | "offline" | "inaccessible"
  reportedStatus: string | null
  type: string | null
  telemetry: {
    cpuCores: number | null
    cpuUsagePercent: number | null
    memoryTotalBytes: number | null
    memoryUsedBytes: number | null
    memoryUsagePercent: number | null
    storageTotalBytes: number | null
    storageUsedBytes: number | null
    uptimeSeconds: number | null
  }
  vms: {
    total: number
    running: number
    stopped: number
    visibleToToken: boolean
    guestAgent: { reporting: number; total: number; coveragePercent: number | null; caveat: string } | null
  }
  console: { probeVmid: number | null; vnc: ProbeOutcome; serial: ProbeOutcome }
  storage: {
    inspected: Array<{ name: string; type: string; supportsBackups: boolean; supportsSnapshots: boolean | null; freeBytes: number | null; active: boolean }>
    snapshotSupported: boolean
    backupSupported: boolean
    snapshotDetail: string
    backupDetail: string
    snapshotRemediation: string | null
    backupRemediation: string | null
  }
  checks: Array<{ name: string; ok: boolean; endpoint: string; status: number | null; message: string; durationMs: number }>
  denials: Array<{ endpoint: string; capability: string; requiredPrivilege: string | null; aclPath: string | null; remediation: string }>
  health: {
    status: "healthy" | "degraded" | "permission_required" | "unsupported" | "offline"
    statusLabel: string
    reasons: string[]
    remediation: string[]
  }
}

export type DiscoveryReport = {
  host: string
  counts: { discovered: number; online: number; offline: number; inaccessible: number }
  visibilityNote: string
  cluster: { nodeListOk: boolean; statusOk: boolean; resourcesOk: boolean }
  nodes: DiscoveredNode[]
  aclSetup: Array<{ feature: string; label: string; description: string; commands: string[]; note: string }>
}

const STATUS_STYLE: Record<DiscoveredNode["health"]["status"], { label: string; badge: string; icon: typeof Server }> = {
  healthy: { label: "Healthy", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", icon: Activity },
  degraded: { label: "Degraded", badge: "bg-amber-500/15 text-amber-300 border-amber-500/40", icon: CircleAlert },
  permission_required: { label: "Permission Required", badge: "bg-sky-500/15 text-sky-300 border-sky-500/40", icon: ShieldAlert },
  unsupported: { label: "Unsupported", badge: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40", icon: Server },
  offline: { label: "Offline", badge: "bg-red-500/15 text-red-300 border-red-500/40", icon: Unplug },
}

const PROBE_LABEL: Record<ProbeState, { text: string; className: string }> = {
  verified: { text: "Verified", className: "text-emerald-400" },
  denied: { text: "Permission denied", className: "text-sky-400" },
  failed: { text: "Failed", className: "text-red-400" },
  // Deliberately not styled as a pass. An unmeasured capability is not evidence.
  unmeasured: { text: "Not measured", className: "text-zinc-400" },
}

function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return "—"
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TiB`
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024).toFixed(1)} KiB`
}

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  if (days) return `${days}d ${hours}h`
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** One labelled capability line. Renders the real message, never a bare tick. */
function CapabilityRow({ label, outcome }: { label: string; outcome: ProbeOutcome }) {
  const style = PROBE_LABEL[outcome.state]
  return (
    <div className="flex items-start justify-between gap-3 py-0.5 text-xs">
      <span className="min-w-0">
        <span className="text-foreground">{label}</span>
        <span className="block text-muted-foreground">{outcome.message}</span>
      </span>
      <span className={`shrink-0 font-medium ${style.className}`}>{style.text}</span>
    </div>
  )
}

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">{percent === null ? "—" : `${percent}%`}</span>
      </div>
      <Progress value={percent ?? 0} className="h-1" />
      <div className="text-[11px] text-muted-foreground">{detail}</div>
    </div>
  )
}

export function NodeHealthDashboard({
  nodeId,
  host,
  refreshMs = 60000,
}: {
  /** A registered node to reuse stored credentials for. Omit to probe raw credentials. */
  nodeId?: string | null
  /** Shown in the header so an operator knows which cluster this is. */
  host?: string | null
  refreshMs?: number
}) {
  const [report, setReport] = useState<DiscoveryReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = nodeId ? `/api/admin/proxmox-nodes/discover?nodeId=${encodeURIComponent(nodeId)}` : "/api/admin/proxmox-nodes/discover"
      const response = await fetch(url, { method: nodeId ? "GET" : "POST", cache: "no-store" })
      const body = await readJsonResponse<DiscoveryReport & { error?: string }>(response)
      if (!mounted.current) return
      if (!response.ok || !body?.nodes) {
        setError(body?.error || `Discovery failed (HTTP ${response.status})`)
        return
      }
      setReport(body)
      setError(null)
      setLastCheckedAt(new Date().toISOString())
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Discovery failed")
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [nodeId])

  useEffect(() => {
    mounted.current = true
    void load()
    // Polling is bounded and pauses when the tab is hidden, so an open dashboard
    // does not quietly hold a steady request rate against the cluster.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, refreshMs)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [load, refreshMs])

  if (error && !report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Node health</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-300">{error}</p>
          <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={() => void load()}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Node health</CardTitle>
          <CardDescription>Discovering nodes visible to this API token…</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Node health &amp; capabilities</CardTitle>
            <CardDescription>
              {report.counts.discovered} discovered · {report.counts.online} online · {report.counts.offline} offline ·{" "}
              {report.counts.inaccessible} inaccessible
              {host ? ` · ${report.host}` : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-2">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>{report.visibilityNote}</p>
          {!report.cluster.statusOk ? (
            <p className="text-sky-300">
              Cluster status telemetry is unavailable to this token. Node inventory below is unaffected.
            </p>
          ) : null}
          <p>Last successful check: {lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : "—"}</p>
        </CardContent>
      </Card>

      {report.nodes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No nodes are visible to this API token. Check that the token belongs to a user with access to the cluster.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {report.nodes.map((node) => (
            <NodeCard key={node.node} node={node} />
          ))}
        </div>
      )}

      {report.nodes.some((node) => node.health.remediation.length > 0) ? (
        <AclSetupPanel nodes={report.nodes} />
      ) : null}
    </div>
  )
}

function NodeCard({ node }: { node: DiscoveredNode }) {
  const style = STATUS_STYLE[node.health.status]
  const Icon = style.icon
  const memPercent = node.telemetry.memoryUsagePercent
  const diskPercent =
    node.telemetry.storageTotalBytes && node.telemetry.storageUsedBytes
      ? Math.round((node.telemetry.storageUsedBytes / node.telemetry.storageTotalBytes) * 1000) / 10
      : null
  const guestAgent = node.vms.guestAgent

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="h-4 w-4" />
              {node.node}
            </CardTitle>
            <CardDescription>
              {node.type ? `${node.type} · ` : ""}
              {node.reportedStatus ? `Proxmox reports "${node.reportedStatus}" · ` : ""}
              {node.availability === "online"
                ? "API reachable and authorized for node status"
                : node.availability === "inaccessible"
                  ? "Listed by the cluster; this token may not read its status"
                  : "Not answering"}
            </CardDescription>
          </div>
          <Badge className={style.badge} variant="outline">
            {style.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {node.health.reasons.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-border/40 p-2 text-xs">
            {node.health.reasons.map((reason) => (
              <li key={reason} className="text-muted-foreground">{reason}</li>
            ))}
          </ul>
        ) : null}

        {node.availability === "online" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter
              label="CPU"
              percent={node.telemetry.cpuUsagePercent}
              detail={node.telemetry.cpuCores ? `${node.telemetry.cpuCores} cores · up ${formatUptime(node.telemetry.uptimeSeconds)}` : "Not reported"}
            />
            <Meter
              label="Memory"
              percent={memPercent}
              detail={node.telemetry.memoryTotalBytes ? `${formatBytes(node.telemetry.memoryUsedBytes)} of ${formatBytes(node.telemetry.memoryTotalBytes)}` : "Not reported"}
            />
            <Meter
              label="Storage"
              percent={diskPercent}
              detail={node.telemetry.storageTotalBytes ? `${formatBytes(node.telemetry.storageUsedBytes)} of ${formatBytes(node.telemetry.storageTotalBytes)}` : "Not reported"}
            />
          </div>
        ) : null}

        <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 py-0.5 text-xs">
            <span className="text-muted-foreground">VMs visible to token</span>
            <span className="font-medium text-foreground">
              {node.vms.visibleToToken ? `${node.vms.total} (${node.vms.running} running)` : "Not readable"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-0.5 text-xs">
            <span className="text-muted-foreground">Guest agent</span>
            <span className="font-medium text-foreground">
              {guestAgent ? `${guestAgent.reporting}/${guestAgent.total} reporting` : "No VMs visible"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-0.5 text-xs">
            <span className="text-muted-foreground">Snapshots</span>
            <span className={`font-medium ${node.storage.snapshotSupported ? "text-emerald-400" : "text-amber-300"}`}>
              {node.storage.snapshotSupported ? "Available" : "Not available"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-0.5 text-xs">
            <span className="text-muted-foreground">Backups</span>
            <span className={`font-medium ${node.storage.backupSupported ? "text-emerald-400" : "text-amber-300"}`}>
              {node.storage.backupSupported ? "Available" : "Not available"}
            </span>
          </div>
        </div>

        <div className="space-y-1 border-t border-border/40 pt-2">
          <CapabilityRow label="VNC console" outcome={node.console.vnc} />
          <CapabilityRow label="Serial console" outcome={node.console.serial} />
          <CapabilityRow
            label="Snapshot capability"
            outcome={{
              state: node.storage.snapshotSupported ? "verified" : "failed",
              message: node.storage.snapshotDetail,
              endpoint: null,
              status: null,
            }}
          />
          <CapabilityRow
            label="Backup capability"
            outcome={{
              state: node.storage.backupSupported ? "verified" : "failed",
              message: node.storage.backupDetail,
              endpoint: null,
              status: null,
            }}
          />
        </div>

        {node.denials.length > 0 ? (
          <div className="space-y-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
            <div className="font-medium text-sky-200">Permissions this token is missing</div>
            {node.denials.map((denial) => (
              <div key={denial.endpoint} className="text-sky-200/90">
                <span className="font-mono">{denial.endpoint}</span>
                {denial.requiredPrivilege ? (
                  <span className="text-sky-300/80"> — needs {denial.requiredPrivilege} on {denial.aclPath}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {node.health.remediation.length > 0 ? (
          <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            <summary className="cursor-pointer font-medium text-amber-200">
              What an administrator has to do ({node.health.remediation.length})
            </summary>
            <ul className="mt-1.5 list-inside list-disc space-y-1 text-amber-200/90">
              {node.health.remediation.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * The exact `pveacl` lines for the permissions this token is missing.
 *
 * Rendered as text for a human to run in the Proxmox shell. Nothing here is
 * executed by the panel, and there is deliberately no button to apply it: a
 * Proxmox ACL change is an administrator decision made on the Proxmox host.
 */
function AclSetupPanel({ nodes }: { nodes: DiscoveredNode[] }) {
  const missing = [...new Set(nodes.flatMap((node) => node.denials.map((denial) => `${denial.requiredPrivilege}|${denial.aclPath}`)))]
    .map((entry) => entry.split("|"))
    .filter(([privilege]) => Boolean(privilege))
    .map(([privilege, aclPath]) => `pveacl modify acl -add -users <user>@<realm> -roles <role> -privs ${privilege} ${aclPath}`)

  if (!missing.length) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Permission setup</CardTitle>
        <CardDescription>
          Run these in the Proxmox shell on the affected host, substituting your user, realm and role. The panel does not modify
          Proxmox ACLs, and these lines are the least-privilege grants for the features it uses.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md border border-border/40 bg-muted/30 p-3 text-[11px] leading-5">
          {missing.join("\n")}
        </pre>
      </CardContent>
    </Card>
  )
}

export default NodeHealthDashboard