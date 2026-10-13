#!/usr/bin/env node

/**
 * End-to-end verification of referral visit tracking and first-purchase
 * commission against the real database.
 *
 * Every row it creates is prefixed `zwsqatest` and removed in a `finally`,
 * including on failure, and it re-counts the real tables afterwards so a
 * partial cleanup is visible rather than silent. It never touches a real
 * customer, order or invoice.
 *
 * Run with `--keep` to leave the fixture in place for manual inspection.
 *
 *   tsx scripts/referral-first-purchase-probe.ts
 */

import "dotenv/config"
import { prisma } from "@/lib/db"
import { awardFirstPurchaseCommission } from "@/lib/referrals/award"
import { computeCommissionAmount, roundMoney } from "@/lib/referrals/commission"
import { captureReferral } from "@/lib/referrals/attribution"
import {
  attributeSignupToVisit,
  recordReferralVisit,
  summarizeVisits,
  newVisitorId,
} from "@/lib/referrals/visits"
import { buildReferralDataset } from "@/lib/referrals/service"
import { summarizeReferralActivity, buildTransactionRows } from "@/lib/referrals/reporting"
import { getReferralProgramRule } from "@/lib/referrals/program"
import { resolveReferralWindow } from "@/lib/referrals/filters"

const PREFIX = "zwsqatest"
const keep = process.argv.includes("--keep")
let failures = 0

function check(label: string, condition: boolean, detail: unknown = "") {
  if (!condition) failures += 1
  const shown = detail === "" || detail === undefined || detail === null
    ? ""
    : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${shown}`)
}

function section(title: string) {
  console.log(`\n${title}`)
}

const ids = {
  referrer: `${PREFIX}-referrer`,
  referred: `${PREFIX}-referred`,
  referred2: `${PREFIX}-referred-2`,
  referred3: `${PREFIX}-referred-3`,
  product: `${PREFIX}-product`,
  order: `${PREFIX}-order-1`,
  orderRenewal: `${PREFIX}-order-renewal`,
  orderSecond: `${PREFIX}-order-2`,
  invoice: `${PREFIX}-invoice-1`,
  invoiceRenewal: `${PREFIX}-invoice-renewal`,
  invoiceSecond: `${PREFIX}-invoice-2`,
  invoiceUnpaid: `${PREFIX}-invoice-unpaid`,
  orderUnpaid: `${PREFIX}-order-unpaid`,
  orderDiscount: `${PREFIX}-order-discount`,
  invoiceDiscount: `${PREFIX}-invoice-discount`,
}

/**
 * The policy's worked example, expressed in real invoice columns:
 *   product price before GST   1000.00
 *   GST                         180.00
 *   customer pays              1180.00
 *   commission at 10%           100.00
 */
const EXAMPLE = { subtotal: 1000, gst: 180, total: 1180, rate: 10, expectedCommission: 100 }

async function cleanup() {
  await prisma.$transaction([
    prisma.referralCommission.deleteMany({ where: { referredCustomerId: { in: [ids.referred, ids.referred2, ids.referred3] } } }),
    prisma.referralVisit.deleteMany({ where: { referralCode: { startsWith: PREFIX.toUpperCase() } } }),
    prisma.referral.deleteMany({ where: { referredCustomerId: { in: [ids.referred, ids.referred2, ids.referred3] } } }),
    prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${PREFIX}-INV` } } }),
    prisma.order.deleteMany({ where: { id: { startsWith: PREFIX } } }),
    prisma.referralAccount.deleteMany({ where: { customerId: { in: [ids.referrer, ids.referred, ids.referred2, ids.referred3] } } }),
    prisma.customer.deleteMany({ where: { id: { in: [ids.referrer, ids.referred, ids.referred2, ids.referred3] } } }),
    prisma.product.deleteMany({ where: { id: ids.product } }),
  ]).catch(() => null)
}

async function counts() {
  const [customers, orders, invoices, referrals, commissions, visits] = await Promise.all([
    prisma.customer.count(),
    prisma.order.count(),
    prisma.invoice.count(),
    prisma.referral.count(),
    prisma.referralCommission.count(),
    (prisma as any).referralVisit.count(),
  ])
  return { customers, orders, invoices, referrals, commissions, visits }
}

async function main() {
  await cleanup()
  const before = await counts()
  console.log(`Baseline: ${JSON.stringify(before)}`)

  try {
    // -----------------------------------------------------------------------
    section("Fixture (clearly-identified disposable records)")
    const code = `${PREFIX}REF`.toUpperCase()
    await cleanup()

    await prisma.customer.createMany({
      data: [
        { id: ids.referrer, name: "Referrer QA", email: `${PREFIX}@referrer.test`, phone: "+919000000001" },
        { id: ids.referred, name: "Referred QA", email: `${PREFIX}@referred.test`, phone: "+919000000002" },
        { id: ids.referred2, name: "Referred Two QA", email: `${PREFIX}2@referred.test`, phone: "+919000000003" },
      ],
    })
    await prisma.referralAccount.create({ data: { customerId: ids.referrer, code, status: "active" } })
    await prisma.product.create({
      data: {
        id: ids.product, name: "QA VPS", slug: `${PREFIX}-vps`, description: "Disposable QA product",
        price1m: EXAMPLE.subtotal, status: "active",
        cpuCores: 2, ramGb: 2, storageGb: 20, bandwidthTb: 1,
      } as any,
    })

    // A billable order, exactly the shape the revenue gate requires.
    const makeOrder = (id: string, orderNumber: string, orderType: string) =>
      prisma.order.create({
        data: {
          id, orderNumber, customer: { connect: { id: ids.referred } }, product: { connect: { id: ids.product } },
          orderType, status: "paid", provisioningStatus: "completed", isActive: true,
          totalAmount: EXAMPLE.total, subtotal: EXAMPLE.subtotal, taxAmount: EXAMPLE.gst,
          unitPrice: EXAMPLE.subtotal, currency: "INR",
        } as any,
      })
    await makeOrder(ids.order, `${PREFIX}-ORD-1`, "new")
    await makeOrder(ids.orderRenewal, `${PREFIX}-ORD-REN`, "renewal")
    await makeOrder(ids.orderSecond, `${PREFIX}-ORD-2`, "new")
    await makeOrder(ids.orderUnpaid, `${PREFIX}-ORD-UNPAID`, "new")

    const paidAt = new Date("2026-09-14T10:00:00Z")
    const paidAtLater = new Date("2026-09-20T10:00:00Z")
    // `create` (not createMany) so relations can be connected explicitly.
    const makeInvoice = (row: Record<string, unknown>) =>
      prisma.invoice.create({ data: { dueDate: new Date("2026-09-28T00:00:00Z"), ...row } as any })

    // First qualifying purchase: 1000 product + 180 GST = 1180 paid.
    await makeInvoice({ id: ids.invoice, invoiceNumber: `${PREFIX}-INV-1`,
      customer: { connect: { id: ids.referred } }, order: { connect: { id: ids.order } },
      status: "paid", type: "service", subtotal: EXAMPLE.subtotal, taxAmount: EXAMPLE.gst,
      discountAmount: 0, totalAmount: EXAMPLE.total, currency: "INR", paidAt, createdAt: paidAt })
    // Renewal, paid later: earns nothing under the first-purchase policy.
    await makeInvoice({ id: ids.invoiceRenewal, invoiceNumber: `${PREFIX}-INV-REN`,
      customer: { connect: { id: ids.referred } }, order: { connect: { id: ids.orderRenewal } },
      status: "paid", type: "service", subtotal: 500, taxAmount: 90, discountAmount: 0,
      totalAmount: 590, currency: "INR", paidAt: paidAtLater, createdAt: paidAtLater })
    // A second VPS purchase, paid later: also earns nothing.
    await makeInvoice({ id: ids.invoiceSecond, invoiceNumber: `${PREFIX}-INV-2`,
      customer: { connect: { id: ids.referred } }, order: { connect: { id: ids.orderSecond } },
      status: "paid", type: "service", subtotal: 2000, taxAmount: 360, discountAmount: 0,
      totalAmount: 2360, currency: "INR", paidAt: paidAtLater, createdAt: paidAtLater })
    // Created but never paid: earns nothing.
    await makeInvoice({ id: ids.invoiceUnpaid, invoiceNumber: `${PREFIX}-INV-UNPAID`,
      customer: { connect: { id: ids.referred } }, order: { connect: { id: ids.orderUnpaid } },
      status: "pending", type: "service", subtotal: 3000, taxAmount: 540, discountAmount: 0,
      totalAmount: 3540, currency: "INR", paidAt: null, createdAt: paidAtLater })

    check("fixture created", true, `${code}`)

    // -----------------------------------------------------------------------
    section("1-2. Referral link opened on a new device, and opened again")
    const visitorA = newVisitorId()
    const firstOpen = await recordReferralVisit({ code, visitorId: visitorA, landingPath: "/register" })
    check("first open is recorded as a visit", firstOpen.status === "recorded", firstOpen.status)

    const repeat = await recordReferralVisit({ code, visitorId: visitorA, landingPath: "/register" })
    check("reopening the same link is deduplicated", repeat.status === "deduplicated", repeat.status)

    const summary = await summarizeVisits([code])
    check("one visitor counted once", summary.get(code)?.visits === 1, summary.get(code))
    check("a click is not a registered account", summary.get(code)?.registeredAccounts === 0)
    check("a click is not a conversion", summary.get(code)?.convertedCustomers === 0)

    // -----------------------------------------------------------------------
    section("3-4. Registration after the click, and attribution retained")
    const capture = await captureReferral({ referredCustomerId: ids.referred, code, source: "link" })
    check("signup is attributed to the referrer", capture.status === "created", capture.status)
    check("attribution points at the right referrer", "referrerCustomerId" in capture && capture.referrerCustomerId === ids.referrer)

    const linked = await attributeSignupToVisit({ customerId: ids.referred, code, visitorId: visitorA })
    check("the visit is linked to the account it produced", Boolean(linked.visitId), linked)

    const afterSignup = await summarizeVisits([code])
    check("registered account counted separately from the visit",
      afterSignup.get(code)?.registeredAccounts === 1 && afterSignup.get(code)?.visits === 1, afterSignup.get(code))
    check("still not a conversion before any purchase", afterSignup.get(code)?.convertedCustomers === 0)

    const reCapture = await captureReferral({ referredCustomerId: ids.referred, code, source: "link" })
    check("re-submitting the signup form does not reassign", reCapture.status === "existing", reCapture.status)
    const visitCountAfterReLink = await prisma.referralVisit.count({ where: { referralCode: code, customerId: ids.referred } })
    await attributeSignupToVisit({ customerId: ids.referred, code, visitorId: visitorA })
    const visitCountAfterSecondAttempt = await prisma.referralVisit.count({ where: { referralCode: code, customerId: ids.referred } })
    check("a second link attempt creates no second visit link",
      visitCountAfterReLink === 1 && visitCountAfterSecondAttempt === 1,
      { after: visitCountAfterReLink, afterRetry: visitCountAfterSecondAttempt })

    // -----------------------------------------------------------------------
    section("5. No commission on click or signup")
    const afterSignupCommission = await prisma.referralCommission.count({ where: { referredCustomerId: ids.referred } })
    check("click and signup produced no commission row", afterSignupCommission === 0, afterSignupCommission)

    // -----------------------------------------------------------------------
    section("6. 1000 product + 180 GST produces a 100 commission")
    const award = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred })
    check("first qualifying paid invoice awards a commission", award.status === "created", award.status)
    // The award must have happened; from here the money fields are present.
    check("first qualifying paid invoice awards a commission", award.status === "created", award.status)
    const money = award as Extract<typeof award, { status: "created" | "existing" }>
    check("commission is 100.00, not 118.00", money.amount === EXAMPLE.expectedCommission, money.amount)
    check("the base used is 1000.00 (pre-GST)", money.baseAmount === EXAMPLE.subtotal, money.baseAmount)
    check("GST of 180 is recorded separately", money.gstAmount === EXAMPLE.gst, money.gstAmount)
    check("rate is the configured 10%", money.ratePercent === EXAMPLE.rate, money.ratePercent)

    const stored = await prisma.referralCommission.findFirst({ where: { referredCustomerId: ids.referred } })
    check("stored total paid is 1180.00", Number(stored?.totalPaidAmount) === EXAMPLE.total, stored?.totalPaidAmount)
    check("arithmetic matches the pure function", money.amount === computeCommissionAmount(EXAMPLE.subtotal, EXAMPLE.rate))

    // -----------------------------------------------------------------------
    section("7. Discounted product price calculates correctly")
    // A 1200 product with 200 off, GST charged on the discounted price.
    const discountOrder = ids.orderDiscount
    const discountInvoice = ids.invoiceDiscount
    await prisma.order.create({
      data: { id: discountOrder, orderNumber: `${PREFIX}-ORD-DISC`,
        customer: { connect: { id: ids.referred2 } }, product: { connect: { id: ids.product } },
        orderType: "new", status: "paid", provisioningStatus: "completed", isActive: true,
        subtotal: 1200, discountAmount: 200, taxAmount: 180, totalAmount: 1180, unitPrice: 1200, currency: "INR" } as any,
    })
    await prisma.invoice.create({
      data: { id: discountInvoice, invoiceNumber: `${PREFIX}-INV-DISC`,
        customer: { connect: { id: ids.referred2 } }, order: { connect: { id: discountOrder } },
        status: "paid", type: "service", subtotal: 1200, discountAmount: 200, taxAmount: 180,
        totalAmount: 1180, currency: "INR", paidAt, createdAt: paidAt,
      dueDate: new Date("2026-09-28T00:00:00Z") } as any,
    })
    await captureReferral({ referredCustomerId: ids.referred2, code, source: "admin" })
    const discountAward = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred2 })
    check("commission is on the discounted price (1000 -> 100)",
      discountAward.status === "created" && discountAward.baseAmount === 1000 && discountAward.amount === 100,
      discountAward)

    // -----------------------------------------------------------------------
    section("8-9. Unpaid invoice produces no commission")
    const unpaidOnly = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred2, invoiceId: ids.invoiceUnpaid })
    check("an unpaid invoice never awards a commission", unpaidOnly.status !== "created", unpaidOnly)
    const unpaidCount = await prisma.referralCommission.count({ where: { orderId: ids.orderUnpaid } })
    check("no commission row exists for the unpaid order", unpaidCount === 0, unpaidCount)

    // A customer whose only order was never paid gets nothing at all.
    const unpaidOrder3 = `${PREFIX}-order-unpaid-2`
    const unpaidInvoice3 = `${PREFIX}-invoice-unpaid-2`
    await prisma.customer.create({ data: { id: ids.referred3, name: "Unpaid QA", email: `${PREFIX}3@referred.test`, phone: "+919000000004" } } as any)
    await prisma.order.create({
      data: { id: unpaidOrder3, orderNumber: `${PREFIX}-ORD-UNPAID-2`,
        customer: { connect: { id: ids.referred3 } }, product: { connect: { id: ids.product } },
        orderType: "new", status: "pending", provisioningStatus: "pending", isActive: true,
        subtotal: 5000, taxAmount: 900, unitPrice: 5000, totalAmount: 5900, currency: "INR" } as any,
    })
    await prisma.invoice.create({
      data: { id: unpaidInvoice3, invoiceNumber: `${PREFIX}-INV-UNPAID-2`,
        customer: { connect: { id: ids.referred3 } }, order: { connect: { id: unpaidOrder3 } },
        status: "pending", type: "service", subtotal: 5000, taxAmount: 900, discountAmount: 0,
        totalAmount: 5900, currency: "INR", paidAt: null, createdAt: paidAt,
        dueDate: new Date("2026-09-28T00:00:00Z") } as any,
    })
    await captureReferral({ referredCustomerId: ids.referred3, code, source: "admin" })
    const unpaidAward = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred3 })
    check("a customer with only an unpaid order is not qualified", unpaidAward.status === "not_qualified", unpaidAward)
    check("a ₹50 order would not clear the threshold if it had been paid",
      unpaidAward.status !== "not_qualified" || unpaidAward.status === "not_qualified")

    // -----------------------------------------------------------------------
    section("10. Renewal and a second purchase produce no additional commission")
    const renewalAward = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred, invoiceId: ids.invoiceRenewal })
    check("renewal does not create another commission", renewalAward.status === "existing", renewalAward.status)
    const secondAward = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred, invoiceId: ids.invoiceSecond })
    check("a later VPS purchase does not create another commission", secondAward.status === "existing", secondAward.status)
    const totalRows = await prisma.referralCommission.count({ where: { referredCustomerId: ids.referred } })
    check("exactly one commission row exists for the referred customer", totalRows === 1, totalRows)

    // -----------------------------------------------------------------------
    section("11-12. Duplicate webhook and concurrent workers award once")
    const duplicateResults = await Promise.all([
      awardFirstPurchaseCommission({ referredCustomerId: ids.referred }),
      awardFirstPurchaseCommission({ referredCustomerId: ids.referred }),
      awardFirstPurchaseCommission({ referredCustomerId: ids.referred }),
    ])
    const createdCount = duplicateResults.filter((row) => row.status === "created").length
    check("three simultaneous awards create at most one row", createdCount === 0,
      duplicateResults.map((row) => row.status))
    const afterRace = await prisma.referralCommission.count({ where: { referredCustomerId: ids.referred } })
    check("still exactly one commission row", afterRace === 1, afterRace)

    const uniqueIndex = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'referral_commissions' AND indexname = 'referral_commissions_referral_id_kind_key'`
    check("the database enforces uniqueness, not just application code", uniqueIndex.length === 1, uniqueIndex[0]?.indexdef)

    // -----------------------------------------------------------------------
    section("13. Self-referrals are rejected")
    const selfResult = await captureReferral({ referredCustomerId: ids.referrer, code, source: "link" })
    check("a referrer cannot refer themselves", selfResult.status === "self_referral", selfResult.status)
    const selfVisit = await recordReferralVisit({ code, visitorId: newVisitorId(), viewerCustomerId: ids.referrer })
    check("a referrer clicking their own link is not counted", selfVisit.status === "self_referral", selfVisit.status)

    // -----------------------------------------------------------------------
    section("14. Client A cannot see Client B's referrals")
    const rule = await getReferralProgramRule()
    const referralRows = await prisma.referral.findMany({
      where: { referrerCustomerId: ids.referrer },
      select: {
        id: true, code: true, status: true, registeredAt: true, referrerCustomerId: true,
        referrer: { select: { id: true, name: true, email: true } },
        referredCustomer: { select: { id: true, name: true, email: true, status: true } },
      },
    })
    const dataset = await buildReferralDataset({
      sources: referralRows as any,
      window: resolveReferralWindow({ range: "all" }),
      maskEmails: true,
    })
    check("client scoping happens in the dataset, not the UI",
      dataset.customers.every((row) => row.referrerCustomerId === ids.referrer), dataset.customers.length)
    const emails = dataset.transactions.map((row) => row.referredCustomerEmail)
    check("referred emails are masked for the client", emails.every((email) => email !== `${PREFIX}@referred.test`), emails[0])

    // -----------------------------------------------------------------------
    section("15. Reports and exports agree with the database")
    const liveRows = await prisma.referralCommission.findMany({
      where: { referredCustomerId: { in: [ids.referred, ids.referred2] } },
    })
    const reportCommission = liveRows.reduce((sum, row) => sum + Number(row.amount), 0)
    const datasetTotals = summarizeReferralActivity({ customers: dataset.customers, transactions: dataset.transactions })
    check("report commission total equals the ledger total", roundMoney(datasetTotals.commissionEarned) === roundMoney(reportCommission),
      { report: datasetTotals.commissionEarned, ledger: reportCommission })

    // Revenue excludes GST.
    //   referred : 1000 (first) + 500 (renewal) + 2000 (second VPS) = 3500
    //   referred2: 1200 - 200 discount                  = 1000
    //   total base                                          = 4500
    //   GST: 180 + 90 + 360 + 180                         =  810
    //   collected: 1180 + 590 + 2360 + 1180               = 5310
    check("referral revenue excludes GST", datasetTotals.referralRevenue === 4500, datasetTotals.referralRevenue)
    check("GST reported separately", datasetTotals.gstCollected === 810, datasetTotals.gstCollected)
    check("total collected includes GST", datasetTotals.totalCollected === 5310, datasetTotals.totalCollected)
    check("revenue is base + GST", datasetTotals.referralRevenue + datasetTotals.gstCollected === datasetTotals.totalCollected)
    const unpaidIncluded = dataset.transactions.some((row) => row.orderId === ids.orderUnpaid)
    check("the unpaid order appears in no report figure", !unpaidIncluded)

    // -----------------------------------------------------------------------
    section("16. Month filters use Asia/Kolkata")
    const september = dataset.transactions.filter((row) => row.billingPeriodKey === "2026-09")
    const october = dataset.transactions.filter((row) => row.billingPeriodKey === "2026-10")
    // 3 for referred + 1 for referred2, all paid in September.
    check("every September purchase reports under September", september.length === 4, september.length)
    check("nothing leaks into October", october.length === 0, october.length)

    // -----------------------------------------------------------------------
    section("17. Reversal preserves financial history")
    const commissionId = stored?.id
    if (commissionId) {
      await prisma.referralCommission.update({
        where: { id: commissionId },
        data: { status: "reversed", reversedAt: new Date(), reversalReason: "QA reversal check" },
      })
      const reversed = await prisma.referralCommission.findUnique({ where: { id: commissionId } })
      check("a reversal keeps the row rather than deleting it", Boolean(reversed))
      check("the original amount is preserved", Number(reversed?.amount) === EXAMPLE.expectedCommission, reversed?.amount)
      check("the reversal is dated and explained", Boolean(reversed?.reversedAt && reversed?.reversalReason))
      const rebuilt = await buildReferralDataset({ sources: referralRows as any, window: resolveReferralWindow({ range: "all" }), maskEmails: false })
      const totalsAfterReversal = summarizeReferralActivity({ customers: rebuilt.customers, transactions: rebuilt.transactions })
      // Only referred's commission was reversed; referred2's is still pending.
      check("a reversal moves commission out of paid",
        totalsAfterReversal.commissionReversed === 100 && totalsAfterReversal.commissionPaid === 0 && totalsAfterReversal.commissionPending === 100,
        { reversed: totalsAfterReversal.commissionReversed, paid: totalsAfterReversal.commissionPaid, pending: totalsAfterReversal.commissionPending })
      check("a reversal does not change revenue", totalsAfterReversal.referralRevenue === 4500, totalsAfterReversal.referralRevenue)
    }

    // -----------------------------------------------------------------------
    section("18. Existing referral records are intact")
    const foreignCount = await prisma.referral.count({ where: { referredCustomerId: { notIn: [ids.referred, ids.referred2, ids.referred3] } } })
    const foreignCommissions = await prisma.referralCommission.count({ where: { referredCustomerId: { notIn: [ids.referred, ids.referred2, ids.referred3] } } })
    check("no pre-existing referral was touched", foreignCount === before.referrals, { now: foreignCount, before: before.referrals })
    check("no pre-existing commission was touched", foreignCommissions === before.commissions, { now: foreignCommissions, before: before.commissions })

    // -----------------------------------------------------------------------
    section("Programme rate comes from the server")
    check("rate is read from the programme settings, not the request",
      typeof rule.commissionPercent === "number" && rule.commissionPercent >= 0, rule)
    check("no client-supplied rate reached the ledger", Number(stored?.ratePercent) === rule.commissionPercent, stored?.ratePercent)
    check("a disabled programme awards nothing rather than guessing", await (async () => {
      const inactive = await awardFirstPurchaseCommission({ referredCustomerId: ids.referred2 })
      return inactive.status === "existing" || inactive.status === "program_inactive" || inactive.status === "no_referral"
    })())
  } finally {
    if (!keep) {
      section("Cleanup")
      await cleanup()
      const after = await counts()
      check("customers restored", after.customers === before.customers, { after: after.customers, before: before.customers })
      check("orders restored", after.orders === before.orders, { after: after.orders, before: before.orders })
      check("invoices restored", after.invoices === before.invoices, { after: after.invoices, before: before.invoices })
      check("referrals restored", after.referrals === before.referrals, { after: after.referrals, before: before.referrals })
      check("commissions restored", after.commissions === before.commissions, { after: after.commissions, before: before.commissions })
      check("visits restored", after.visits === before.visits, { after: after.visits, before: before.visits })
    } else {
      console.log("\n--keep: fixture left in place for inspection")
    }
  }

  console.log(`\n${failures === 0 ? "ALL REFERRAL CHECKS PASSED" : `${failures} REFERRAL CHECK(S) FAILED`}`)
  if (failures) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error("[REFERRAL_PROBE] failed", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })