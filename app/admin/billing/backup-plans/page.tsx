"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { formatCurrency } from "@/lib/currency-format"
import { effectiveBackupLimit as planBackupLimit } from "@/lib/backups-retention-limit"

type BackupPlan = Record<string, any>
type SnapshotPlan = Record<string, any>
type GatewayFee = Record<string, any>

const gb = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0))

export default function AdminBillingPlansPage() {
  const [loading, setLoading] = useState(true)
  const [plans, setPlans] = useState<BackupPlan[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotPlan[]>([])
  const [gateways, setGateways] = useState<GatewayFee[]>([])

  const [name, setName] = useState("")
  const [price, setPrice] = useState("")
  const [maxBackups, setMaxBackups] = useState("10")
  const [retentionCount, setRetentionCount] = useState("10")
  const [quota, setQuota] = useState("100")
  const [overagePrice, setOveragePrice] = useState("1")
  const [saving, setSaving] = useState(false)
  const [planId, setPlanId] = useState<string | null>(null)
  const [overview, setOverview] = useState<Record<string, any> | null>(null)

  const [snapName, setSnapName] = useState("")
  const [snapPrice, setSnapPrice] = useState("25")
  const [snapIncluded, setSnapIncluded] = useState("10")
  const [snapOverage, setSnapOverage] = useState("25")
  const [snapSaving, setSnapSaving] = useState(false)
  const [snapPlanId, setSnapPlanId] = useState<string | null>(null)

  const [gwGateway, setGwGateway] = useState("razorpay")
  const [gwFeePercent, setGwFeePercent] = useState("3")
  const [gwFixedFee, setGwFixedFee] = useState("0")
  const [gwEnabled, setGwEnabled] = useState(true)
  const [gwMin, setGwMin] = useState("")
  const [gwMax, setGwMax] = useState("")
  const [gwSaving, setGwSaving] = useState(false)

  const readJson = async (res: Response) => {
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.error || body?.message || "Request failed")
    return body
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, s, g] = await Promise.all([
        readJson(await fetch("/api/admin/backup-plans", { cache: "no-store" })),
        readJson(await fetch("/api/admin/snapshot-plans", { cache: "no-store" })),
        readJson(await fetch("/api/admin/gateway-fees", { cache: "no-store" })),
      ])
      setPlans(p.plans || [])
      setSnapshots(s.plans || [])
      setGateways(g.configs || [])
      const overviewRes = await fetch("/api/admin/billing/overview", { cache: "no-store" })
      if (overviewRes.ok) setOverview(await overviewRes.json().catch(() => null))
    } catch (e: any) {
      toast.error(e?.message || "Failed to load billing configuration.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function saveBackupPlan() {
    if (!name.trim()) return toast.error("Plan name is required.")
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        price: Number(price || 0),
        maxBackups: gb(maxBackups),
        // Retention is now an explicit, visible part of the plan. It used to be
        // seeded once and never editable, so an admin who raised maxBackups to
        // 15 silently kept a hidden retention of 10 - and the plan page sold the
        // customer both numbers.
        retentionCount: gb(retentionCount),
        storageQuotaGb: gb(quota),
        overagePricePerGb: Number(overagePrice || 0),
      }
      const res = await fetch(planId ? `/api/admin/backup-plans/${planId}` : "/api/admin/backup-plans", {
        method: planId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      await readJson(res)
      toast.success(planId ? "Backup plan updated." : "Backup plan created.")
      setPlanId(null)
      setName("")
      setPrice("")
      setMaxBackups("10")
      setQuota("100")
      setOveragePrice("1")
      void load()
    } catch (e: any) {
      toast.error(e?.message || "Failed to save backup plan.")
    } finally {
      setSaving(false)
    }
  }

  function editBackupPlan(plan: BackupPlan) {
    setPlanId(plan.id)
    setName(plan.name)
    setPrice(String(Number(plan.price || 0)))
    setMaxBackups(String(plan.maxBackups ?? 10))
    setRetentionCount(String(plan.retentionCount ?? plan.maxBackups ?? 10))
    setQuota(String(plan.storageQuotaGb ?? 100))
    setOveragePrice(String(Number(plan.overagePricePerGb || 0)))
  }

  async function archiveBackupPlan(plan: BackupPlan) {
    try {
      await readJson(await fetch(`/api/admin/backup-plans/${plan.id}`, { method: "DELETE" }))
      toast.success("Backup plan archived.")
      void load()
    } catch (e: any) {
      toast.error(e?.message || "Failed to archive backup plan.")
    }
  }

  async function saveSnapshotPlan() {
    if (!snapName.trim()) return toast.error("Snapshot plan name is required.")
    setSnapSaving(true)
    try {
      const payload = {
        name: snapName.trim(),
        model: "plan",
        price: Number(snapPrice || 0),
        includedSnapshots: gb(snapIncluded),
        overageSnapshotPrice: Number(snapOverage || 0),
      }
      const res = await fetch(snapPlanId ? `/api/admin/snapshot-plans/${snapPlanId}` : "/api/admin/snapshot-plans", {
        method: snapPlanId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      await readJson(res)
      toast.success(snapPlanId ? "Snapshot plan updated." : "Snapshot plan created.")
      setSnapPlanId(null)
      setSnapName("")
      void load()
    } catch (e: any) {
      toast.error(e?.message || "Failed to save snapshot plan.")
    } finally {
      setSnapSaving(false)
    }
  }

  async function saveGatewayFee() {
    setGwSaving(true)
    try {
      const res = await fetch("/api/admin/gateway-fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: gwGateway,
          feePercent: Number(gwFeePercent || 0),
          fixedFee: Number(gwFixedFee || 0),
          enabled: gwEnabled,
          minAmount: gwMin ? Number(gwMin) : null,
          maxAmount: gwMax ? Number(gwMax) : null,
        }),
      })
      await readJson(res)
      toast.success("Gateway fee config saved.")
      setGwGateway("razorpay")
      setGwFeePercent("3")
      setGwFixedFee("0")
      setGwMin("")
      setGwMax("")
      void load()
    } catch (e: any) {
      toast.error(e?.message || "Failed to save gateway fee config.")
    } finally {
      setGwSaving(false)
    }
  }

  return (
    <div className="min-w-0 max-w-full space-y-8 overflow-x-hidden">
      <div>
        <h1 className="text-3xl font-semibold">Backup &amp; Snapshot Billing</h1>
        <p className="mt-1 text-muted-foreground">Manage billable backup plans, snapshot plans, and gateway fee handling for credit wallet top-ups.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Spinner className="h-5 w-5" /></div>
      ) : (
        <>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Reports Overview</CardTitle>
              <CardDescription>Live billing snapshot: billable revenue, subscriptions, storage, and wallet top-ups.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {overview ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-md border border-border/40 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">Billable revenue (paid)</p>
                    <p className="mt-1 text-2xl font-semibold">{formatCurrency(Number(overview.revenue?.totalPaid || 0), "INR")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{overview.revenue?.billableCount || 0} paid orders · {formatCurrency(Number(overview.revenue?.totalTax || 0), "INR")} tax</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">Subscriptions</p>
                    <p className="mt-1 text-lg font-semibold">
                      {Object.entries(overview.subscriptions?.byStatus || {}).map(([status, count]) => `${status}: ${count}`).join(" · ") || "0 total"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">Expiring: {overview.subscriptions?.upcomingExpiry?.next7d || 0} in 7d · {overview.subscriptions?.upcomingExpiry?.next30d || 0} in 30d</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">Storage</p>
                    <p className="mt-1 text-lg font-semibold">{overview.storage?.activeUpgradeGb || 0} GB extra</p>
                    <p className="mt-1 text-xs text-muted-foreground">Unbilled overage: {overview.storage?.overageUnbilledGb || 0} GB · {formatCurrency(Number(overview.storage?.overageUnbilledAmount || 0), "INR")}</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">Wallet top-ups (paid)</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(Number(overview.wallet?.topupGross || 0), "INR")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Gateway fees: {formatCurrency(Number(overview.wallet?.topupGatewayFee || 0), "INR")}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {Object.entries(overview.revenue?.byKind || {}).map(([kind, amount]) => (
                    <span key={kind}>
                      {kind.replace(/_/g, " ")}: <span className="font-medium text-foreground">{formatCurrency(Number(amount || 0), "INR")}</span>
                    </span>
                  ))}
                  <span>
                    Refunds: <span className="font-medium text-foreground">{formatCurrency(Number(overview.refunds?.total || 0), "INR")}</span>
                    <span className="text-muted-foreground"> (snapshot: {formatCurrency(Number(overview.refunds?.snapshot || 0), "INR")})</span>
                  </span>
                  <span>
                    Snapshot charges pending refund: <span className="font-medium text-foreground">{overview.snapshots?.chargesPendingRefund || 0}</span>
                  </span>
                </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Reports unavailable right now.</p>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Backup Plans</CardTitle>
              <CardDescription>Plans are shown in the client backup marketplace. Archiving hides the plan from new purchases.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-md border border-border/40 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro Backup" /></div>
                <div className="space-y-1.5"><Label>Price/mo (INR)</Label><Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Max backups</Label><Input type="number" min={0} value={maxBackups} onChange={(e) => { setMaxBackups(e.target.value); if (!planId) setRetentionCount(e.target.value) }} /></div>
                <div className="space-y-1.5">
                  <Label>Retention (kept)</Label>
                  <Input type="number" min={0} value={retentionCount} onChange={(e) => setRetentionCount(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Oldest beyond this are pruned automatically. The binding limit is the lower of the two.</p>
                </div>
                <div className="space-y-1.5"><Label>Quota (GB)</Label><Input type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Overage (₹/GB)</Label><Input type="number" min={0} value={overagePrice} onChange={(e) => setOveragePrice(e.target.value)} /></div>
                <div className="sm:col-span-2 lg:col-span-5 flex gap-2">
                  <Button onClick={() => void saveBackupPlan()} disabled={saving}>{saving ? "Saving…" : planId ? "Update plan" : "Create plan"}</Button>
                  {planId ? <Button variant="outline" onClick={() => { setPlanId(null); setName(""); setPrice(""); setMaxBackups("10"); setQuota("100"); setOveragePrice("1") }}>Cancel edit</Button> : null}
                </div>
              </div>
              <div className="min-w-0 overflow-x-auto rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Backups</TableHead>
                      <TableHead>Quota</TableHead>
                      <TableHead>Overage</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plans.map((plan) => (
                      <TableRow key={plan.id}>
                        <TableCell>
                          <p className="font-medium">{plan.name}</p>
                          <p className="text-xs text-muted-foreground">{plan.slug}</p>
                        </TableCell>
                        <TableCell>{formatCurrency(Number(plan.price || 0), plan.currency)}</TableCell>
                        <TableCell>
                          {planBackupLimit(plan) == null ? "Unlimited" : planBackupLimit(plan)}
                          {planBackupLimit(plan) != null && planBackupLimit(plan) !== Number(plan.maxBackups) ? (
                            <p className="text-xs text-muted-foreground">max {plan.maxBackups}, retention {plan.retentionCount}</p>
                          ) : null}
                        </TableCell>
                        <TableCell>{plan.storageQuotaGb} GB</TableCell>
                        <TableCell>{formatCurrency(Number(plan.overagePricePerGb || 0), plan.currency)}/GB</TableCell>
                        <TableCell>{plan.archived ? <Badge variant="outline">Archived</Badge> : plan.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => editBackupPlan(plan)}>Edit</Button>
                            {!plan.archived ? <Button variant="outline" size="sm" className="text-red-300" onClick={() => void archiveBackupPlan(plan)}>Archive</Button> : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!plans.length ? (
                      <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No backup plans yet.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Snapshot Plans</CardTitle>
              <CardDescription>When snapshot billing is set to &quot;plan&quot;, customers pay per snapshot beyond the included count.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-md border border-border/40 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5"><Label>Name</Label><Input value={snapName} onChange={(e) => setSnapName(e.target.value)} placeholder="Starter Snapshots" /></div>
                <div className="space-y-1.5"><Label>Price/mo (INR)</Label><Input type="number" min={0} value={snapPrice} onChange={(e) => setSnapPrice(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Included snapshots</Label><Input type="number" min={0} value={snapIncluded} onChange={(e) => setSnapIncluded(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Overage (₹/snapshot)</Label><Input type="number" min={0} value={snapOverage} onChange={(e) => setSnapOverage(e.target.value)} /></div>
                <div className="sm:col-span-2 lg:col-span-4 flex gap-2">
                  <Button onClick={() => void saveSnapshotPlan()} disabled={snapSaving}>{snapSaving ? "Saving…" : snapPlanId ? "Update snapshot plan" : "Create snapshot plan"}</Button>
                  {snapPlanId ? <Button variant="outline" onClick={() => { setSnapPlanId(null); setSnapName(""); }}>Cancel edit</Button> : null}
                </div>
              </div>
              <div className="min-w-0 overflow-x-auto rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Included</TableHead>
                      <TableHead>Overage</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshots.map((plan) => (
                      <TableRow key={plan.id}>
                        <TableCell>
                          <p className="font-medium">{plan.name}</p>
                          <p className="text-xs text-muted-foreground">{plan.slug} · {plan.model}</p>
                        </TableCell>
                        <TableCell>{formatCurrency(Number(plan.price || 0), plan.currency)}</TableCell>
                        <TableCell>{plan.includedSnapshots}</TableCell>
                        <TableCell>{formatCurrency(Number(plan.overageSnapshotPrice || 0), plan.currency)}/snap</TableCell>
                        <TableCell>{plan.archived ? <Badge variant="outline">Archived</Badge> : plan.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => { setSnapPlanId(plan.id); setSnapName(plan.name); setSnapPrice(String(Number(plan.price || 0))); setSnapIncluded(String(plan.includedSnapshots ?? 0)); setSnapOverage(String(Number(plan.overageSnapshotPrice || 0))) }}>Edit</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!snapshots.length ? (
                      <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No snapshot plans yet.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Gateway Fees</CardTitle>
              <CardDescription>Gateway fees are deducted from credit wallet top-ups. The balance credited is the gross top-up minus the fee.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-md border border-border/40 bg-muted/20 p-4 sm:grid-cols-3 lg:grid-cols-6">
                <div className="space-y-1.5"><Label>Gateway</Label>
                  <select className="h-10 w-full rounded-md border border-border/40 bg-background px-3 text-sm" value={gwGateway} onChange={(e) => setGwGateway(e.target.value)}>
                    <option value="razorpay">razorpay</option>
                    <option value="cashfree">cashfree</option>
                  </select>
                </div>
                <div className="space-y-1.5"><Label>Fee %</Label><Input type="number" min={0} step="0.01" value={gwFeePercent} onChange={(e) => setGwFeePercent(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Fixed fee (₹)</Label><Input type="number" min={0} step="0.01" value={gwFixedFee} onChange={(e) => setGwFixedFee(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Min amount</Label><Input type="number" min={0} value={gwMin} onChange={(e) => setGwMin(e.target.value)} placeholder="optional" /></div>
                <div className="space-y-1.5"><Label>Max amount</Label><Input type="number" min={0} value={gwMax} onChange={(e) => setGwMax(e.target.value)} placeholder="optional" /></div>
                <div className="flex items-end gap-2">
                  <Button onClick={() => void saveGatewayFee()} disabled={gwSaving}>{gwSaving ? "Saving…" : "Save fee"}</Button>
                </div>
              </div>
              <div className="min-w-0 overflow-x-auto rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Gateway</TableHead>
                      <TableHead>Fee</TableHead>
                      <TableHead>Bounds</TableHead>
                      <TableHead>Enabled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gateways.map((config) => (
                      <TableRow key={config.gateway}>
                        <TableCell className="font-medium">{config.gateway}</TableCell>
                        <TableCell>{Number(config.feePercent)}% {Number(config.fixedFee) > 0 ? `+ ₹${Number(config.fixedFee)}` : ""}</TableCell>
                        <TableCell>{config.minAmount != null ? `₹${Number(config.minAmount)}` : "—"} – {config.maxAmount != null ? `₹${Number(config.maxAmount)}` : "—"}</TableCell>
                        <TableCell>{config.enabled ? <Badge>Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}</TableCell>
                      </TableRow>
                    ))}
                    {!gateways.length ? (
                      <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No gateway fee configs yet. Defaults apply (3% from credit settings).</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}