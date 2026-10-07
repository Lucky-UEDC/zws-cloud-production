/**
 * Diagnostics health model.
 *
 * The previous Diagnostics page lumped every historical `failed` provisioning
 * job into one number and rendered it next to the live queue, which made a
 * long-past outage look like a current one. Measured on production before this
 * change: 957 `failed` rows, all of them from **5 distinct orders** retried
 * 13-559 times each - one order had 559 failures and every one of them was
 * already represented by a VM that existed.
 *
 * Nothing here deletes or repairs anything. Every figure is a read, and each
 * one states exactly what window it covers so an operator can tell "broken
 * right now" from "was broken once".
 */

import { prisma } from "@/lib/db"

/** A job is "stale" once nothing has touched it for this long. */
export const STALE_JOB_MINUTES = 30
/** The window used for "recent" failure reporting. */
export const RECENT_WINDOW_HOURS = 24
/**
 * A reinstall lock is only stale past the timeout the reinstall API itself
 * applies (`STALE_REINSTALL_LOCK_MS` in the reinstall route, 6 hours). Using a
 * 30-minute threshold here reported three locks as violations that the app
 * considers perfectly healthy in-progress reinstalls.
 */
export const STALE_REINSTALL_LOCK_HOURS = 6

export type JobCounts = {
  /** Currently queued, running or retrying. This is real work in flight. */
  active: number
  /** In flight but untouched for longer than the stale threshold. */
  stale: number
  /** Waiting on a human. Not broken, but not moving either. */
  waitingForAdmin: number
  /** Failed inside the recent window. */
  failedRecent: number
  /** Failed all-time. Historical, and deliberately kept. */
  failedHistorical: number
  /** Distinct orders behind the recent failures. */
  failedRecentOrders: number
  /** Distinct orders behind all failures. */
  failedHistoricalOrders: number
  /** Completed, for context on how much of the queue actually succeeds. */
  completed: number
  cancelled: number
}

export type IntegrityChecks = {
  key: string
  label: string
  count: number
  /** How an operator should read a non-zero count. */
  severity: "violation" | "expected" | "informational"
  detail: string
}

export type DiagnosticsHealth = {
  generatedAt: string
  staleJobMinutes: number
  recentWindowHours: number
  jobs: JobCounts
  integrity: IntegrityChecks[]
  nodes: Array<{
    id: string
    name: string
    nodeName: string
    host: string
    status: string | null
    isActive: boolean
    lastCheckedAt: string | null
  }>
}

function toInt(value: unknown): number {
  return Number(value || 0)
}

export async function getDiagnosticsHealth(): Promise<DiagnosticsHealth> {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - STALE_JOB_MINUTES * 60_000)
  // Separate threshold: a reinstall lock is healthy until the API's own 6-hour
  // timeout, not until the job staleness window.
  const staleReinstallBefore = new Date(now.getTime() - STALE_REINSTALL_LOCK_HOURS * 60 * 60_000)
  const recentBefore = new Date(now.getTime() - RECENT_WINDOW_HOURS * 60 * 60_000)

  const [statusRows, activeRows, staleRows, failedRecentRows, failedAllRows, failedRecentOrders, failedAllOrders, rawIntegrity, nodes] = await Promise.all([
    prisma.provisioningJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.provisioningJob.count({ where: { status: { in: ["queued", "running", "retrying"] } } }),
    prisma.provisioningJob.count({ where: { status: { in: ["queued", "running", "retrying"] }, updatedAt: { lt: staleBefore } } }),
    prisma.provisioningJob.count({ where: { status: "failed", updatedAt: { gte: recentBefore } } }),
    prisma.provisioningJob.count({ where: { status: "failed" } }),
    prisma.provisioningJob.findMany({ where: { status: "failed", updatedAt: { gte: recentBefore } }, distinct: ["orderId"], select: { orderId: true } }),
    prisma.provisioningJob.findMany({ where: { status: "failed" }, distinct: ["orderId"], select: { orderId: true } }),
    prisma.$queryRaw<Array<Record<string, bigint | number>>>`
      SELECT
        (SELECT count(*) FROM (SELECT "ipAddress" FROM vps_instances WHERE "deletedAt" IS NULL AND "ipAddress" IS NOT NULL GROUP BY "ipAddress" HAVING count(*) > 1) d) AS "duplicateIps",
        (SELECT count(*) FROM (SELECT vmid FROM vps_instances WHERE "deletedAt" IS NULL AND vmid > 0 GROUP BY vmid HAVING count(*) > 1) d) AS "duplicateVmids",
        (SELECT count(*) FROM (SELECT "orderNumber" FROM orders GROUP BY "orderNumber" HAVING count(*) > 1) d) AS "duplicateOrders",
        (SELECT count(*) FROM (SELECT "gatewayTransactionId" FROM payments WHERE lower(status) IN ('completed','paid','success') AND "gatewayTransactionId" IS NOT NULL GROUP BY "gatewayTransactionId" HAVING count(*) > 1) d) AS "duplicatePayments",
        -- Orderless invoices are only a violation when they represent a real charge.
        -- The production table contains 13 rows whose numbers all start with
        -- "INV-CHK-": checkout-probe artifacts that created a real paid invoice
        -- with no order. Calling those a financial violation is a false alarm,
        -- so they are counted separately and named.
        (SELECT count(*) FROM invoices WHERE "deletedAt" IS NULL AND lower(coalesce(type,'service'))='service' AND "orderId" IS NULL AND "invoiceNumber" NOT LIKE 'INV-CHK-%') AS "orderlessInvoices",
        (SELECT count(*) FROM invoices WHERE "deletedAt" IS NULL AND "orderId" IS NULL AND "invoiceNumber" LIKE 'INV-CHK-%') AS "checkoutProbeInvoices",
        (SELECT count(*) FROM vps_instances v LEFT JOIN ip_allocations a ON a."vpsInstanceId"=v.id AND lower(a.status) IN ('assigned','reserved','active','used') WHERE v."deletedAt" IS NULL AND v."ipAddress" IS NOT NULL AND a.id IS NULL) AS "missingIpAllocations",
        (SELECT count(*) FROM vps_instances v LEFT JOIN vm_provisioning_identities i ON i.vps_instance_id=v.id WHERE v."deletedAt" IS NULL AND v.vmid > 0 AND i.id IS NULL) AS "missingProvisioningIdentities",
        (SELECT count(*) FROM vm_provisioning_identities i LEFT JOIN vps_instances v ON v.id=i.vps_instance_id WHERE i.vps_instance_id IS NOT NULL AND (v.id IS NULL OR v."deletedAt" IS NOT NULL)) AS "orphanProvisioningIdentities",
        (SELECT count(*) FROM ip_allocations a LEFT JOIN vps_instances v ON v.id=a."vpsInstanceId" WHERE a."vpsInstanceId" IS NOT NULL AND v.id IS NULL) AS "orphanIpAllocations",
        (SELECT count(*) FROM provisioning_jobs j LEFT JOIN orders o ON o.id=j."orderId" WHERE j."orderId" IS NOT NULL AND o.id IS NULL) AS "orphanProvisionJobs",
        -- vps_instances spells these two in snake_case (verified against the
        -- live schema) while the rest of that table is camelCase. Quoting them
        -- in the camelCase style is a Postgres error, not an empty result.
        (SELECT count(*) FROM vps_instances WHERE reinstall_lock = true AND reinstall_locked_at IS NOT NULL AND reinstall_locked_at < ${staleReinstallBefore}) AS "staleReinstallLocks",
        (SELECT count(*) FROM payments WHERE lower(status) = 'failed') AS "failedPayments",
        (SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated) AS "unvalidatedForeignKeys"
    `,
    prisma.proxmoxNode.findMany({
      select: { id: true, name: true, nodeName: true, host: true, status: true, isActive: true, lastCheckedAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ])

  const byStatus = new Map(statusRows.map((row) => [String(row.status), toInt(row._count._all)]))
  const raw = (rawIntegrity[0] || {}) as Record<string, bigint | number>
  const count = (key: string) => toInt(raw[key])

  const jobs: JobCounts = {
    active: activeRows,
    stale: staleRows,
    waitingForAdmin: byStatus.get("waiting_for_admin") || 0,
    failedRecent: failedRecentRows,
    failedHistorical: failedAllRows,
    failedRecentOrders: failedRecentOrders.length,
    failedHistoricalOrders: failedAllOrders.length,
    completed: byStatus.get("completed") || 0,
    cancelled: byStatus.get("cancelled") || 0,
  }

  const integrity: IntegrityChecks[] = [
    { key: "duplicateIps", label: "Duplicate live IPs", count: count("duplicateIps"), severity: "violation", detail: "Two live servers share an IP address. Traffic would be split between them." },
    { key: "duplicateVmids", label: "Duplicate VMIDs", count: count("duplicateVmids"), severity: "violation", detail: "Two live servers share a Proxmox VMID. One of them is unreachable on that node." },
    { key: "duplicateOrders", label: "Duplicate order numbers", count: count("duplicateOrders"), severity: "violation", detail: "An order number is used twice, so an invoice could attach to the wrong order." },
    { key: "duplicatePayments", label: "Duplicate captured payments", count: count("duplicatePayments"), severity: "violation", detail: "One provider transaction was captured more than once." },
    { key: "orderlessInvoices", label: "Service invoices without an order", count: count("orderlessInvoices"), severity: "violation", detail: "A real invoice exists with no order to reconcile against. This is money recorded against nothing." },
    { key: "checkoutProbeInvoices", label: "Checkout-probe invoices (no order)", count: count("checkoutProbeInvoices"), severity: "expected", detail: "Numbered INV-CHK-*. Created by checkout probes, not by customer orders. Harmless, and counted separately so they never inflate the violation count above." },
    { key: "missingIpAllocations", label: "Live servers without an IP allocation", count: count("missingIpAllocations"), severity: "violation", detail: "A live server has an address that the IPAM does not own." },
    { key: "missingProvisioningIdentities", label: "Live servers without provisioning identity", count: count("missingProvisioningIdentities"), severity: "violation", detail: "A server exists with a VMID but no identity, so a retry cannot tell whether its VM is the one it would recreate." },
    { key: "orphanProvisioningIdentities", label: "Provisioning identities for deleted servers", count: count("orphanProvisioningIdentities"), severity: "expected", detail: "Historical. Kept deliberately so a retry of an old order can still recognise the VM it already built." },
    { key: "orphanIpAllocations", label: "IP allocations with no server", count: count("orphanIpAllocations"), severity: "violation", detail: "An address is reserved for a server that does not exist." },
    { key: "orphanProvisionJobs", label: "Provisioning jobs with no order", count: count("orphanProvisionJobs"), severity: "violation", detail: "A job references an order that no longer exists." },
    { key: "staleReinstallLocks", label: "Reinstall locks held past the timeout", count: count("staleReinstallLocks"), severity: "violation", detail: "A crashed reinstall left its lock held, so the customer is blocked from reinstalling until it clears. The reinstall API reclaims these safely on the next attempt - no manual step is needed." },
    { key: "failedPayments", label: "Failed payments (historical)", count: count("failedPayments"), severity: "informational", detail: "Attempts that were declined or errored. Retained as financial history." },
    { key: "unvalidatedForeignKeys", label: "Unvalidated foreign keys", count: count("unvalidatedForeignKeys"), severity: "violation", detail: "A foreign key constraint has not been validated by PostgreSQL." },
  ]

  return {
    generatedAt: now.toISOString(),
    staleJobMinutes: STALE_JOB_MINUTES,
    recentWindowHours: RECENT_WINDOW_HOURS,
    jobs,
    integrity,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      nodeName: node.nodeName,
      host: node.host,
      status: node.status || null,
      isActive: node.isActive,
      lastCheckedAt: node.lastCheckedAt ? node.lastCheckedAt.toISOString() : null,
    })),
  }
}

/**
 * Why a failed job is (or is not) recoverable, from data already on the job.
 *
 * This never decides to retry anything. It is the information an admin needs
 * before they press Retry, and it is the same distinction the retry path uses
 * to refuse a retry that would build a second VM.
 */
export function classifyFailedJob(input: {
  attempts: number
  maxAttempts: number
  orderStatus: string | null
  provisioningStatus: string | null
  vmsInstanceCount: number
  identityPhase: string | null
  hasVmId: boolean
}): { classification: "historical" | "recoverable" | "stale" | "permanently_failed" | "duplicate" | "completed" | "cancelled"; reason: string } {
  const order = String(input.orderStatus || "").toUpperCase()
  const provisioning = String(input.provisioningStatus || "").toUpperCase()

  // The VM exists but the job still failed: the service is up, the job row is
  // just the record of the attempt that did not finish.
  if (provisioning === "ACTIVE" || order === "ACTIVE") {
    return { classification: "historical", reason: "Order already provisioned and active. This row records an attempt that did not finish; the service is unaffected." }
  }
  if (provisioning === "CANCELLED" || order === "CANCELLED") {
    return { classification: "cancelled", reason: "Order was cancelled." }
  }
  if (provisioning === "COMPLETED" || provisioning === "SERVICE_ACTIVE") {
    return { classification: "completed", reason: "Provisioning already completed." }
  }
  if (Number(input.attempts) >= Number(input.maxAttempts)) {
    return { classification: "permanently_failed", reason: `Retry limit reached (${input.attempts}/${input.maxAttempts}). Needs an explicit admin resume.` }
  }
  if (input.vmsInstanceCount > 1) {
    return { classification: "duplicate", reason: "More than one server row is attached to this order. Retrying could create another VM." }
  }
  if (input.hasVmId || String(input.identityPhase || "").toUpperCase() === "READY") {
    return { classification: "stale", reason: "A VM already exists for this order. Retry must resume the existing VM, never clone a new one." }
  }
  if (["PAID", "ACTIVE"].includes(order)) {
    return { classification: "recoverable", reason: "Order is paid with no server built yet. Retry is safe." }
  }
  return { classification: "recoverable", reason: "Order state allows a retry." }
}
