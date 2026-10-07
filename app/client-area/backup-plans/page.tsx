"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { readJsonResponse } from "@/lib/client/safe-json"
import { startPaymentRedirect } from "@/lib/client/payment-redirect"
import { formatCurrency } from "@/lib/currency-format"
import { effectiveBackupLimit as planBackupLimit } from "@/lib/backups-retention-limit"
import { toast } from "sonner"

type BackupPlan = {
  id: string
  name: string
  slug: string
  description: string | null
  price: number
  currency: string
  billingCycle: string
  taxPercent: number
  maxBackups: number
  storageQuotaGb: number
  manualBackupEnabled: boolean
  automaticBackupEnabled: boolean
  scheduleOptions: number[]
  retentionCount: number
  restoreEnabled: boolean
  downloadEnabled: boolean
  overageEnabled: boolean
  overagePricePerGb: number
  extraStoragePricePerGb: number
  gracePeriodDays: number
  maxStorageCapGb: number | null
  featured: boolean
}

type Usage = {
  entitled: boolean
  usedGb: number
  backupCount: number
  storageQuotaGb: number
  overStorage: boolean
  overageGb: number
  overStoragePercent: number
  backupsRemaining: number | null
  maxBackups: number | null
  planName: string | null
  status: string
  overageRatePerGb: number
}

export default function ClientBackupPlansPage() {
  const [plans, setPlans] = useState<BackupPlan[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [subscription, setSubscription] = useState<{ id: string; planId: string; status: string; expiresAt: string | null; graceEndsAt: string | null } | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [purchasingId, setPurchasingId] = useState<string | null>(null)
  const [extraGb, setExtraGb] = useState("10")
  const [extraPurchasing, setExtraPurchasing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/client/backup-plans", { cache: "no-store" })
      const body = await readJsonResponse<any>(res)
      if (!res.ok || !body.success) throw new Error(body.error || "Failed to load backup plans")
      setPlans(body.plans || [])
      setUsage(body.usage || null)
      setSubscription(body.subscription || null)
      setEnabled(Boolean(body.enabled ?? true))
    } catch (e: any) {
      toast.error(e?.message || "Failed to load backup plans")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const activePlan = subscription && plans.find((p) => p.id === subscription.planId) ? plans.find((p) => p.id === subscription.planId)! : null

  async function purchase(plan: BackupPlan) {
    setPurchasingId(plan.id)
    try {
      const res = await fetch("/api/client/backup-plans/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, termMonths: 1 }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data.error || "Purchase failed")
      const payment = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "billable_order",
          existingOrderId: data.orderId,
          paymentMethod: data.wallet?.sufficient ? "wallet" : undefined,
          idempotencyKey: data.idempotencyKey,
        }),
      })
      const paymentData = await readJsonResponse<any>(payment)
      if (!payment.ok) throw new Error(paymentData.message || paymentData.error || "Payment could not be started")
      await startPaymentRedirect(paymentData)
    } catch (e: any) {
      toast.error(e?.message || "Purchase failed")
    } finally {
      setPurchasingId(null)
    }
  }

  async function buyExtraStorage() {
    const gb = Math.max(1, Math.floor(Number(extraGb) || 0))
    if (gb < 1) return toast.error("Enter a size in GB")
    setExtraPurchasing(true)
    try {
      const res = await fetch("/api/client/backup-storage/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gb, termMonths: 1 }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data.error || "Purchase failed")
      const payment = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "billable_order",
          existingOrderId: data.orderId,
          paymentMethod: data.wallet?.sufficient ? "wallet" : undefined,
          idempotencyKey: data.idempotencyKey,
        }),
      })
      const paymentData = await readJsonResponse<any>(payment)
      if (!payment.ok) throw new Error(paymentData.message || paymentData.error || "Payment could not be started")
      await startPaymentRedirect(paymentData)
    } catch (e: any) {
      toast.error(e?.message || "Purchase failed")
    } finally {
      setExtraPurchasing(false)
    }
  }

  const quotaUsedPercent = usage ? Math.max(0, Math.min(100, Math.round((usage.usedGb / Math.max(1, usage.storageQuotaGb)) * 100))) : 0

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Backup Plans</h1>
          <p className="text-sm text-muted-foreground">Protect your virtual servers with automatic, off-server backups and restore your data whenever you need it.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/client-area/backups">Go to Backups</Link>
        </Button>
      </div>

      {!enabled ? (
        <Card className="border-red-400/30 bg-red-400/5">
          <CardContent className="pt-6 text-sm">The backup service is currently unavailable.</CardContent>
        </Card>
      ) : null}

      {usage ? (
        <Card className="border-border/40 bg-background/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your backup usage</CardTitle>
            <CardDescription>
              {usage.planName ? `${usage.planName} · ${String(usage.status).toUpperCase()}` : "No active plan"}
              {subscription?.expiresAt ? ` · renews/expires ${new Date(subscription.expiresAt).toLocaleDateString("en-IN")}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{usage.usedGb} GB used of {usage.storageQuotaGb} GB</span>
              <span>{(usage.backupsRemaining ?? Number(usage.maxBackups || 0))} backups{" "}{usage.maxBackups != null ? `of ${usage.maxBackups}` : ""} remaining</span>
            </div>
            <Progress value={quotaUsedPercent} className="h-2" />
            {usage.overageGb > 0 ? (
              <p className="text-xs text-amber-300">Using {usage.overageGb} GB above quota. Overage auto-bills at {formatCurrency(usage.overageRatePerGb, "INR")}/GB.</p>
            ) : null}
            <div className="flex flex-wrap items-end gap-3 pt-1">
              <div className="w-40 space-y-1.5">
                <Label htmlFor="extra-gb">Add extra storage (GB)</Label>
                <Input id="extra-gb" type="number" min={1} value={extraGb} onChange={(e) => setExtraGb(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" onClick={() => void buyExtraStorage()} disabled={extraPurchasing}>
                {extraPurchasing ? "Purchasing…" : "Buy extra storage"}
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/client-area/wallet">Add credits</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {usage?.status === "grace" ? (
        <Card className="border-amber-400/30 bg-amber-400/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <div>
              <p className="text-sm font-medium">Your backup plan is in its grace period</p>
              <p className="text-xs text-muted-foreground">
                {subscription?.graceEndsAt
                  ? `Renew before ${new Date(subscription.graceEndsAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} to keep backups and restores active.`
                  : "Renew to keep backups and restores active."}
              </p>
            </div>
            <Button asChild size="sm" className="bg-amber-500/90 text-black hover:bg-amber-400">
              <Link href="/client-area/wallet">Renew now</Link>
            </Button>
          </CardContent>
        </Card>
      ) : usage?.status === "expired" ? (
        <Card className="border-red-400/30 bg-red-400/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <div>
              <p className="text-sm font-medium">Your backup plan has expired</p>
              <p className="text-xs text-muted-foreground">Automated backups are paused. Stored backups are retained; purchase a plan to resume.</p>
            </div>
            <Button asChild size="sm" className="bg-red-500/90 text-white hover:bg-red-400">
              <Link href="/client-area/wallet">Repurchase a plan</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Spinner className="h-5 w-5" />
        </div>
      ) : plans.length === 0 ? (
        <Card className="border-border/40">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No backup plans are available right now.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = subscription && subscription.planId === plan.id && ["active", "grace"].includes(subscription.status)
            return (
              <Card key={plan.id} className={`flex flex-col border-border/40 bg-background/80 ${plan.featured ? "ring-1 ring-amber-400/50" : ""}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-lg">{plan.name}</CardTitle>
                    {plan.featured ? <Badge className="bg-amber-500/90 text-black">Featured</Badge> : null}
                  </div>
                  <CardDescription>{plan.description || "Automatic off-server backups."}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-4">
                  <div>
                    <p className="text-3xl font-semibold">
                      {formatCurrency(plan.price, plan.currency)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">/{plan.billingCycle}</span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">+ GST {Number(plan.taxPercent || 0)}%</p>
                  </div>
                  <ul className="flex-1 space-y-1.5 text-sm">
                    <li>{planBackupLimit(plan) == null ? "Unlimited backups kept" : `${planBackupLimit(plan)} backups kept`}</li>
                    <li>{plan.storageQuotaGb} GB storage quota</li>
                    <li>{plan.manualBackupEnabled ? "Manual backups" : "No manual backups"} · {plan.automaticBackupEnabled ? "automatic backups" : "no automatic backups"}</li>
                    {/* One limit, not two. This plan used to advertise a kept-count *and* a
                        separate retention figure, and the two disagreed whenever
                        retention was the smaller. The number actually enforced is
                        the stricter of the two, so it is the only one shown. */}
                    <li>Oldest beyond the limit are pruned automatically</li>
                    <li>{plan.restoreEnabled ? "Restore included" : "Restore not included"}</li>
                    {plan.overageEnabled ? <li>Overage: {formatCurrency(plan.overagePricePerGb, plan.currency)}/GB</li> : <li>No overage billing</li>}
                    <li>Extra storage: {formatCurrency(plan.extraStoragePricePerGb, plan.currency)}/GB/mo</li>
                    {plan.maxStorageCapGb ? <li>Max total storage: {plan.maxStorageCapGb} GB</li> : null}
                  </ul>
                  <Button
                    className={isCurrent ? "w-full" : "w-full bg-amber-500/90 text-black hover:bg-amber-400"}
                    disabled={Boolean(purchasingId) || Boolean(isCurrent)}
                    onClick={() => void purchase(plan)}
                  >
                    {purchasingId === plan.id ? "Starting payment…" : isCurrent ? "Current plan" : subscription ? "Switch to this plan" : "Purchase"}
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}