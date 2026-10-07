import { prisma } from "@/lib/db"
import { getBackupServiceSettings, type BackupServiceSettings } from "@/lib/settings"
import { createPanelLog } from "@/lib/panel-log"
import { bytesFromGb, gbFromBytes, round2, mulAmount } from "@/lib/billing/money"
import { effectiveBackupLimit } from "@/lib/backups-retention-limit"

export type BackupEntitlementOptions = {
  maxBackups: number | null
  storageQuotaBytes: bigint
  storageQuotaGb: number
  extraStorageGb: number
  retentionCount: number
  manualBackupEnabled: boolean
  automaticBackupEnabled: boolean
  scheduleOptions: number[]
  restoreEnabled: boolean
  downloadEnabled: boolean
  overageEnabled: boolean
  overagePricePerGb: number
  extraStoragePricePerGb: number
  gracePeriodDays: number
  maxStorageCapGb: number | null
  paid: boolean
  grandfathered: boolean
  subscriptionId: string | null
  planId: string | null
  planName: string | null
  status: "active" | "grace" | "legacy" | "none"
  expiresAt: Date | null
  graceEndsAt: Date | null
  autoRenew: boolean
}

export type BackupEntitlementResult = {
  entitled: boolean
  entitlement: BackupEntitlementOptions | null
  reason: string | null
}

function normalizeScheduleOptions(value: unknown, fallback: number[]): number[] {
  if (Array.isArray(value)) {
    const list = value.map(Number).filter(Number.isFinite).filter((n) => n > 0)
    if (list.length) return list
  }
  return fallback
}

export async function computeBackupUsageForCustomer(customerId: string) {
  const instances = await prisma.vpsInstance.findMany({
    where: { customerId, deletedAt: null },
    select: { id: true },
  })
  const instanceIds = instances.map((instance) => instance.id)
  if (!instanceIds.length) return { usedBytes: 0n, usedGb: 0, backupCount: 0, backups: [] as any[] }
  const backups = await prisma.vmBackup.findMany({
    where: { vpsInstanceId: { in: instanceIds } },
    orderBy: { createdAt: "desc" },
  })
  let usedBytes = 0n
  let backupCount = 0
  for (const backup of backups) {
    const size = typeof backup.sizeBytes === "bigint" ? backup.sizeBytes : BigInt(Number(backup.sizeBytes || 0))
    const isComplete = ["success", "completed"].includes(String(backup.status || "").toLowerCase())
    if (isComplete && size > 0n) usedBytes += size
    if (isComplete) backupCount += 1
  }
  return { usedBytes, usedGb: gbFromBytes(usedBytes), backupCount, backups }
}

export async function resolveBackupEntitlement(
  customerId: string,
  options: { settings?: BackupServiceSettings | null } = {},
): Promise<BackupEntitlementResult> {
  if (!customerId) return { entitled: false, entitlement: null, reason: "Customer not found" }

  const settings = options.settings || (await getBackupServiceSettings().catch(() => null))
  if (!settings?.enabled) {
    const hasLegacy = await customerHasBackupUsage(customerId)
    if (!hasLegacy) return { entitled: false, entitlement: null, reason: "Backup service is not available" }
  }

  const now = new Date()
  const subscription = await prisma.backupSubscription.findFirst({
    where: { customerId, status: { in: ["active", "grace", "expired"] } },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  })

  const defaultRetention = Number(settings?.defaultRetention ?? 10)
  const defaultStorageGb = Number(settings?.defaultStorageGb ?? 100)
  const defaultOverageRate = Number(settings?.defaultOverageRatePerGb ?? 1)
  const defaultSchedule = normalizeScheduleOptions(settings?.defaultScheduleOptions, [180])
  const defaultScheduleMinutes = Number(settings?.defaultScheduleMinutes ?? 180)

  if (subscription?.plan && (subscription.status === "active" || subscription.status === "grace")) {
    const plan = subscription.plan
    const scheduleOptions = normalizeScheduleOptions(plan.scheduleOptions as unknown, settings?.defaultScheduleOptions ? normalizeScheduleOptions(settings.defaultScheduleOptions, [180]) : [180])
    const extraStorageGb = Number(subscription.upgradeStorageGb || 0)
    const quotaGb = Number(plan.storageQuotaGb || 0) + extraStorageGb
    const effectiveSchedule = scheduleOptions.length ? scheduleOptions : [defaultScheduleMinutes]
    return {
      entitled: true,
      reason: null,
      entitlement: {
        subscriptionId: subscription.id,
        planId: plan.id,
        planName: String(plan.name || ""),
        status: subscription.status === "grace" ? "grace" : "active",
        paid: true,
        grandfathered: Boolean(subscription.grandfathered),
        maxBackups: Number(plan.maxBackups ?? null) || null,
        storageQuotaGb: quotaGb,
        storageQuotaBytes: BigInt(Math.round(bytesFromGb(quotaGb))),
        extraStorageGb,
        retentionCount: Number(plan.retentionCount ?? defaultRetention),
        manualBackupEnabled: Boolean(plan.manualBackupEnabled ?? settings?.enforcePlanPurchase !== false),
        automaticBackupEnabled: Boolean(plan.automaticBackupEnabled ?? true),
        scheduleOptions: effectiveSchedule,
        restoreEnabled: Boolean(plan.restoreEnabled ?? settings?.restoreRequiresActivePlan !== false),
        downloadEnabled: Boolean(plan.downloadEnabled ?? settings?.allowBackupDownload ?? false),
        overageEnabled: Boolean(plan.overageEnabled ?? true),
        overagePricePerGb: Number(plan.overagePricePerGb ?? defaultOverageRate),
        extraStoragePricePerGb: Number(plan.extraStoragePricePerGb ?? defaultOverageRate),
        gracePeriodDays: Number(plan.gracePeriodDays ?? settings?.gracePeriodDays ?? 3),
        maxStorageCapGb: plan.maxStorageCapGb != null ? Number(plan.maxStorageCapGb) : null,
        expiresAt: subscription.expiresAt,
        graceEndsAt: subscription.graceEndsAt,
        autoRenew: Boolean(subscription.autoRenew),
      },
    }
  }

  const hasLegacyUsage = await customerHasBackupUsage(customerId)
  if (hasLegacyUsage) {
    return {
      entitled: true,
      reason: null,
      entitlement: {
        subscriptionId: null,
        planId: null,
        planName: null,
        status: "legacy",
        paid: false,
        grandfathered: true,
        maxBackups: null,
        storageQuotaGb: defaultStorageGb,
        storageQuotaBytes: BigInt(Math.round(bytesFromGb(defaultStorageGb))),
        extraStorageGb: 0,
        retentionCount: defaultRetention,
        manualBackupEnabled: true,
        automaticBackupEnabled: true,
        scheduleOptions: normalizeScheduleOptions(settings?.defaultScheduleOptions, [defaultScheduleMinutes]),
        restoreEnabled: true,
        downloadEnabled: Boolean(settings?.allowBackupDownload ?? false),
        overageEnabled: false,
        overagePricePerGb: defaultOverageRate,
        extraStoragePricePerGb: defaultOverageRate,
        gracePeriodDays: Number(settings?.gracePeriodDays ?? 3),
        maxStorageCapGb: null,
        expiresAt: null,
        graceEndsAt: null,
        autoRenew: false,
      },
    }
  }

  return { entitled: false, entitlement: null, reason: "No backup plan active on this account. Purchase a backup plan to start backing up your servers." }
}

export function entitlementToJson(entitlement: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!entitlement) return entitlement ?? null
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(entitlement)) {
    if (typeof value === "bigint") out[key] = String(value)
    else if (value !== null && value !== undefined && (value as any).toISOString instanceof Function) out[key] = (value as Date).toISOString()
    else out[key] = value
  }
  return out
}

async function customerHasBackupUsage(customerId: string): Promise<boolean> {
  const instances = await prisma.vpsInstance.findMany({ where: { customerId, deletedAt: null }, select: { id: true } })
  if (!instances.length) return false
  const instanceIds = instances.map((instance) => instance.id)
  const existing = await prisma.vmBackup.findFirst({
    where: { vpsInstanceId: { in: instanceIds } },
    select: { id: true },
  }).catch(() => null)
  return Boolean(existing)
}

export function resolveOverStorage(input: {
  usedBytes: bigint
  storageQuotaBytes: bigint
  overageEnabled: boolean
  maxStorageCapGb: number | null
}): { overStorage: boolean; overageGb: number; overageBytes: bigint; overStoragePercent: number; capReached: boolean } {
  const quota = input.storageQuotaBytes > 0n ? input.storageQuotaBytes : 0n
  const overageBytes = input.usedBytes > quota ? input.usedBytes - quota : 0n
  const overageGb = overageBytes > 0n ? Math.ceil(gbFromBytes(overageBytes)) : 0
  const overStorage = overageGb > 0
  const percent = quota > 0n ? Math.round((Number(input.usedBytes) / Number(quota)) * 1000) / 10 : 0
  let capReached = false
  if (input.maxStorageCapGb != null && input.maxStorageCapGb > 0) {
    const capBytes = input.maxStorageCapGb * 1024 ** 3
    capReached = input.usedBytes > BigInt(capBytes)
  }
  return { overStorage, overageGb, overageBytes, overStoragePercent: percent, capReached }
}

export async function computeBackupUsageSummary(customerId: string, options: { entitlement?: BackupEntitlementOptions | null } = {}) {
  const entitlement = options.entitlement || (await resolveBackupEntitlement(customerId)).entitlement
  const usage = await computeBackupUsageForCustomer(customerId)
  if (!entitlement) {
    const zeroRemaining = 0n
    return { ...usage, entitled: false, entitleed: false, storageQuotaGb: 0, storageQuotaBytes: 0n, remainingBytes: zeroRemaining, remainingGb: 0, overStorage: false, overageEnabled: false, overageGb: 0, overStoragePercent: 0, capReached: false, maxBackups: null, effectiveBackupLimit: null, planMaxBackups: null, retentionCount: null, backupsRemaining: 0, planName: null, planId: null, subscriptionId: null, status: "none" as const, overageRatePerGb: 0 }
  }
  const over = resolveOverStorage({
    usedBytes: usage.usedBytes,
    storageQuotaBytes: entitlement.storageQuotaBytes,
    overageEnabled: entitlement.overageEnabled,
    maxStorageCapGb: entitlement.maxStorageCapGb,
  })
  // One limit, not two. `maxBackups` and `retentionCount` disagreed on the
  // production plan (15 vs 10) and this arithmetic used only `maxBackups`, so a
  // customer was told "5 of 15 backups remaining" while retention was pruning
  // to 10. Retention is the promise about what survives, so the stricter of the
  // two is what is enforced and what is reported.
  const effectiveLimit = effectiveBackupLimit({ maxBackups: entitlement.maxBackups ?? null, retentionCount: entitlement.retentionCount ?? null })
  const backupsRemaining = effectiveLimit == null ? null : Math.max(0, effectiveLimit - usage.backupCount)
  const remainingBytes = entitlement.storageQuotaBytes > usage.usedBytes ? entitlement.storageQuotaBytes - usage.usedBytes : 0n
  return {
    ...usage,
    entitled: true,
    storageQuotaGb: entitlement.storageQuotaGb,
    storageQuotaBytes: entitlement.storageQuotaBytes,
    remainingBytes,
    remainingGb: gbFromBytes(remainingBytes),
    overStorage: over.overStorage && entitlement.overageEnabled,
    overageEnabled: entitlement.overageEnabled,
    overageGb: over.overageGb,
    overStoragePercent: over.overStoragePercent,
    capReached: over.capReached,
    // Reported under both names so every existing surface shows the same number.
    maxBackups: effectiveLimit,
    effectiveBackupLimit: effectiveLimit,
    planMaxBackups: entitlement.maxBackups ?? null,
    retentionCount: entitlement.retentionCount ?? null,
    backupsRemaining,
    planName: entitlement.planName,
    planId: entitlement.planId,
    subscriptionId: entitlement.subscriptionId,
    status: entitlement.status,
    overageRatePerGb: entitlement.overagePricePerGb,
  }
}

export async function generateBackupOverage(input: {
  customerId: string
  subscriptionId: string
  usedBytes: bigint
  quotaBytes: bigint
  overageGb: number
  ratePerGb: number
  periodStart: Date
  periodEnd: Date
}) {
  if (input.overageGb <= 0 || input.ratePerGb <= 0) return null
  const amount = round2(mulAmount(input.overageGb, input.ratePerGb))
  return prisma.backupOverage.upsert({
    where: { id: `overage-${input.subscriptionId}-${Math.floor(input.periodStart.getTime() / 86400000)}` },
    create: {
      id: `overage-${input.subscriptionId}-${Math.floor(input.periodStart.getTime() / 86400000)}`,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      usedBytes: input.usedBytes,
      quotaBytes: input.quotaBytes,
      overageGb: round2(input.overageGb),
      ratePerGb: round2(input.ratePerGb),
      amount,
      status: "unbilled",
    },
    update: {
      usedBytes: input.usedBytes,
      quotaBytes: input.quotaBytes,
      overageGb: round2(input.overageGb),
      ratePerGb: round2(input.ratePerGb),
      amount,
      periodEnd: input.periodEnd,
    },
  })
}

/**
 * ONE canonical source of backup entitlement + live usage for a customer.
 *
 * Every client page (backups, backup plans, dashboard, billing) MUST read from
 * this same function so no two pages display different numbers. Usage is always
 * computed live from the authoritative ownership-scoped backup inventory
 * (customer -> vpsInstance -> completed vm_backups), never from browser state.
 */
export async function getCustomerBackupEntitlement(customerId: string) {
  const entitlementResult = await resolveBackupEntitlement(customerId)
  const ent = entitlementResult.entitlement
  const summary = await computeBackupUsageSummary(customerId, { entitlement: ent })
  const quotaBytes = summary.storageQuotaBytes || 0n
  const usedBytes = summary.usedBytes || 0n
  const remainingBytes = quotaBytes > usedBytes ? quotaBytes - usedBytes : 0n
  const graceState = ent
    ? ent.status === "grace"
      ? "grace"
      : ent.status === "legacy"
        ? "legacy"
        : ent.status === "active"
          ? "active"
          : "none"
    : "none"
  return {
    entitled: summary.entitled,
    reason: entitlementResult.reason,
    plan: ent
      ? {
          id: ent.planId,
          name: ent.planName,
          status: ent.status,
          subscriptionId: ent.subscriptionId,
          expiresAt: ent.expiresAt,
          graceEndsAt: ent.graceEndsAt,
          autoRenew: ent.autoRenew,
          paid: ent.paid,
          grandfathered: ent.grandfathered,
          manualEnabled: Boolean(ent.manualBackupEnabled),
          autoEnabled: Boolean(ent.automaticBackupEnabled),
          overageEnabled: Boolean(ent.overageEnabled),
          overagePricePerGb: ent.overagePricePerGb,
          extraStoragePricePerGb: ent.extraStoragePricePerGb,
          gracePeriodDays: ent.gracePeriodDays,
          maxStorageCapGb: ent.maxStorageCapGb,
          retentionCount: ent.retentionCount,
          scheduleOptions: ent.scheduleOptions,
          storageUpgradeGb: ent.extraStorageGb,
        }
      : null,
    usage: {
      usedBytes,
      usedGb: summary.usedGb,
      backupCount: summary.backupCount,
      usedBackups: summary.backupCount,
      storageQuotaGb: summary.storageQuotaGb,
      storageQuotaBytes: quotaBytes,
      remainingBytes,
      remainingGb: gbFromBytes(remainingBytes),
      remainingBackups: summary.backupsRemaining,
      maxBackups: summary.maxBackups,
      overStorage: Boolean(summary.overStorage),
      overageEnabled: Boolean(summary.overageEnabled),
      overageGb: summary.overageGb,
      overageRatePerGb: summary.overageRatePerGb,
      overStoragePercent: summary.overStoragePercent,
      capReached: Boolean(summary.capReached),
      graceState,
      planName: summary.planName || null,
      planId: summary.planId || null,
      subscriptionId: summary.subscriptionId || null,
      status: summary.status,
      paid: ent ? Boolean(ent.paid) : false,
    },
  }
}

export type RebuildBackupUsageOptions = {
  /** Restrict reconciliation to a single customer. */
  customerId?: string
  /** Persist the reconciled snapshot + materialize overage (default true). */
  persist?: boolean
}

export type RebuildBackupUsageResult = {
  customerId: string
  before: { backupCount: number; usedBytes: bigint }
  after: { backupCount: number; usedBytes: bigint }
  corrected: boolean
  quotaGb: number
  overageGb: number
  overageAmount: number | null
  snapshotId: string | null
}

function backupUsagePeriodKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

function monthPeriodStart() {
  const date = new Date()
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function monthPeriodEnd() {
  const date = new Date()
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999))
}

/**
 * Safe, idempotent usage reconciliation (Part 4.4).
 *
 * Recomputes the authoritative usage from the ownership-scoped backup
 * inventory, compares it against the last persisted snapshot, and atomically
 * updates the `backup_usage` snapshot for the current period. When the active
 * plan allows overage, the billable overage row is materialized/refreshed.
 *
 * This NEVER scans Proxmox storage and never deletes/alters backup records:
 * it only reads vm_backups and writes the usage snapshot + overage ledger.
 * Audit information is recorded via the panel log for every correction.
 */
export async function rebuildBackupUsage(options: RebuildBackupUsageOptions = {}): Promise<RebuildBackupUsageResult[]> {
  const persist = options.persist !== false
  const customers = options.customerId
    ? [String(options.customerId)]
    : (
        await prisma.vpsInstance
          .findMany({ where: { deletedAt: null }, select: { customerId: true }, distinct: ["customerId"] })
          .catch(() => [])
      )
        .map((row) => row.customerId)
        .filter(Boolean)

  const results: RebuildBackupUsageResult[] = []
  for (const customerId of customers) {
    try {
      const before = await computeBackupUsageForCustomer(customerId)
      const entitlementResult = await resolveBackupEntitlement(customerId)
      const ent = entitlementResult.entitlement
      const summary = await computeBackupUsageSummary(customerId, { entitlement: ent })
      const after = { backupCount: summary.backupCount, usedBytes: summary.usedBytes || 0n }
      const corrected = before.backupCount !== after.backupCount || before.usedBytes !== after.usedBytes
      const hasSubscription = Boolean(ent?.subscriptionId)
      let snapshotId: string | null = null
      let overageAmount: number | null = null

      if (persist && hasSubscription && ent) {
        const periodStart = monthPeriodStart()
        const periodEnd = monthPeriodEnd()
        const snapshot = await prisma.backupUsage.upsert({
          where: { id: `usage-${ent.subscriptionId}-${backupUsagePeriodKey()}` },
          create: {
            id: `usage-${ent.subscriptionId}-${backupUsagePeriodKey()}`,
            subscriptionId: ent.subscriptionId as string,
            customerId,
            periodStart,
            periodEnd: null,
            usedBytes: after.usedBytes,
            backupCount: after.backupCount,
            quotaGb: Number(summary.storageQuotaGb || 0),
            overageGb: round2(summary.overageGb || 0),
            computedAt: new Date(),
            metadata: { corrected, source: "rebuildBackupUsage" },
          },
          update: {
            usedBytes: after.usedBytes,
            backupCount: after.backupCount,
            quotaGb: Number(summary.storageQuotaGb || 0),
            overageGb: round2(summary.overageGb || 0),
            periodEnd: null,
            computedAt: new Date(),
            metadata: { corrected, source: "rebuildBackupUsage" },
          },
        })
        snapshotId = snapshot.id

        // Materialize the billable overage (Part 4.8) when the plan opts in.
        if (ent.overageEnabled && summary.overStorage && Number(summary.overageGb || 0) > 0) {
          const bill = await generateBackupOverage({
            customerId,
            subscriptionId: ent.subscriptionId as string,
            usedBytes: after.usedBytes,
            quotaBytes: ent.storageQuotaBytes,
            overageGb: summary.overageGb,
            ratePerGb: ent.overagePricePerGb,
            periodStart,
            periodEnd,
          })
          overageAmount = bill?.amount != null ? Number(bill.amount) : null
        }
      }

      results.push({
        customerId,
        before: { backupCount: before.backupCount, usedBytes: before.usedBytes },
        after,
        corrected,
        quotaGb: Number(summary.storageQuotaGb || 0),
        overageGb: Number(summary.overageGb || 0),
        overageAmount,
        snapshotId,
      })

      if (corrected || options.customerId) {
        await createPanelLog({
          category: "Backup",
          level: corrected ? "warn" : "info",
          message: corrected ? "Backup usage reconciled (corrected)" : "Backup usage reconciled (consistent)",
          actorType: "system",
          customerId: customerId || undefined,
          metadata: {
            beforeCount: before.backupCount,
            beforeBytes: before.usedBytes.toString(),
            afterCount: after.backupCount,
            afterBytes: after.usedBytes.toString(),
            snapshotId,
            overageGb: Number(summary.overageGb || 0),
            overageAmount,
          },
        }).catch(() => null)
      }
    } catch (error) {
      await createPanelLog({
        category: "Backup",
        level: "error",
        message: "Backup usage reconciliation failed",
        actorType: "system",
        metadata: { customerId, error: String((error as Error)?.message || error) },
      }).catch(() => null)
    }
  }
  return results
}