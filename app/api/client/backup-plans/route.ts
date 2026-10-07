import { NextRequest, NextResponse } from "next/server"
import { getClientFromCookies } from "@/lib/server-auth"
import { prisma } from "@/lib/db"
import { resolveBackupEntitlement, computeBackupUsageSummary, entitlementToJson } from "@/lib/billing/entitlements"
import { getBackupServiceSettings } from "@/lib/settings"

export const dynamic = "force-dynamic"
export const revalidate = 0

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
}

function serializePlan(plan: any) {
  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description,
    price: Number(plan.price),
    currency: plan.currency,
    billingCycle: plan.billingCycle,
    taxPercent: Number(plan.taxPercent),
    maxBackups: plan.maxBackups,
    storageQuotaGb: plan.storageQuotaGb,
    manualBackupEnabled: plan.manualBackupEnabled,
    automaticBackupEnabled: plan.automaticBackupEnabled,
    scheduleOptions: Array.isArray(plan.scheduleOptions) ? plan.scheduleOptions.map(Number) : [],
    retentionCount: plan.retentionCount,
    restoreEnabled: plan.restoreEnabled,
    downloadEnabled: plan.downloadEnabled,
    overageEnabled: plan.overageEnabled,
    overagePricePerGb: Number(plan.overagePricePerGb),
    extraStoragePricePerGb: Number(plan.extraStoragePricePerGb),
    gracePeriodDays: plan.gracePeriodDays,
    maxStorageCapGb: plan.maxStorageCapGb != null ? Number(plan.maxStorageCapGb) : null,
    featured: plan.featured,
  }
}

export async function GET(_request: NextRequest) {
  const customer = await getClientFromCookies()
  const customerId = String(customer?.sub || "")
  if (!customerId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS })

  const settings = await getBackupServiceSettings().catch(() => null)
  const [plans, entitlement, usage, subscription] = await Promise.all([
    prisma.backupPlan.findMany({ where: { active: true, archived: false }, orderBy: [{ featured: "desc" }, { price: "asc" }] }),
    resolveBackupEntitlement(customerId).catch(() => ({ entitled: false as const, entitlement: null, reason: "Backup service not available" })),
    computeBackupUsageSummary(customerId),
    prisma.backupSubscription.findFirst({ where: { customerId }, orderBy: { createdAt: "desc" } }).catch(() => null),
  ])

  return NextResponse.json({
    success: true,
    enabled: Boolean(settings?.enabled ?? true),
    plans: plans.map(serializePlan),
    entitlement: {
      entitled: entitlement.entitled,
      reason: entitlement.reason,
      entitlement: entitlementToJson(entitlement.entitlement),
    },
    usage: {
      usedBytes: String(usage.usedBytes),
      usedGb: usage.usedGb,
      backupCount: usage.backupCount,
      storageQuotaGb: usage.storageQuotaGb,
      storageQuotaBytes: String(usage.storageQuotaBytes ?? 0),
      remainingBytes: String(usage.remainingBytes ?? 0),
      remainingGb: usage.remainingGb ?? 0,
      overStorage: usage.overStorage,
      overageEnabled: usage.overageEnabled,
      overageGb: usage.overageGb,
      overStoragePercent: usage.overStoragePercent,
      capReached: usage.capReached,
      // The effective limit, plus both source values so the page can explain the
      // number rather than assert it.
      maxBackups: usage.maxBackups,
      effectiveBackupLimit: usage.effectiveBackupLimit ?? usage.maxBackups,
      planMaxBackups: usage.planMaxBackups ?? null,
      retentionCount: usage.retentionCount ?? null,
      backupsRemaining: usage.backupsRemaining,
      planName: usage.planName,
      planId: usage.planId,
      subscriptionId: usage.subscriptionId,
      status: usage.status,
      overageRatePerGb: usage.overageRatePerGb,
    },
    subscription: subscription
      ? {
          id: subscription.id,
          planId: subscription.planId,
          status: subscription.status,
          autoRenew: subscription.autoRenew,
          termMonths: subscription.termMonths,
          upgradeStorageGb: subscription.upgradeStorageGb,
          grandfathered: subscription.grandfathered,
          expiresAt: subscription.expiresAt ? subscription.expiresAt.toISOString() : null,
          graceEndsAt: subscription.graceEndsAt ? subscription.graceEndsAt.toISOString() : null,
        }
      : null,
  }, { headers: NO_CACHE_HEADERS })
}