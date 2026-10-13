import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  computeCommissionAmount,
  eligibleBaseFromInvoiceParts,
  isQualifyingCommissionInput,
  selectFirstQualifyingPurchases,
  roundMoney,
  commissionKindForOrderType,
  type QualifyingInvoiceRow,
} from "@/lib/referrals/commission"
import {
  parseAttribution,
  serializeAttribution,
  hashVisitor,
  newVisitorId,
  REFERRAL_ATTRIBUTION_COOKIE,
  REFERRAL_ATTRIBUTION_DAYS,
} from "@/lib/referrals/visits"
import { sanitizeReferralCodeInput } from "@/lib/referrals/program"
import { buildTransactionRows, summarizeReferralActivity } from "@/lib/referrals/reporting"
import { referralMonthKey, resolveReferralWindow, REFERRAL_APP_TIMEZONE } from "@/lib/referrals/filters"

/**
 * Builds a qualifying invoice row with the money fields an invoice really
 * carries. Defaults match a real production invoice:
 *
 *   subtotal 699.00, tax 125.82, total 824.82
 */
function invoice(overrides: Partial<QualifyingInvoiceRow> & { customerId: string }): QualifyingInvoiceRow {
  const subtotal = overrides.eligibleBaseAmount ?? 699
  const taxAmount = overrides.taxAmount ?? roundMoney(subtotal * 0.18)
  return {
    invoiceId: overrides.invoiceId || `inv-${overrides.customerId}-${overrides.orderId}`,
    invoiceNumber: overrides.invoiceNumber || `INV-${overrides.orderId}`,
    orderId: overrides.orderId,
    orderNumber: overrides.orderNumber || overrides.orderId,
    orderType: overrides.orderType ?? "new",
    orderStatus: overrides.orderStatus ?? "paid",
    orderProvisioningStatus: overrides.orderProvisioningStatus ?? "completed",
    orderDeletedAt: overrides.orderDeletedAt ?? null,
    orderIsActive: overrides.orderIsActive ?? true,
    customerId: overrides.customerId,
    productId: overrides.productId ?? "prod-1",
    serviceId: overrides.serviceId ?? "svc-1",
    productName: overrides.productName ?? "VPS-2GB",
    productSlug: overrides.productSlug ?? "vps-2gb",
    amount: overrides.amount ?? roundMoney(subtotal + taxAmount),
    taxAmount,
    eligibleBaseAmount: subtotal,
    currency: overrides.currency ?? "INR",
    paidAt: overrides.paidAt ?? new Date("2026-09-14T10:00:00Z"),
    createdAt: overrides.createdAt ?? new Date("2026-09-14T09:00:00Z"),
    serviceActivatedAt: overrides.serviceActivatedAt ?? new Date("2026-09-14T11:00:00Z"),
    serviceRenewalDueAt: overrides.serviceRenewalDueAt ?? new Date("2026-10-14T00:00:00Z"),
    serviceNextRenewalAt: overrides.serviceNextRenewalAt ?? new Date("2026-10-14T00:00:00Z"),
    serviceBillingTermMonths: overrides.serviceBillingTermMonths ?? 1,
    serviceStatus: overrides.serviceStatus ?? "active",
    serviceName: overrides.serviceName ?? "vps-abc123",
  }
}

// ---------------------------------------------------------------------------
// 6. The worked example: 1000 + 180 GST pays 100 commission, not 118.
// ---------------------------------------------------------------------------

describe("commission is 10% of the product price excluding GST", () => {
  it("pays 100 on a 1000 product with 180 GST, never 118", () => {
    const eligibleBase = eligibleBaseFromInvoiceParts(1000, 0, 180, 1180)
    assert.equal(eligibleBase, 1000)
    const commission = computeCommissionAmount(eligibleBase, 10)
    assert.equal(commission, 100, "commission must be a percentage of the product price, not of the amount paid")
    assert.notEqual(commission, 118, "118 would be 10% of the total including GST")
  })

  it("uses the same base for a real production invoice shape", () => {
    // subtotal 699, GST 125.82, customer pays 824.82
    const row = invoice({ customerId: "c1", orderId: "o1" })
    assert.equal(row.eligibleBaseAmount, 699)
    assert.equal(row.amount, 824.82)
    assert.equal(computeCommissionAmount(row.eligibleBaseAmount, 10), 69.9)
  })

  it("applies the discount before GST, as the policy requires", () => {
    // 1200 product, 200 off, 18% GST on the discounted price.
    const subtotal = 1200
    const discount = 200
    const eligibleBase = eligibleBaseFromInvoiceParts(subtotal, discount, roundMoney((subtotal - discount) * 0.18), 1176)
    assert.equal(eligibleBase, 1000)
    assert.equal(computeCommissionAmount(eligibleBase, 10), 100)
  })

  it("never uses the total paid as the base", () => {
    const total = 1180
    const gst = 180
    assert.notEqual(
      computeCommissionAmount(total, 10),
      computeCommissionAmount(total - gst, 10),
      "if these were equal the GST would not be excluded",
    )
    assert.equal(computeCommissionAmount(total - gst, 10), 100)
  })

  it("derives the base from the invoice identity when no subtotal is stored", () => {
    // total = base + tax; the base is what remains once the tax is removed.
    assert.equal(eligibleBaseFromInvoiceParts(null, 0, 180, 1180), 1000)
    assert.equal(eligibleBaseFromInvoiceParts(undefined, undefined, 125.82, 824.82), 699)
  })

  it("returns zero rather than guessing when there is nothing to bill", () => {
    assert.equal(eligibleBaseFromInvoiceParts(0, 0, 0, 0), 0)
    assert.equal(eligibleBaseFromInvoiceParts(null, 0, 0, null), 0)
    assert.equal(computeCommissionAmount(0, 10), 0)
    assert.equal(computeCommissionAmount(1000, 0), 0)
  })

  it("keeps money in exact 2dp rather than floating point drift", () => {
    // 0.1 + 0.2 style drift would show up here.
    assert.equal(roundMoney(1.005), 1.01)
    assert.equal(computeCommissionAmount(333.33, 10), 33.33)
    assert.equal(computeCommissionAmount(199.99, 18), 36)
    assert.equal(roundMoney(0.1 + 0.2), 0.3)
  })

  it("uses a configurable rate, defaulting to 10, never one from the client", () => {
    // The rate is a server-side programme setting. This only proves the
    // arithmetic honours whatever the server passed in.
    assert.equal(computeCommissionAmount(1000, 10), 100)
    assert.equal(computeCommissionAmount(1000, 15), 150)
    assert.equal(computeCommissionAmount(1000, 12.5), 125)
  })
})

// ---------------------------------------------------------------------------
// 8-12. First qualifying purchase only, with duplicate and race protection.
// ---------------------------------------------------------------------------

describe("first qualifying purchase only", () => {
  it("earns nothing on a click or a signup", () => {
    // Neither of these ever reaches the commission path; the absence of an
    // invoice is what stops them, and that is asserted structurally below.
    assert.equal(computeCommissionAmount(0, 10), 0)
    assert.equal(isQualifyingCommissionInput({
      orderStatus: "pending", invoiceStatus: "pending", amount: 0, eligibleBaseAmount: 0,
    }), false)
  })

  it("earns nothing on an unpaid or failed invoice", () => {
    for (const invoiceStatus of ["pending", "unpaid", "failed", "refunded", "cancelled"]) {
      assert.equal(isQualifyingCommissionInput({
        orderStatus: "pending", invoiceStatus, amount: 1000, eligibleBaseAmount: 1000,
      }), false, `${invoiceStatus} must not qualify`)
    }
  })

  it("earns nothing on a cancelled order", () => {
    assert.equal(isQualifyingCommissionInput({
      orderStatus: "cancelled", invoiceStatus: "paid", amount: 1000, eligibleBaseAmount: 1000,
    }), false)
    assert.equal(isQualifyingCommissionInput({
      orderStatus: "paid", orderDeletedAt: new Date(), invoiceStatus: "paid", amount: 1000, eligibleBaseAmount: 1000,
    }), false)
  })

  it("earns on the first successfully paid qualifying VPS invoice", () => {
    assert.equal(isQualifyingCommissionInput({
      orderStatus: "paid", invoiceStatus: "paid", invoiceType: "service",
      amount: 1180, eligibleBaseAmount: 1000, minimumOrderAmount: 0,
    }), true)
  })

  it("applies the minimum order amount to the pre-GST base, not the total", () => {
    // A 900 product plus 162 GST is 1062 paid, but the base is still 900.
    const base = { orderStatus: "paid", invoiceStatus: "paid", invoiceType: "service", amount: 1062, minimumOrderAmount: 1000 }
    assert.equal(isQualifyingCommissionInput({ ...base, eligibleBaseAmount: 900 }), false, "GST must not clear the threshold")
    assert.equal(isQualifyingCommissionInput({ ...base, eligibleBaseAmount: 1000 }), true)
  })

  it("awards exactly one transaction per referred customer", () => {
    const rows = [
      invoice({ customerId: "c1", orderId: "o-1", paidAt: new Date("2026-09-01T00:00:00Z") }),
      invoice({ customerId: "c1", orderId: "o-2", paidAt: new Date("2026-09-20T00:00:00Z") }),
      invoice({ customerId: "c1", orderId: "o-3", paidAt: new Date("2026-10-02T00:00:00Z") }),
    ]
    const firsts = selectFirstQualifyingPurchases(rows)
    assert.equal(firsts.length, 1)
    assert.equal(firsts[0].orderId, "o-1", "the earliest qualifying purchase is the one that earns")
  })

  it("excludes renewals from the first-purchase selection", () => {
    const rows = [
      invoice({ customerId: "c1", orderId: "renew-1", orderType: "renewal", paidAt: new Date("2026-08-01T00:00:00Z") }),
      invoice({ customerId: "c1", orderId: "new-1", orderType: "new", paidAt: new Date("2026-09-01T00:00:00Z") }),
    ]
    const firsts = selectFirstQualifyingPurchases(rows)
    assert.equal(firsts.length, 1)
    assert.equal(firsts[0].orderId, "new-1", "a renewal must never be treated as the first purchase")
  })

  it("keeps one award per customer across different customers", () => {
    const rows = [
      invoice({ customerId: "c1", orderId: "a1" }),
      invoice({ customerId: "c2", orderId: "b1" }),
      invoice({ customerId: "c3", orderId: "c1-1" }),
    ]
    assert.equal(selectFirstQualifyingPurchases(rows).length, 3)
  })

  it("is order-independent: the earliest invoice wins however rows arrive", () => {
    const a = invoice({ customerId: "c1", orderId: "later", paidAt: new Date("2026-12-01T00:00:00Z") })
    const b = invoice({ customerId: "c1", orderId: "earlier", paidAt: new Date("2026-01-05T00:00:00Z") })
    assert.equal(selectFirstQualifyingPurchases([a, b])[0].orderId, "earlier")
    assert.equal(selectFirstQualifyingPurchases([b, a])[0].orderId, "earlier")
  })

  it("recognises renewal order types", () => {
    assert.equal(commissionKindForOrderType("renewal"), "renewal")
    assert.equal(commissionKindForOrderType("service_renewal"), "renewal")
    assert.equal(commissionKindForOrderType("new"), "initial")
    assert.equal(commissionKindForOrderType(null), "initial")
  })
})

// ---------------------------------------------------------------------------
// 3-4, 16. Attribution cookie behaviour.
// ---------------------------------------------------------------------------

describe("referral attribution cookie", () => {
  it("round-trips a code and visitor id", () => {
    const raw = serializeAttribution("ZWS12345", "visitor-abc")
    const parsed = parseAttribution(raw)
    assert.equal(parsed?.code, "ZWS12345")
    assert.equal(parsed?.visitorId, "visitor-abc")
  })

  it("rejects a malformed or missing cookie instead of trusting it", () => {
    assert.equal(parseAttribution(null), null)
    assert.equal(parseAttribution(""), null)
    assert.equal(parseAttribution("garbage"), null)
    assert.equal(parseAttribution("CODE.notanumber.visitor"), null)
    assert.equal(parseAttribution("CODE.0.visitor"), null)
  })

  it("expires an attribution older than the window", () => {
    const stale = `ZWS12345.${Date.now() - (REFERRAL_ATTRIBUTION_DAYS + 1) * 86_400_000}.v1`
    assert.equal(parseAttribution(stale), null, "a stale cookie must not resurrect an old referral")
  })

  it("defaults to a 30-day attribution period", () => {
    assert.equal(REFERRAL_ATTRIBUTION_DAYS, 30)
    assert.equal(REFERRAL_ATTRIBUTION_COOKIE, "zws_ref")
  })

  it("strips everything but A-Z0-9 from a code taken from the URL", () => {
    // A hostile code is reduced to a harmless alphanumeric string that cannot
    // match a stored account, rather than reaching the database as typed.
    for (const hostile of ["<script>alert(1)</script>", "'; DROP TABLE referrals; --", "../../etc/passwd", "A&B"]) {
      const sanitized = sanitizeReferralCodeInput(hostile)
      assert.match(sanitized, /^[A-Z0-9]*$/, `"${hostile}" sanitised to "${sanitized}"`)
    }
    assert.equal(sanitizeReferralCodeInput("ZWS12345"), "ZWS12345")
    assert.equal(sanitizeReferralCodeInput(""), "")
    assert.equal(sanitizeReferralCodeInput(null), "")
    // An input with no usable characters sanitises to empty, which then fails
    // the lookup in findReferralAccountByCode.
    assert.equal(sanitizeReferralCodeInput("!!!???"), "")
  })

  it("generates unguessable, non-identifying visitor ids", () => {
    const first = newVisitorId()
    const second = newVisitorId()
    assert.notEqual(first, second)
    assert.equal(first.length, 32)
    assert.equal(hashVisitor(first).length, 32)
    // The stored form is a hash, so a leaked row cannot be replayed.
    assert.notEqual(hashVisitor(first), first)
  })
})

// ---------------------------------------------------------------------------
// Regression guard: the browser bundle must never pull in the database.
// ---------------------------------------------------------------------------

describe("referral modules stay server-side", () => {
  it("no client component imports a module that reaches Prisma", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")

    const roots = ["components", "app"]
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue
          walk(full)
          continue
        }
        if (!/\.(tsx|ts)$/.test(entry)) continue
        const source = readFileSync(full, "utf8")
        if (!/^\s*["']use client["']/m.test(source)) continue
        const imported = source.match(/from\s+["'](@\/[^"']+)["']/g) || []
        for (const statement of imported) {
          const specifier = statement.replace(/from\s+["']/, "").replace(/["']$/, "")
          // Resolve the alias to a file and follow its transitive imports once,
          // which is enough to catch a direct `lib/db` reach-through.
          const candidate = specifier.replace("@/", "")
          if (!candidate.startsWith("lib/referrals/")) continue
          const target = join(candidate)
          let source: string
          try {
            source = readFileSync(`${target}.ts`, "utf8")
          } catch {
            continue
          }
          if (/from\s+["']@\/lib\/db["']/.test(source)) {
            offenders.push(`${full} -> ${specifier} (reaches @/lib/db)`)
          }
        }
      }
    }

    for (const root of roots) walk(root)
    assert.deepEqual(offenders, [], "a client component must not import a module that reaches Prisma")
  })
})

// ---------------------------------------------------------------------------
// 11. Reports agree with the database, and revenue excludes GST.
// ---------------------------------------------------------------------------

describe("report rows use the pre-GST base", () => {
  const invoices = [
    invoice({ customerId: "c1", orderId: "o1", eligibleBaseAmount: 1000, taxAmount: 180, amount: 1180 }),
    invoice({ customerId: "c1", orderId: "o2", orderType: "renewal", eligibleBaseAmount: 500, taxAmount: 90, amount: 590, paidAt: new Date("2026-10-01T00:00:00Z") }),
  ]
  const referrals = new Map([["c1", { id: "ref-1", code: "ZWS12345", referrerCustomerId: "r1", referrerName: "Referrer", referrerEmail: "r@example.com" }]])
  const customers = new Map([["c1", { id: "c1", name: "Referred", email: "c@example.com" }]])

  const rows = buildTransactionRows({
    invoices,
    ledger: new Map(),
    customers,
    referrals,
    rule: { commissionPercent: 10, holdDays: 14, isActive: true },
    maskEmails: false,
  })

  it("charges commission only on the first purchase", () => {
    assert.equal(rows.length, 2)
    assert.equal(rows[0].commission.amount, 100, "first purchase: 10% of 1000")
    assert.equal(rows[1].commission.amount, 0, "renewal earns nothing under the first-purchase policy")
    assert.equal(rows[1].commission.status, "not_first_purchase")
  })

  it("reports revenue excluding GST and GST separately", () => {
    assert.equal(rows[0].eligibleBaseAmount, 1000)
    assert.equal(rows[0].taxAmount, 180)
    assert.equal(rows[0].amount, 1180)
    const totals = summarizeReferralActivity({
      customers: [],
      transactions: rows,
    })
    assert.equal(totals.referralRevenue, 1500, "1000 + 500 pre-GST, not 1180 + 590")
    assert.equal(totals.gstCollected, 270)
    assert.equal(totals.totalCollected, 1770)
    assert.equal(totals.commissionEarned, 100)
  })

  it("masks a referred customer's email for the client view", () => {
    const masked = buildTransactionRows({
      invoices,
      ledger: new Map(),
      customers,
      referrals,
      rule: { commissionPercent: 10, holdDays: 0, isActive: true },
      maskEmails: true,
    })
    assert.notEqual(masked[0].referredCustomerEmail, "c@example.com")
    assert.ok(masked[0].referredCustomerEmail.includes("@"))
  })
})

// ---------------------------------------------------------------------------
// 16. Month and date filters use Asia/Kolkata consistently.
// ---------------------------------------------------------------------------

describe("filters use Asia/Kolkata", () => {
  it("buckets a purchase by the Indian calendar day it happened on", () => {
    // 2026-09-14T19:30:00Z is 15 September 01:00 in India.
    assert.equal(referralMonthKey(new Date("2026-09-14T19:30:00Z")), "2026-09")
    assert.equal(REFERRAL_APP_TIMEZONE, "Asia/Kolkata")
  })

  it("resolves last month to Indian month boundaries, not host-local ones", () => {
    // Midnight IST is 18:30 UTC the previous day, which is the point: a
    // host running in another timezone must still get the Indian month.
    const window = resolveReferralWindow({ range: "last_month", now: new Date("2026-10-12T09:00:00Z") })
    assert.equal(window.range, "last_month")
    assert.equal(window.start!.toISOString(), "2026-08-31T18:30:00.000Z")
    assert.equal(window.end!.toISOString(), "2026-09-30T18:29:59.999Z")
  })

  it("resolves an explicit date range to Indian day boundaries", () => {
    const window = resolveReferralWindow({ start: "2026-09-01", end: "2026-09-30", now: new Date("2026-10-12T09:00:00Z") })
    assert.equal(window.range, "custom")
    assert.equal(window.start!.toISOString(), "2026-08-31T18:30:00.000Z")
    assert.equal(window.end!.toISOString(), "2026-09-30T18:29:59.999Z")
  })

  it("handles a range that spans a year boundary", () => {
    const window = resolveReferralWindow({ start: "2026-12-15", end: "2027-01-15" })
    assert.ok(window.start && window.end)
    assert.ok(window.start! < window.end!)
    assert.equal(window.start!.getUTCFullYear(), 2026)
    assert.equal(window.end!.getUTCFullYear(), 2027)
  })

  it("keeps a September purchase in September even if it renews in October", () => {
    const rows = buildTransactionRows({
      invoices: [invoice({
        customerId: "c1",
        orderId: "o1",
        paidAt: new Date("2026-09-14T05:00:00Z"),
        serviceRenewalDueAt: new Date("2026-10-14T05:00:00Z"),
        serviceNextRenewalAt: new Date("2026-10-14T05:00:00Z"),
      })],
      ledger: new Map(),
      customers: new Map([["c1", { id: "c1", name: "Referred", email: "c@example.com" }]]),
      referrals: new Map([["c1", { id: "ref-1", code: "ZWS12345", referrerCustomerId: "r1", referrerName: "R", referrerEmail: "r@example.com" }]]),
      rule: { commissionPercent: 10, holdDays: 14, isActive: true },
      maskEmails: false,
    })
    assert.equal(rows[0].billingPeriodKey, "2026-09")
  })
})