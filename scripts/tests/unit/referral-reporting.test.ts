import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  billingPeriodForTransaction,
  buildTransactionRows,
  customerMatchesSearch,
  customerMatchesStatus,
  deriveReferralStatus,
  fillMonthlySeries,
  groupTransactionsByDay,
  groupTransactionsByMonth,
  groupTransactionsByProduct,
  maskEmailForReferrer,
  sortCustomers,
  sortTransactions,
  summarizeReferralActivity,
  transactionInWindow,
  transactionMatchesProduct,
  transactionMatchesSearch,
  type ReferralCustomerRow,
  type ReferralTransactionRow,
} from "@/lib/referrals/reporting"
import {
  appTimezoneDayEndForTest,
  appTimezoneDayStartForTest,
  buildPaginationMeta,
  calendarDateInAppTimezone,
  MAX_REFERRAL_PAGE_SIZE,
  normalizePagination,
  normalizeReferralSearch,
  parseCalendarDay,
  referralDaySeries,
  referralMonthKey,
  referralMonthSeries,
  resolveReferralWindow,
  startOfDayInAppTimezone,
} from "@/lib/referrals/filters"
import {
  commissionKindForOrderType,
  computeCommissionAmount,
  holdUntilFor,
  isQualifyingCommissionInput,
  roundMoney,
  sumCommissionTotals,
} from "@/lib/referrals/commission"
import { normalizeReferralProgramRule } from "@/lib/referrals/program"
import { buildReferralLink } from "@/lib/referrals/attribution"

const RULE = { commissionPercent: 10, holdDays: 30, isActive: true }
const DAY = 86_400_000

const appTimezoneDayStart = appTimezoneDayStartForTest
const appTimezoneDayEnd = appTimezoneDayEndForTest

function invoice(overrides: Record<string, unknown> = {}) {
  const created = new Date("2026-03-14T10:00:00.000Z")
  return {
    invoiceId: "inv_1",
    invoiceNumber: "INV-1",
    orderId: "ord_1",
    orderNumber: "ZWS-1",
    orderType: null,
    orderStatus: "active",
    orderProvisioningStatus: "ready",
    orderDeletedAt: null,
    orderIsActive: true,
    customerId: "cust_ref",
    productId: "prod_1",
    serviceId: "vps_1",
    productName: "Cloud VPS 2GB",
    productSlug: "cloud-vps-2gb",
    amount: 1000,
    taxAmount: 180,
    eligibleBaseAmount: 820,
    currency: "INR",
    paidAt: created,
    createdAt: created,
    serviceActivatedAt: created,
    serviceRenewalDueAt: null,
    serviceNextRenewalAt: new Date("2026-04-14T10:00:00.000Z"),
    serviceBillingTermMonths: 1,
    serviceStatus: "active",
    serviceName: "vps-alpha",
    ...overrides,
  } as any
}

function customersAndReferrals() {
  return {
    customers: new Map([["cust_ref", { id: "cust_ref", name: "Referred One", email: "referred.one@example.com" }]]),
    referrals: new Map([["cust_ref", {
      id: "ref_1",
      code: "ABCD2345",
      referrerCustomerId: "cust_owner",
      referrerName: "Referrer",
      referrerEmail: "referrer@example.com",
    }]]),
  }
}

function transaction(overrides: Partial<ReferralTransactionRow> = {}): ReferralTransactionRow {
  return {
    referralId: "ref_1",
    referralCode: "ABCD2345",
    referrerCustomerId: "cust_owner",
    referrerName: "Referrer",
    referrerEmail: "referrer@example.com",
    referredCustomerId: "cust_ref",
    referredCustomerName: "Referred One",
    referredCustomerEmail: "re***@example.com",
    serviceId: "vps_1",
    serviceName: "vps-alpha",
    productId: "prod_1",
    productName: "Cloud VPS 2GB",
    orderId: "ord_1",
    orderNumber: "ZWS-1",
    orderType: null,
    invoiceId: "inv_1",
    invoiceNumber: "INV-1",
    purchaseDate: "2026-03-14T10:00:00.000Z",
    serviceStartDate: "2026-03-14T10:00:00.000Z",
    serviceActivatedAt: "2026-03-14T10:00:00.000Z",
    billingPeriod: "Mar 2026",
    billingPeriodKey: "2026-03",
    billingPeriodStart: "2026-03-01T00:00:00.000Z",
    billingPeriodEnd: "2026-03-31T23:59:59.999Z",
    renewalDate: "2026-04-14T10:00:00.000Z",
    expiryDate: "2026-04-14T10:00:00.000Z",
    amount: 1000,
    taxAmount: 180,
    eligibleBaseAmount: 820,
    currency: "INR",
    paymentStatus: "paid",
    orderStatus: "active",
    serviceStatus: "active",
    commission: {
      id: null,
      amount: 82,
      ratePercent: 10,
      status: "pending",
      kind: "initial",
      materialised: false,
      holdUntil: "2026-04-13T10:00:00.000Z",
      paidAt: null,
      reversedAt: null,
      reversalReason: null,
      notes: null,
    },
    ...overrides,
  }
}

function customer(overrides: Partial<ReferralCustomerRow> = {}): ReferralCustomerRow {
  return {
    referralId: "ref_1",
    referralCode: "ABCD2345",
    referrerCustomerId: "cust_owner",
    referrerName: "Referrer",
    referrerEmail: "referrer@example.com",
    referredCustomerId: "cust_ref",
    name: "Referred One",
    email: "re***@example.com",
    registeredAt: "2026-03-01T00:00:00.000Z",
    status: "active",
    converted: true,
    firstPurchaseAt: "2026-03-14T10:00:00.000Z",
    latestPurchaseAt: "2026-03-14T10:00:00.000Z",
    orderCount: 1,
    totalSpent: 820,
    commissionEarned: 82,
    commissionPending: 82,
    commissionPaid: 0,
    commissionReversed: 0,
    services: { totalServices: 1, activeServices: 1, serviceNames: ["vps-alpha"], productNames: ["Cloud VPS 2GB"], lastServiceStatus: "active" },
    latestServiceStatus: "active",
    latestBillingPeriod: "Mar 2026",
    ...overrides,
  }
}

describe("commission arithmetic", () => {
  it("rounds to two decimals and refuses non-positive or non-finite input", () => {
    assert.equal(computeCommissionAmount(1000, 10), 100)
    assert.equal(computeCommissionAmount(999.99, 12.5), 125)
    assert.equal(computeCommissionAmount(0, 10), 0)
    assert.equal(computeCommissionAmount(-100, 10), 0)
    assert.equal(computeCommissionAmount("nonsense", 10), 0)
    assert.equal(roundMoney(1.005), 1.01)
  })

  it("keeps earned, pending, paid and reversed distinct", () => {
    const totals = sumCommissionTotals([
      { amount: 82, status: "pending" },
      { amount: 50, status: "paid" },
      { amount: 25, status: "reversed" },
      { amount: 10, status: "cancelled" },
    ])
    assert.equal(totals.pending, 82)
    assert.equal(totals.paid, 50)
    assert.equal(totals.earned, 132, "reversed commission is not part of earned")
    assert.equal(totals.reversed, 35)
    assert.equal(totals.count, 4)
  })

  it("accepts only paid service invoices on live billable orders", () => {
    const ok = {
      orderStatus: "paid",
      orderProvisioningStatus: "ready",
      orderIsActive: true,
      invoiceStatus: "paid",
      invoiceType: "service",
      amount: 500,
    }
    assert.equal(isQualifyingCommissionInput(ok), true)

    for (const broken of [
      { ...ok, orderStatus: "cancelled" },
      { ...ok, orderStatus: "DELETED" },
      { ...ok, orderStatus: "pending" },
      { ...ok, orderProvisioningStatus: "deleted" },
      { ...ok, orderDeletedAt: new Date() },
      { ...ok, orderIsActive: false },
      { ...ok, invoiceStatus: "pending" },
      { ...ok, invoiceStatus: "cancelled" },
      { ...ok, invoiceStatus: "refunded" },
      { ...ok, invoiceType: "wallet_topup" },
      { ...ok, invoiceDeletedAt: new Date() },
      { ...ok, amount: 0 },
      { ...ok, programActive: false },
      { ...ok, minimumOrderAmount: 1000 },
    ]) {
      assert.equal(isQualifyingCommissionInput(broken as any), false, JSON.stringify(broken))
    }
  })

  it("classifies renewals separately and anchors their billing period to the renewal", () => {
    assert.equal(commissionKindForOrderType("renewal"), "renewal")
    assert.equal(commissionKindForOrderType(null), "initial")
    assert.equal(commissionKindForOrderType("VPS_UPGRADE"), "initial")

    const period = billingPeriodForTransaction({
      purchaseDate: new Date("2026-05-02T00:00:00.000Z"),
      serviceRenewalDueAt: new Date("2026-05-02T00:00:00.000Z"),
      serviceTermMonths: 1,
      isRenewal: true,
    })
    assert.equal(referralMonthKey(period.start), "2026-05")
    assert.equal(period.label, "May 2026")
    assert.equal(period.end?.toISOString(), new Date("2026-06-02T00:00:00.000Z").toISOString())
  })

  it("honours the hold window", () => {
    const earnedAt = new Date("2026-03-14T10:00:00.000Z")
    assert.equal(holdUntilFor(earnedAt, 0), null)
    assert.equal(holdUntilFor(earnedAt, 30)?.toISOString(), "2026-04-13T10:00:00.000Z")
  })
})

describe("referral rows derived from authoritative invoices", () => {
  it("builds one row per qualifying invoice and masks the referred customer email", () => {
    const rows = buildTransactionRows({
      invoices: [invoice()],
      ledger: new Map(),
      ...customersAndReferrals(),
      rule: RULE,
      maskEmails: true,
    })
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.referredCustomerEmail, "re***@example.com", "a referrer never sees the full contact record")
    assert.equal(row.amount, 1000, "the amount paid is still reported")
    assert.equal(row.taxAmount, 180)
    assert.equal(row.eligibleBaseAmount, 820, "revenue and commission use the pre-GST base")
    assert.equal(row.paymentStatus, "paid")
    assert.equal(row.commission.amount, 82, "10% of 820, not 10% of the 1000 paid")
    assert.equal(row.commission.materialised, false)
    assert.equal(row.commission.status, "pending")
    assert.ok(row.purchaseDate)
    assert.ok(row.billingPeriodKey)
    assert.ok(row.renewalDate)
  })

  it("counts renewals as separate transactions instead of folding them into the first purchase", () => {
    const rows = buildTransactionRows({
      invoices: [
        invoice(),
        invoice({
          invoiceId: "inv_2",
          invoiceNumber: "INV-2",
          orderId: "ord_2",
          orderNumber: "RENEW-2",
          orderType: "renewal",
          paidAt: new Date("2026-04-14T10:00:00.000Z"),
          createdAt: new Date("2026-04-14T10:00:00.000Z"),
          amount: 1200,
        }),
      ],
      ledger: new Map(),
      ...customersAndReferrals(),
      rule: RULE,
      maskEmails: true,
    })
    assert.equal(rows.length, 2, "each qualifying transaction is its own row")
    assert.deepEqual(rows.map((row) => row.orderId).sort(), ["ord_1", "ord_2"])
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 2200)
    assert.equal(rows.find((row) => row.orderType === "renewal")?.commission.kind, "renewal")
  })

  it("prefers the materialised ledger row over the live calculation", () => {
    const rows = buildTransactionRows({
      invoices: [invoice()],
      ledger: new Map([["ord_1", {
        id: "com_1",
        orderId: "ord_1",
        amount: 55,
        ratePercent: 7.5,
        status: "paid",
        kind: "initial",
        holdUntil: null,
        paidAt: new Date("2026-05-01T00:00:00.000Z"),
        reversedAt: null,
        reversalReason: null,
        notes: null,
        referralId: "ref_1",
        referrerCustomerId: "cust_owner",
        referredCustomerId: "cust_ref",
        productId: "prod_1",
        serviceId: "vps_1",
        earnedAt: new Date("2026-03-14T10:00:00.000Z"),
        createdAt: new Date("2026-03-14T10:00:00.000Z"),
      }]]),
      ...customersAndReferrals(),
      rule: RULE,
      maskEmails: true,
    })
    assert.equal(rows[0].commission.materialised, true)
    assert.equal(rows[0].commission.id, "com_1")
    assert.equal(rows[0].commission.amount, 55)
    assert.equal(rows[0].commission.status, "paid")
  })

  it("drops transactions whose customer is not part of the loaded referral set", () => {
    const rows = buildTransactionRows({
      invoices: [invoice(), invoice({ customerId: "someone_else", orderId: "ord_x", invoiceId: "inv_x" })],
      ledger: new Map(),
      ...customersAndReferrals(),
      rule: RULE,
      maskEmails: true,
    })
    assert.equal(rows.length, 1)
  })

  it("masks emails without leaking the local part", () => {
    assert.equal(maskEmailForReferrer("verylongaddress@example.com"), "ve***@example.com")
    assert.equal(maskEmailForReferrer(""), "")
    assert.equal(maskEmailForReferrer("nodomain"), "no***")
  })
})

describe("referral status derivation", () => {
  it("reports registered, active, inactive and blocked from live service state", () => {
    assert.equal(deriveReferralStatus({ hasPurchase: false, hasLiveService: false }), "registered")
    assert.equal(deriveReferralStatus({ hasPurchase: true, hasLiveService: false }), "inactive")
    assert.equal(deriveReferralStatus({ hasPurchase: true, hasLiveService: true }), "active")
    assert.equal(deriveReferralStatus({ hasPurchase: false, hasLiveService: false, storedStatus: "blocked" }), "blocked")
  })

  it("filters customers by status and search", () => {
    const rows = [customer(), customer({ referralId: "ref_2", referredCustomerId: "c2", status: "registered", name: "New Signup", email: "ne***@example.com", converted: false })]
    assert.equal(rows.filter((row) => customerMatchesStatus(row, "active")).length, 1)
    assert.equal(rows.filter((row) => customerMatchesStatus(row, "registered")).length, 1)
    assert.equal(rows.filter((row) => customerMatchesStatus(row, "all")).length, 2)
    assert.equal(rows.filter((row) => customerMatchesSearch(row, "new signup")).length, 1)
    assert.equal(rows.filter((row) => customerMatchesSearch(row, "ABCD2345")).length, 2)
    assert.equal(rows.filter((row) => customerMatchesSearch(row, "")).length, 2)
  })
})

describe("date windows and month/day keys", () => {
  const now = new Date("2026-03-15T12:00:00.000Z")

  it("resolves named ranges against the billing timezone, not the host clock", () => {
    const today = startOfDayInAppTimezone(now)

    assert.equal(resolveReferralWindow({ range: "all", now }).range, "all")

    const todayWindow = resolveReferralWindow({ range: "today", now })
    assert.equal(todayWindow.start?.getTime(), today.getTime())
    assert.equal(todayWindow.end?.getTime(), now.getTime())

    const yesterday = resolveReferralWindow({ range: "yesterday", now })
    assert.equal(yesterday.start?.getTime(), today.getTime() - DAY)
    assert.equal(yesterday.end?.getTime(), today.getTime())

    const week = resolveReferralWindow({ range: "this_week", now })
    assert.equal(week.start?.getTime(), today.getTime() - calendarDateInAppTimezone(today).weekday * DAY)

    const last30 = resolveReferralWindow({ range: "last_30_days", now })
    assert.equal(last30.start?.getTime(), today.getTime() - 29 * DAY)

    // Month ranges come from calendar arithmetic in the billing timezone, so
    // "last month" always ends on the last day of that month.
    const thisMonth = resolveReferralWindow({ range: "this_month", now })
    assert.equal(thisMonth.start?.getTime(), appTimezoneDayStart(2026, 3, 1).getTime())
    const lastMonth = resolveReferralWindow({ range: "last_month", now })
    assert.equal(lastMonth.start?.getTime(), appTimezoneDayStart(2026, 2, 1).getTime())
    assert.equal(lastMonth.end?.getTime(), appTimezoneDayEnd(2026, 2, 28).getTime())
    assert.equal(referralMonthKey(lastMonth.end), "2026-02", "February 2026 has 28 days and must not spill into March")
  })

  it("ends a custom range at the last instant of the chosen billing day", () => {
    const custom = resolveReferralWindow({ range: "custom", start: "2026-01-01", end: "2026-01-31", now })
    assert.equal(custom.range, "custom")
    assert.equal(custom.start?.getTime(), appTimezoneDayStart(2026, 1, 1).getTime())
    assert.equal(custom.end?.getTime(), appTimezoneDayEnd(2026, 1, 31).getTime())
    assert.equal(referralMonthKey(custom.end), "2026-01")
    assert.equal(referralMonthKey(new Date((custom.end?.getTime() || 0) + 60_000)), "2026-02")

    const inverted = resolveReferralWindow({ start: "2026-03-31", end: "2026-03-01", now })
    assert.ok((inverted.start as Date).getTime() < (inverted.end as Date).getTime())
  })

  it("rejects impossible calendar days instead of rolling them over", () => {
    assert.equal(parseCalendarDay("2026-02-31"), null)
    assert.equal(parseCalendarDay("2026-13-01"), null)
    assert.equal(parseCalendarDay("2026-02-28")?.day, 28)
    assert.equal(resolveReferralWindow({ start: "not-a-date", now }).range, "all")
  })

  it("keys months and fills the gaps in a series", () => {
    assert.equal(referralMonthKey("2026-03-14T23:00:00.000Z"), "2026-03")
    assert.deepEqual(referralMonthSeries("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"])
    assert.equal(referralDaySeries(appTimezoneDayStart(2026, 3, 1), appTimezoneDayStart(2026, 3, 4)).length, 4)
  })
})

describe("search and pagination limits", () => {
  it("strips wildcard characters so a search cannot match everything", () => {
    assert.equal(normalizeReferralSearch("  abc  "), "abc")
    assert.equal(normalizeReferralSearch("%"), "")
    assert.equal(normalizeReferralSearch("a_b"), "ab")
    assert.ok(normalizeReferralSearch("x".repeat(500)).length <= 120)
  })

  it("searches referred orders by order id, invoice, customer and product", () => {
    const rows = [
      transaction(),
      transaction({
        orderId: "ord_2",
        orderNumber: "RENEW-9",
        invoiceId: "inv_2",
        invoiceNumber: "INV-2",
        productName: "Dedicated NVMe",
        referredCustomerName: "Someone Else",
      }),
    ]
    assert.equal(rows.filter((row) => transactionMatchesSearch(row, "ZWS-1")).length, 1)
    assert.equal(rows.filter((row) => transactionMatchesSearch(row, "INV-1")).length, 1)
    assert.equal(rows.filter((row) => transactionMatchesSearch(row, "dedicated nvme")).length, 1)
    assert.equal(rows.filter((row) => transactionMatchesSearch(row, "")).length, 2)
    assert.equal(rows.filter((row) => transactionMatchesProduct(row, "prod_1")).length, 2)
    assert.equal(rows.filter((row) => transactionMatchesProduct(row, "prod_2")).length, 0)
  })

  it("caps page size and never returns a negative offset", () => {
    assert.deepEqual(normalizePagination({ page: 1, pageSize: 20 }), { page: 1, pageSize: 20, skip: 0, take: 20 })
    assert.equal(normalizePagination({ page: 0, pageSize: 5000 }).pageSize, MAX_REFERRAL_PAGE_SIZE)
    assert.equal(normalizePagination({ page: -3 }).page, 1)
    assert.equal(normalizePagination({ pageSize: 10 }).pageSize, 10)
    assert.deepEqual(buildPaginationMeta({ page: 1, pageSize: 20, total: 0 }), { page: 1, pageSize: 20, total: 0, pages: 1 })
    assert.deepEqual(buildPaginationMeta({ page: 2, pageSize: 20, total: 45 }), { page: 2, pageSize: 20, total: 45, pages: 3 })
  })
})

describe("window filtering and sorting", () => {
  it("filters transactions by the resolved window", () => {
    const window = resolveReferralWindow({ start: "2026-03-01", end: "2026-03-31" })
    assert.equal(transactionInWindow(transaction(), window), true)
    assert.equal(transactionInWindow(transaction({ purchaseDate: "2026-04-01T00:00:00.000Z" }), window), false)
    assert.equal(transactionInWindow(transaction({ purchaseDate: "2026-02-01T00:00:00.000Z" }), window), false)
  })

  it("sorts by the requested key and direction with a stable tiebreak", () => {
    const rows = [
      transaction({ orderId: "a", amount: 50, commission: { ...transaction().commission, amount: 5 } }),
      transaction({ orderId: "b", amount: 150, commission: { ...transaction().commission, amount: 15 } }),
    ]
    assert.deepEqual(sortTransactions(rows, "amount", "desc").map((row) => row.orderId), ["b", "a"])
    assert.deepEqual(sortTransactions(rows, "amount", "asc").map((row) => row.orderId), ["a", "b"])
    assert.deepEqual(sortTransactions(rows, "commission", "desc").map((row) => row.orderId), ["b", "a"])
    assert.deepEqual(sortTransactions(rows, "earnedAt", "asc").map((row) => row.orderId), ["a", "b"])

    const customers = [customer({ referralId: "r1", totalSpent: 10 }), customer({ referralId: "r2", totalSpent: 99 })]
    assert.deepEqual(sortCustomers(customers, "totalSpent", "desc").map((row) => row.referralId), ["r2", "r1"])
  })
})

describe("grouped referral reporting", () => {
  const rows = [
    // `amount` is what the customer paid (GST included); `eligibleBaseAmount`
    // is the pre-GST product amount that revenue and commission use.
    transaction({ orderId: "o1", purchaseDate: "2026-01-10T10:00:00.000Z", amount: 118, eligibleBaseAmount: 100, taxAmount: 18, billingPeriodKey: "2026-01", commission: { ...transaction().commission, amount: 10 } }),
    transaction({ orderId: "o2", purchaseDate: "2026-01-20T10:00:00.000Z", amount: 236, eligibleBaseAmount: 200, taxAmount: 36, billingPeriodKey: "2026-01", orderType: "renewal", commission: { ...transaction().commission, amount: 20, kind: "renewal" } }),
    transaction({ orderId: "o3", purchaseDate: "2026-03-02T10:00:00.000Z", amount: 354, eligibleBaseAmount: 300, taxAmount: 54, billingPeriodKey: "2026-03", commission: { ...transaction().commission, amount: 30, status: "paid", materialised: true } }),
    transaction({ orderId: "o4", purchaseDate: "2026-03-03T10:00:00.000Z", amount: 472, eligibleBaseAmount: 400, taxAmount: 72, billingPeriodKey: "2026-03", productId: "prod_2", productName: "Dedicated NVMe", commission: { ...transaction().commission, amount: 40, status: "reversed", materialised: true } }),
  ]

  it("groups by month across different months and years", () => {
    const monthly = groupTransactionsByMonth(rows)
    assert.deepEqual(monthly.map((row) => row.month), ["2026-01", "2026-03"])
    assert.equal(monthly[0].orders, 2)
    assert.equal(monthly[0].revenue, 300)
    assert.equal(monthly[0].commissionEarned, 30)
    assert.equal(monthly[0].commissionPending, 30)
    assert.equal(monthly[1].commissionPaid, 30)
    assert.equal(monthly[1].commissionReversed, 40)
    assert.equal(monthly[1].label, "Mar 2026")
  })

  it("fills months with no activity instead of skipping them", () => {
    const monthly = groupTransactionsByMonth(rows)
    const window = resolveReferralWindow({ start: "2025-12-01", end: "2026-03-31" })
    const filled = fillMonthlySeries(monthly, window)
    assert.deepEqual(filled.map((row) => row.month), ["2025-12", "2026-01", "2026-02", "2026-03"])
    assert.equal(filled.find((row) => row.month === "2026-02")?.orders, 0)
    assert.equal(filled.find((row) => row.month === "2026-02")?.revenue, 0)
  })

  it("groups by day and by product", () => {
    const daily = groupTransactionsByDay(rows, resolveReferralWindow({ range: "all" }))
    assert.equal(daily.length, 4)
    assert.equal(daily.find((row) => row.day === "2026-01-10")?.revenue, 100)

    const services = groupTransactionsByProduct(rows)
    assert.equal(services[0].productName, "Cloud VPS 2GB")
    assert.equal(services[0].orders, 3)
    assert.equal(services[0].revenue, 600)
    assert.equal(services[1].productName, "Dedicated NVMe")
    assert.equal(services[1].orders, 1)
  })

  it("summarises activity with a conversion rate", () => {
    const totals = summarizeReferralActivity({
      customers: [
        customer(),
        customer({
          referralId: "ref_2",
          referredCustomerId: "c2",
          status: "registered",
          converted: false,
          services: { totalServices: 0, activeServices: 0, serviceNames: [], productNames: [], lastServiceStatus: null },
        }),
      ],
      transactions: rows,
    })
    assert.equal(totals.totalReferrals, 2)
    assert.equal(totals.activeReferrals, 1)
    assert.equal(totals.registeredReferrals, 1)
    assert.equal(totals.conversionRate, 50)
    assert.equal(totals.referredOrders, 4)
    assert.equal(totals.referralRevenue, 1000, "100 + 200 + 300 + 400 pre-GST, not the amounts paid")
    assert.equal(totals.gstCollected, 180)
    assert.equal(totals.totalCollected, 1180)
    assert.equal(totals.commissionEarned, 60, "pending plus paid; reversed is excluded")
    assert.equal(totals.commissionReversed, 40)
  })

  it("returns zeros for an empty dataset instead of NaN", () => {
    const totals = summarizeReferralActivity({ customers: [], transactions: [] })
    assert.equal(totals.conversionRate, 0)
    assert.equal(totals.referralRevenue, 0)
    assert.equal(totals.referredOrders, 0)
    assert.deepEqual(groupTransactionsByMonth([]), [])
    assert.deepEqual(groupTransactionsByProduct([]), [])
    assert.deepEqual(groupTransactionsByDay([], resolveReferralWindow({ range: "all" })), [])
  })
})

describe("programme rule and referral links", () => {
  it("clamps the configured percentage and hold days", () => {
    const rule = normalizeReferralProgramRule({ commissionPercent: 250, holdDays: -5, minimumOrderAmount: -10 })
    assert.equal(rule.commissionPercent, 100)
    assert.equal(rule.holdDays, 0)
    assert.equal(rule.minimumOrderAmount, 0)
    assert.equal(normalizeReferralProgramRule({ commissionPercent: Number.NaN }).commissionPercent, 10)
  })

  it("builds a shareable registration link", () => {
    assert.equal(buildReferralLink("https://example.com/", "abcd2345"), "https://example.com/register?ref=ABCD2345")
    assert.equal(buildReferralLink("", "ABCD2345"), "")
    assert.equal(buildReferralLink("https://example.com", ""), "")
  })
})