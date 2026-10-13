#!/usr/bin/env node

/**
 * Referral reporting demo + reconciler.
 *
 * Two jobs, both against authoritative records:
 *
 *   scripts/referral-demo.ts --sync
 *       Materialise the commission ledger for every referred customer. Safe to
 *       run repeatedly; it only writes rows for real qualifying transactions.
 *
 *   scripts/referral-demo.ts --check
 *       Read-only. Prints the referral report for the live database and
 *       reconciles the reported revenue against a direct SQL aggregate, so a
 *       number in the dashboard can be traced back to the invoice table.
 *
 *   scripts/referral-demo.ts --walkthrough <referrerCustomerId> <referredCustomerId>
 *       Disposable end-to-end walkthrough: creates referral accounts and an
 *       attribution for two existing customers, runs the ledger sync, prints
 *       every report the UI shows, proves one referrer cannot see another's
 *       data, and then deletes exactly the rows it created. Use --keep to
 *       leave them in place.
 *
 * The walkthrough never creates customers, orders, invoices or services.
 */

import "dotenv/config"
import { prisma } from "@/lib/db"
import { ensureReferralAccount, captureReferral } from "@/lib/referrals/attribution"
import { clearReferralProgramCache } from "@/lib/referrals/program"
import { syncAndReverse } from "@/lib/referrals/sync"
import {
  buildReferralDataset,
  clientCommissionList,
  clientCustomerList,
  clientOrderList,
  clientSummary,
  dailyReport,
  fetchReferralSources,
  monthlyReport,
  referralFiltersFromParams,
  serviceReport,
} from "@/lib/referrals/service"
import { resolveReferralWindow } from "@/lib/referrals/filters"

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(34)} ${typeof value === "string" ? value : JSON.stringify(value)}`)
}

async function sync() {
  clearReferralProgramCache()
  const result = await syncAndReverse({ limit: 5000 })
  console.log("Referral ledger sync")
  line("scanned transactions", result.synced.scanned)
  line("commissions created", result.synced.created)
  line("commissions updated", result.synced.updated)
  line("commissions skipped", result.synced.skipped)
  line("commissions reversed", result.reversed)
  line("errors", result.errors.length)
  if (result.errors.length) {
    console.error(result.errors.slice(0, 10))
    process.exitCode = 1
  }
}

async function loadReport(range: string) {
  const window = resolveReferralWindow({ range })
  const filters = referralFiltersFromParams({ range })
  const sources = await fetchReferralSources({})
  const dataset = await buildReferralDataset({
    sources: sources.sources,
    window,
    maskEmails: false,
    truncated: sources.truncated,
    referralTotal: sources.total,
  })
  return { window, filters, dataset }
}

async function check() {
  const { dataset } = await loadReport("all")
  const summary = clientSummary(dataset)

  console.log("Referral report (all time)")
  line("referral rows in scope", dataset.referralTotal)
  line("total referrals", summary.totalReferrals)
  line("active referrals", summary.activeReferrals)
  line("inactive referrals", summary.inactiveReferrals)
  line("registered referrals", summary.registeredReferrals)
  line("conversion rate %", summary.conversionRate)
  line("referred orders", summary.referredOrders)
  line("referral revenue", summary.referralRevenue)
  line("commission earned", summary.commissionEarned)
  line("commission pending", summary.commissionPending)
  line("commission paid", summary.commissionPaid)
  line("commission reversed", summary.commissionReversed)

  console.log("\nMonthly performance")
  for (const row of monthlyReport(dataset)) {
    console.log(`  ${row.label.padEnd(34)} orders=${row.orders} revenue=${row.revenue} commission=${row.commissionEarned}`)
  }

  console.log("\nService-wise performance")
  for (const row of serviceReport(dataset)) {
    console.log(`  ${String(row.productName).padEnd(34)} orders=${row.orders} revenue=${row.revenue} commission=${row.commissionEarned}`)
  }

  console.log("\nDaily performance (last rows)")
  for (const row of dailyReport(dataset).slice(-5)) {
    console.log(`  ${row.day.padEnd(34)} orders=${row.orders} revenue=${row.revenue}`)
  }

  // Independent reconciliation: the same revenue number, straight out of the
  // invoice table for the referred customers, with no referral code involved.
  const referredIds = await prisma.referral.findMany({ select: { referredCustomerId: true } })
  const ids = Array.from(new Set(referredIds.map((row) => row.referredCustomerId)))
  let expected = 0
  if (ids.length) {
    const rows = await prisma.invoice.findMany({
      where: {
        customerId: { in: ids },
        status: "paid",
        type: "service",
        deletedAt: null,
        order: {
          is: {
            deletedAt: null,
            isActive: true,
            status: { in: ["paid", "active", "completed", "payment_verified"] },
          },
        },
      },
      select: { totalAmount: true },
    })
    expected = Number(rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0).toFixed(2))
  }

  console.log("\nReconciliation")
  line("report revenue", summary.referralRevenue)
  line("SQL invoice revenue", expected)
  const ok = Math.abs(expected - summary.referralRevenue) < 0.01
  line("match", ok ? "YES" : "NO")
  if (!ok) process.exitCode = 1
}

async function walkthrough(referrerCustomerId: string, referredCustomerId: string, keep: boolean) {
  const created = { accounts: [] as string[], referralId: "" as string, commissions: [] as string[] }
  try {
    await runWalkthrough(referrerCustomerId, referredCustomerId, keep, created)
  } finally {
    // A walkthrough must never leave anything behind, not even when it fails
    // halfway through - otherwise a demo would be a production data change.
    if (!keep && (created.accounts.length || created.referralId || created.commissions.length)) {
      await prisma.referralCommission.deleteMany({ where: { id: { in: created.commissions } } })
      if (created.referralId) await prisma.referral.deleteMany({ where: { id: created.referralId } })
      await prisma.referralAccount.deleteMany({ where: { id: { in: created.accounts } } })
      console.log("\nCleanup")
      line("referral accounts removed", created.accounts.length)
      line("referrals removed", created.referralId ? 1 : 0)
      line("commissions removed", created.commissions.length)
    }
  }
}

async function runWalkthrough(
  referrerCustomerId: string,
  referredCustomerId: string,
  keep: boolean,
  created: { accounts: string[]; referralId: string; commissions: string[] },
) {
  const referrer = await prisma.customer.findUnique({ where: { id: referrerCustomerId }, select: { id: true, email: true } })
  const referred = await prisma.customer.findUnique({ where: { id: referredCustomerId }, select: { id: true, email: true } })
  if (!referrer || !referred) throw new Error("Both customer ids must exist")
  if (referrer.id === referred.id) throw new Error("A customer cannot refer themselves")

  const referrerBefore = await prisma.referralAccount.findUnique({ where: { customerId: referrerCustomerId }, select: { id: true } })
  const referredBefore = await prisma.referralAccount.findUnique({ where: { customerId: referredCustomerId }, select: { id: true } })
  const existingAttribution = await prisma.referral.findUnique({ where: { referredCustomerId }, select: { id: true } })
  if (existingAttribution) throw new Error("That referred customer already has an attribution; refusing to overwrite it")

  console.log("Walkthrough")
  line("referrer", `${referrer.email} (${referrer.id})`)
  line("referred", `${referred.email} (${referred.id})`)

  const referrerAccount = await ensureReferralAccount(referrerCustomerId)
  if (!referrerAccount) throw new Error("Could not create the referrer account")
  if (!referrerBefore) created.accounts.push(referrerAccount.accountId)
  line("referral code", referrerAccount.code)
  line("referral link", `/register?ref=${referrerAccount.code}`)

  const referredAccount = await ensureReferralAccount(referredCustomerId)
  if (referredAccount && !referredBefore) created.accounts.push(referredAccount.accountId)

  const captured = await captureReferral({
    referredCustomerId,
    code: referrerAccount.code,
    source: "code",
    metadata: { source: "referral_demo_walkthrough" },
  })
  line("attribution result", captured.status)
  if (captured.status === "created") created.referralId = captured.referralId
  if (captured.status !== "created") throw new Error(`Expected a new attribution, got ${captured.status}`)

  clearReferralProgramCache()
  const syncResult = await syncAndReverse({ referrerCustomerId, limit: 1000 })
  line("ledger created", syncResult.synced.created)
  line("ledger updated", syncResult.synced.updated)
  line("ledger reversed", syncResult.reversed)
  line("ledger errors", syncResult.errors.length)

  const createdCommissions = await prisma.referralCommission.findMany({
    where: { referralId: created.referralId },
    select: { id: true },
  })
  created.commissions = createdCommissions.map((row) => row.id)

  const { dataset } = await loadReport("all")
  const filters = referralFiltersFromParams({ range: "all" })
  const own = await fetchReferralSources({ referrerAccountId: referrerAccount.accountId })
  const ownDataset = await buildReferralDataset({
    sources: own.sources,
    window: resolveReferralWindow({ range: "all" }),
    maskEmails: true,
  })

  console.log("\nReferrer view")
  const summary = clientSummary(ownDataset)
  line("total referrals", summary.totalReferrals)
  line("active referrals", summary.activeReferrals)
  line("referred orders", summary.referredOrders)
  line("referral revenue", summary.referralRevenue)
  line("commission earned", summary.commissionEarned)
  line("commission pending", summary.commissionPending)
  line("commission paid", summary.commissionPaid)

  const customers = clientCustomerList({ dataset: ownDataset, filters, status: "all", search: "" })
  line("customers on page 1", `${customers.rows.length} of ${customers.pagination.total}`)
  for (const row of customers.rows) {
    console.log(`  - ${row.name} <${row.email}> status=${row.status} registered=${row.registeredAt.slice(0, 10)} orders=${row.orderCount} spent=${row.totalSpent} commission=${row.commissionEarned}`)
  }

  const orders = clientOrderList({ dataset: ownDataset, filters, search: "" })
  console.log("\nReferred orders")
  for (const row of orders.rows) {
    console.log(`  - ${row.orderNumber} ${row.productName} service=${row.serviceName || "-"} purchased=${row.purchaseDate.slice(0, 10)} period=${row.billingPeriod} amount=${row.amount} payment=${row.paymentStatus} commission=${row.commission.amount} (${row.commission.status})`)
  }

  const commissions = clientCommissionList({ dataset: ownDataset, filters, search: "", referrerCustomerId })
  line("commission rows", commissions.pagination.total)

  console.log("\nMonthly report (referrer)")
  for (const row of monthlyReport(ownDataset)) {
    console.log(`  ${row.label.padEnd(34)} orders=${row.orders} revenue=${row.revenue} commission=${row.commissionEarned}`)
  }

  // Ownership: a second referrer must not be able to read the first referrer's
  // referrals, orders or commissions, even with the correct customer id.
  const other = await prisma.customer.findFirst({
    where: { id: { notIn: [referrerCustomerId, referredCustomerId] } },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  })
  if (other) {
    const otherAccount = await ensureReferralAccount(other.id)
    if (otherAccount && !created.accounts.includes(otherAccount.accountId)) created.accounts.push(otherAccount.accountId)
    const otherSources = await fetchReferralSources({ referrerAccountId: otherAccount?.accountId })
    const otherDataset = await buildReferralDataset({
      sources: otherSources.sources,
      window: resolveReferralWindow({ range: "all" }),
      maskEmails: true,
    })
    const otherLeak = ownDataset.transactions.filter((row) => otherDataset.transactions.some((theirs) => theirs.orderId === row.orderId))
    console.log("\nOwnership check")
    line("other referrer", other.email)
    line("their referrals", otherDataset.customers.length)
    line("orders leaked to them", otherLeak.length)
    line("their commissions include ours", otherDataset.transactions.some((row) => ownDataset.transactions.some((ours) => ours.orderId === row.orderId)))
  }

  console.log("\nAdmin view")
  line("referral rows in scope", dataset.referralTotal)
  line("admin referral revenue", clientSummary(dataset).referralRevenue)
  const ledger = await prisma.referralCommission.findMany({
    where: { referralId: created.referralId },
    select: { orderId: true, amount: true, ratePercent: true, baseAmount: true, status: true, kind: true, earnedAt: true },
  })
  for (const row of ledger) {
    console.log(`  - order=${row.orderId} base=${row.baseAmount} rate=${row.ratePercent}% amount=${row.amount} status=${row.status} kind=${row.kind} earned=${row.earnedAt.toISOString().slice(0, 10)}`)
  }

  if (!keep) {
    console.log("\nKeeping rows for inspection. Re-run without --keep next time to clean up automatically.")
  } else {
    console.log("\nKept. Referral id:", created.referralId)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const keep = args.includes("--keep")
  const syncIndex = args.indexOf("--sync")
  const checkIndex = args.indexOf("--check")
  const walkIndex = args.indexOf("--walkthrough")

  if (syncIndex >= 0) return sync()
  if (checkIndex >= 0) return check()
  if (walkIndex >= 0) {
    const referrer = args[walkIndex + 1]
    const referred = args[walkIndex + 2]
    if (!referrer || !referred) throw new Error("Usage: --walkthrough <referrerCustomerId> <referredCustomerId> [--keep]")
    return walkthrough(referrer, referred, keep)
  }

  console.log("Usage:")
  console.log("  tsx scripts/referral-demo.ts --sync")
  console.log("  tsx scripts/referral-demo.ts --check")
  console.log("  tsx scripts/referral-demo.ts --walkthrough <referrerCustomerId> <referredCustomerId> [--keep]")
  process.exitCode = 1
}

main()
  .catch((error) => {
    console.error("[REFERRAL_DEMO] failed", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })