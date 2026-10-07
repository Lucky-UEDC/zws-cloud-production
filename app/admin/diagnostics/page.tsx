import { prisma } from "@/lib/db"
import { safeAdminQuery } from "@/lib/admin-safe-query"
import { readProvisionWorkerHeartbeat } from "@/lib/provision-worker-status"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { classifyFailedJob, getDiagnosticsHealth } from "@/lib/diagnostics-health"
import { humanizeId } from "@/components/admin/diagnostics-format"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function AdminDiagnosticsPage() {
  const [worker, health, failedJobs] = await Promise.all([
    readProvisionWorkerHeartbeat(),
    safeAdminQuery("diagnostics.health", getDiagnosticsHealth, null),
    // Recent failures only. Historical volume is reported as a count, never as
    // a table, so a year-old outage cannot read as a live one.
    safeAdminQuery("diagnostics.jobs.recent", () => prisma.provisioningJob.findMany({
      where: { status: "failed", updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      select: {
        id: true, type: true, status: true, currentStep: true, error: true,
        updatedAt: true, orderId: true, vpsInstanceId: true, attempts: true, maxAttempts: true, vmid: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
    }), []),
  ])

  // One row per order, not one per failed attempt, with the classification
  // that decides whether an admin may safely retry.
  const classified = await Promise.all(
    failedJobs.data.map(async (job) => {
      const [order, identityCount, vmsCount] = await Promise.all([
        job.orderId
          ? prisma.order.findUnique({ where: { id: job.orderId }, select: { status: true, provisioningStatus: true } }).catch(() => null)
          : Promise.resolve(null),
        job.orderId
          ? prisma.vmProvisioningIdentity.findMany({ where: { orderId: job.orderId }, select: { id: true, vpsInstanceId: true, phase: true } }).catch(() => [])
          : Promise.resolve([]),
        job.orderId
          ? prisma.vpsInstance.count({ where: { orderId: job.orderId, deletedAt: null } }).catch(() => 0)
          : Promise.resolve(0),
      ])
      const withVm = identityCount.find((row) => row.vpsInstanceId)
      return {
        job,
        classification: classifyFailedJob({
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          orderStatus: order?.status || null,
          provisioningStatus: order?.provisioningStatus || null,
          vmsInstanceCount: vmsCount,
          identityPhase: withVm?.phase || identityCount[0]?.phase || null,
          hasVmId: Boolean(withVm),
        }),
      }
    }),
  )

  const data = health.data
  const violations = data?.integrity.filter((row) => row.severity === "violation" && row.count > 0) || []
  const quiet = data?.integrity.filter((row) => row.severity === "violation" && row.count === 0) || []
  const jobs = data?.jobs

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden">
      <div>
        <h1 className="text-3xl font-semibold">Diagnostics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live state first, history second. Nothing on this page is repaired automatically.
        </p>
      </div>

      {!data ? (
        <Card className="glass border-destructive/40">
          <CardHeader><CardTitle>Diagnostics unavailable</CardTitle></CardHeader>
          <CardContent className="text-sm text-destructive">
            {health.warning || "The health query failed."} Counts below may be incomplete.
          </CardContent>
        </Card>
      ) : null}

      {/* A. SYSTEM HEALTH */}
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>System health</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Live violations"
            value={violations.reduce((sum, row) => sum + row.count, 0)}
            ok={violations.length === 0}
            hint={violations.length === 0 ? "No integrity violation detected." : violations.map((row) => row.label).join(", ")}
          />
          <Metric label="Provision worker" value={worker?.healthy ? "Healthy" : "Offline"} ok={Boolean(worker?.healthy)} hint={worker?.heartbeatAt ? `Last heartbeat ${new Date(worker.heartbeatAt).toLocaleString("en-IN")}` : "No heartbeat recorded"} />
          <Metric label="Nodes connected" value={`${data?.nodes.filter((node) => node.status === "connected" && node.isActive).length ?? 0}/${data?.nodes.length ?? 0}`} ok={(data?.nodes.length ?? 0) > 0} hint="Proxmox nodes reporting a live API connection" />
          <Metric label="Stale jobs" value={jobs?.stale ?? 0} ok={(jobs?.stale ?? 0) === 0} hint={`In flight but untouched for over ${data?.staleJobMinutes ?? 30} minutes`} />
        </CardContent>
      </Card>

      {/* B/C/D/E. JOBS, with explicit windows */}
      {jobs ? (
        <Card className="glass border-border/40">
          <CardHeader>
            <CardTitle>Provisioning jobs</CardTitle>
            <p className="text-sm text-muted-foreground">
              Each figure states its window. Historical failures are counted, never listed as a live outage.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Active now" value={jobs.active} ok hint="Queued, running or retrying right now" />
            <Metric label="Waiting for admin" value={jobs.waitingForAdmin} ok={jobs.waitingForAdmin === 0} hint="Paused on a human, not broken" />
            <Metric label={`Failed in last ${data?.recentWindowHours}h`} value={jobs.failedRecent} ok={jobs.failedRecent === 0} hint={`Across ${jobs.failedRecentOrders} order${jobs.failedRecentOrders === 1 ? "" : "s"}`} />
            <Metric label="Failed all-time" value={jobs.failedHistorical} ok hint={`Historical, across ${jobs.failedHistoricalOrders} orders. Retained on purpose.`} />
            <Metric label="Completed" value={jobs.completed} ok hint="Provisioning runs that finished successfully" />
            <Metric label="Cancelled" value={jobs.cancelled} ok hint="Cancelled by an admin or the customer" />
            <Metric label="Stale (in flight)" value={jobs.stale} ok={jobs.stale === 0} hint={`No progress for over ${data?.staleJobMinutes} minutes`} />
            <Metric label="Failed orders, all-time" value={jobs.failedHistoricalOrders} ok hint="The number that actually matters: orders affected, not retries" />
          </CardContent>
        </Card>
      ) : null}

      {/* Recent failures, classified. Historical volume is above, not here. */}
      <Card className="glass border-border/40">
        <CardHeader>
          <CardTitle>Recent failures (last {data?.recentWindowHours ?? 24} hours)</CardTitle>
          <p className="text-sm text-muted-foreground">Newest 25 attempts, with why each one may or may not be retried.</p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr><th className="py-2">Job</th><th>Order</th><th>Step</th><th>State</th><th>Retry safe?</th><th>Updated</th><th>Error</th></tr>
            </thead>
            <tbody>
              {classified.map(({ job, classification }) => (
                <tr key={job.id} className="border-b align-top">
                  <td className="py-2 font-mono text-xs">{humanizeId(job.id)}</td>
                  <td className="font-mono text-xs">{job.orderId ? humanizeId(job.orderId) : "-"}</td>
                  <td>{job.currentStep || "-"}</td>
                  <td><Badge variant="outline">{classification.classification.replace(/_/g, " ")}</Badge></td>
                  <td className="max-w-xs text-xs text-muted-foreground">{classification.reason}</td>
                  <td className="whitespace-nowrap">{job.updatedAt.toLocaleString("en-IN")}</td>
                  <td className="max-w-sm truncate text-xs">{job.error || "-"}</td>
                </tr>
              ))}
              {!classified.length ? (
                <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">
                  {failedJobs.warning || "No provisioning job failed in this window."}
                </td></tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* F. DATA INTEGRITY, each check with its own meaning. */}
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Data integrity</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {violations.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-destructive">Requires attention</p>
              {violations.map((row) => (
                <IntegrityRow key={row.key} label={row.label} count={row.count} severity={row.severity} detail={row.detail} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No integrity violation detected.</p>
          )}
          {quiet.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">{quiet.length} checks passing</summary>
              <div className="mt-2 space-y-2">
                {quiet.map((row) => <IntegrityRow key={row.key} label={row.label} count={row.count} severity={row.severity} detail={row.detail} />)}
              </div>
            </details>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Historical and expected records</summary>
            <div className="mt-2 space-y-2">
              {(data?.integrity || []).filter((row) => row.severity !== "violation").map((row) => (
                <IntegrityRow key={row.key} label={row.label} count={row.count} severity={row.severity} detail={row.detail} />
              ))}
            </div>
          </details>
        </CardContent>
      </Card>

      {/* G. PROXMOX HEALTH */}
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Proxmox nodes</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(data?.nodes || []).map((node) => {
            const connected = node.isActive && node.status === "connected"
            return (
              <div key={node.id} className="flex flex-col gap-1 border-b pb-2 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate font-medium">{node.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{node.nodeName} · {node.host}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {node.lastCheckedAt ? `checked ${new Date(node.lastCheckedAt).toLocaleString("en-IN")}` : "never checked"}
                  </span>
                  <Badge variant={connected ? "default" : "destructive"}>{node.isActive ? node.status || "unknown" : "disabled"}</Badge>
                </div>
              </div>
            )
          })}
          {!data?.nodes.length ? <p className="text-sm text-muted-foreground">No Proxmox node registered.</p> : null}
        </CardContent>
      </Card>

      {/* H. WORKER HEALTH */}
      <Card className="glass border-border/40">
        <CardHeader><CardTitle>Provision worker</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Badge variant={worker?.healthy ? "default" : "destructive"}>{worker?.healthy ? "Healthy" : "Offline or stale"}</Badge>
          <div className="text-muted-foreground">
            Last heartbeat: {worker?.heartbeatAt ? new Date(worker.heartbeatAt).toLocaleString("en-IN") : "never"}
          </div>
          <div className="text-muted-foreground">Processed: {worker?.processed ?? 0} · Errors: {worker?.errors ?? 0}</div>
          {worker?.lastError ? <div className="text-destructive">Last error: {String(worker.lastError).slice(0, 200)}</div> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function Metric({ label, value, ok, hint }: { label: string; value: string | number; ok: boolean; hint: string }) {
  return (
    <div className="rounded border border-border/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Badge variant={ok ? "secondary" : "destructive"}>{String(value)}</Badge>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

function IntegrityRow({ label, count, severity, detail }: { label: string; count: number; severity: string; detail: string }) {
  const variant = count === 0 ? "secondary" : severity === "violation" ? "destructive" : "outline"
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <Badge variant={variant as "secondary" | "destructive" | "outline"}>{count}</Badge>
    </div>
  )
}
