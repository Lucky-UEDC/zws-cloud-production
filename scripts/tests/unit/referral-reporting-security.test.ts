import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { canAccessAdminApi, canAccessAdminPath } from "@/lib/admin-rbac"
import { clientCommissionList } from "@/lib/referrals/service"
import type { ReferralTransactionRow } from "@/lib/referrals/reporting"

const read = (path: string) => readFileSync(path, "utf8")

const CLIENT_ROUTES = [
  "app/api/client/referrals/summary/route.ts",
  "app/api/client/referrals/customers/route.ts",
  "app/api/client/referrals/orders/route.ts",
  "app/api/client/referrals/commissions/route.ts",
  "app/api/client/referrals/reports/route.ts",
  "app/api/client/referrals/customers/[id]/route.ts",
]

const ADMIN_ROUTES = [
  "app/api/admin/referrals/overview/route.ts",
  "app/api/admin/referrals/referrers/route.ts",
  "app/api/admin/referrals/relationships/route.ts",
  "app/api/admin/referrals/orders/route.ts",
  "app/api/admin/referrals/commissions/route.ts",
  "app/api/admin/referrals/reports/route.ts",
  "app/api/admin/referrals/export/route.ts",
]

const MUTATION_ROUTES = [
  "app/api/admin/referrals/commissions/[id]/route.ts",
  "app/api/admin/referrals/commissions/sync/route.ts",
  "app/api/admin/referrals/attribution/route.ts",
  "app/api/admin/referrals/program/route.ts",
]

describe("client referral API authorization", () => {
  it("resolves the caller from the session and refuses an anonymous request", () => {
    const http = read("lib/referrals/http.ts")
    assert.match(http, /const session = await getClientFromRequest\(request\)/)
    assert.match(http, /if \(!customerId\) return \{ ok: false, response: unauthorized\(\) \}/)

    for (const route of CLIENT_ROUTES) {
      const source = read(route)
      assert.match(source, /loadClientReferralContext|getClientFromRequest/, `${route} must resolve the caller from the session`)
      assert.match(source, /unauthorized\(/, `${route} must handle an unauthenticated caller`)
    }
  })

  it("never reads a referrer or customer id from the query string", () => {
    const source = read("lib/referrals/http.ts")
    assert.doesNotMatch(
      source,
      /searchParams\.get\("(referrerCustomerId|referrerAccountId|referrerId|customerId)"\)/,
      "a client must not be able to name another referrer",
    )
    assert.match(source, /getClientReferralScope\(customerId\)/)

    for (const route of CLIENT_ROUTES) {
      const routeSource = read(route)
      assert.doesNotMatch(routeSource, /searchParams\.get\("referrer/, `${route} must not accept a referrer id`)
    }
  })

  it("never returns credentials, tokens or full contact records of a referred customer", () => {
    for (const route of CLIENT_ROUTES) {
      const source = read(route)
      for (const forbidden of ["hashedPassword", "twoFactorSecret", "phoneNumber", "addressLine1", "gstin", "panNumber", "whatsappLastOtp"]) {
        assert.doesNotMatch(source, new RegExp(forbidden), `${route} must not expose ${forbidden}`)
      }
    }
    const reporting = read("lib/referrals/reporting.ts")
    assert.match(reporting, /maskEmailForReferrer/)
  })

  it("masks the referred customer's email for the client view and unmasked only for admin", () => {
    const http = read("lib/referrals/http.ts")
    assert.match(http, /maskEmails: true/, "the client dataset masks emails")

    const admin = read("lib/referrals/admin-http.ts")
    assert.match(admin, /maskEmails: false/, "an authorised operator sees the real address")
  })
})

describe("IDOR protection on the referred-customer detail endpoint", () => {
  const source = read("app/api/client/referrals/customers/[id]/route.ts")

  it("requires both the session's referral account and the requested customer in one query", () => {
    assert.match(source, /getClientFromRequest\(request\)/)
    assert.match(
      source,
      /prisma\.referral\.findFirst\(\{\s*where: \{ referredCustomerId, referrerAccountId: scope\.account\.accountId \}/,
      "ownership must be proven by the session, not by knowing an id",
    )
    assert.match(source, /if \(!owned\) return notFound\(\)/)
    assert.match(source, /if \(!scope\.account\) return unauthorized/)
  })

  it("returns the same 404 whether the referral is missing or belongs to someone else", () => {
    const notFoundResponses = source.match(/return notFound\(\)/g) || []
    assert.ok(notFoundResponses.length >= 2, "both branches must use the same status")
    assert.doesNotMatch(source, /status: 403/, "a 403 would confirm that the id exists")
  })

  it("re-scopes the fetch as well, so a second query cannot widen the result", () => {
    assert.match(source, /fetchReferralSources\(\{\s*referrerAccountId: scope\.account\.accountId,\s*referredCustomerId,/)
  })
})

describe("client scope is re-checked when the commission list is assembled", () => {
  it("drops rows that belong to a different referrer", () => {
    const base: ReferralTransactionRow = {
      referralId: "ref_a",
      referralCode: "AAAA1111",
      referrerCustomerId: "owner_a",
      referrerName: "A",
      referrerEmail: "a@example.com",
      referredCustomerId: "cust_1",
      referredCustomerName: "C",
      referredCustomerEmail: "c***@example.com",
      serviceId: null,
      serviceName: null,
      productId: "p1",
      productName: "P",
      orderId: "o1",
      orderNumber: "O1",
      orderType: null,
      invoiceId: "i1",
      invoiceNumber: "I1",
      purchaseDate: "2026-01-01T00:00:00.000Z",
      serviceStartDate: "2026-01-01T00:00:00.000Z",
      serviceActivatedAt: null,
      billingPeriod: "Jan 2026",
      billingPeriodKey: "2026-01",
      billingPeriodStart: null,
      billingPeriodEnd: null,
      renewalDate: null,
      expiryDate: null,
      amount: 100,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: "paid",
      orderStatus: "active",
      serviceStatus: "active",
      commission: { id: null, amount: 10, ratePercent: 10, status: "pending", kind: "initial", materialised: false, holdUntil: null, paidAt: null, reversedAt: null, reversalReason: null, notes: null },
    }
    const other = { ...base, referralId: "ref_b", referrerCustomerId: "owner_b", orderId: "o2", orderNumber: "O2" }

    const dataset = {
      customers: [],
      transactions: [base, other],
      windowTransactions: [base, other],
      truncated: false,
      referralTotal: 2,
      window: { range: "all" as const, start: null, end: null },
    }
    const filters = {
      range: "", start: "", end: "", productId: "", status: "all", commissionStatus: "all",
      search: "", referrerCustomerId: "", referredCustomerId: "", orderStatus: "", paymentStatus: "",
      month: "", sort: "", direction: "desc" as const, page: 1, pageSize: 20,
    }

    const forOwnerA = clientCommissionList({ dataset, filters, search: "", referrerCustomerId: "owner_a" })
    assert.deepEqual(forOwnerA.rows.map((row) => row.orderId), ["o1"])
    assert.equal(forOwnerA.pagination.total, 1)

    const forOwnerB = clientCommissionList({ dataset, filters, search: "", referrerCustomerId: "owner_b" })
    assert.deepEqual(forOwnerB.rows.map((row) => row.orderId), ["o2"])
  })
})

describe("admin referral API authorization", () => {
  it("gates every admin read behind the platform admin check", () => {
    const http = read("lib/referrals/http.ts")
    assert.match(http, /canAccessAdminApi\(admin\.role\)/)
    assert.match(http, /return null/)

    const adminHttp = read("lib/referrals/admin-http.ts")
    assert.match(adminHttp, /loadAdminIdentity\(request\)/)
    assert.match(adminHttp, /Administrator authorization required/)

    for (const route of ADMIN_ROUTES) {
      assert.match(read(route), /loadAdminReferralContext/, `${route} must go through the admin context`)
    }
  })

  it("requires the admin path check and rejects staff roles that may not use it", () => {
    assert.equal(canAccessAdminPath("super_admin", "/admin/referrals"), true)
    assert.equal(canAccessAdminPath("admin", "/admin/referrals"), true)
    assert.equal(canAccessAdminPath("billing_manager", "/admin/referrals"), true)
    assert.equal(canAccessAdminPath("support_agent", "/admin/referrals"), true)
    assert.equal(canAccessAdminPath("infrastructure_manager", "/admin/referrals"), false)
    assert.equal(canAccessAdminPath("blog_writer", "/admin/referrals"), false)
    assert.equal(canAccessAdminPath("seo_agent", "/admin/referrals"), false)
    assert.equal(canAccessAdminPath(null, "/admin/referrals"), false)

    // The API gate is coarser than the page gate and must not be weakened.
    assert.equal(canAccessAdminApi("seo_agent"), false)
    assert.equal(canAccessAdminApi(null), false)
    assert.equal(canAccessAdminApi("blog_writer"), true)
  })

  it("protects money-moving writes with same-origin and MFA step-up", () => {
    for (const route of MUTATION_ROUTES) {
      const source = read(route)
      assert.match(source, /requireSameOriginOrCsrf\(request\)/, `${route} must check origin/CSRF`)
      assert.match(source, /requireSensitiveAdminMfa\(request\)/, `${route} must require MFA step-up`)
    }
  })

  it("writes an audit trail for every commission and attribution decision", () => {
    assert.match(read("app/api/admin/referrals/commissions/[id]/route.ts"), /writeAuditLog/)
    assert.match(read("app/api/admin/referrals/attribution/route.ts"), /writeAuditLog/)
    assert.match(read("app/api/admin/referrals/program/route.ts"), /writeAuditLog/)
    assert.match(read("app/api/admin/referrals/commissions/sync/route.ts"), /writeAuditLog/)
  })

  it("refuses to pay a commission that is not pending, so money cannot move twice", () => {
    const source = read("app/api/admin/referrals/commissions/[id]/route.ts")
    assert.match(source, /if \(commission\.status === "paid"\) return badRequest\("Commission is already paid"\)/)
    assert.match(source, /if \(commission\.status !== "pending"\)/)
    assert.match(source, /A reason is required when reversing a commission/)
    assert.match(source, /if \(!reason\) return badRequest/)
  })
})

describe("input hardening", () => {
  it("runs search terms through the shared payload detector", () => {
    const http = read("lib/referrals/http.ts")
    assert.match(http, /validateSecurityField\(value, "search", "Search"\)/)
    assert.match(http, /message: result\.error \|\| "Invalid search query"/)
    assert.match(http, /badRequest\(search\.message\)/)
    assert.match(read("lib/referrals/admin-http.ts"), /badRequest\(search\.message\)/)
  })

  it("bounds every list query", () => {
    const filters = read("lib/referrals/filters.ts")
    assert.match(filters, /MAX_REFERRAL_PAGE_SIZE = 100/)
    assert.match(filters, /MAX_REFERRAL_SEARCH_LENGTH = 120/)
    assert.match(filters, /Math\.min\(MAX_REFERRAL_PAGE_SIZE/)

    const service = read("lib/referrals/service.ts")
    assert.match(service, /MAX_REFERRAL_SCAN_ROWS/)
    assert.match(service, /take: limit/)
  })

  it("rejects unsupported export datasets and formats", () => {
    const source = read("app/api/admin/referrals/export/route.ts")
    assert.match(source, /if \(!DATASETS\.has\(dataset\)\) return badRequest/)
    assert.match(source, /if \(!FORMATS\.has\(format\)\) return badRequest/)
    assert.match(source, /exportTabularResponse/)
    assert.match(source, /exportExcelXml/)
    assert.match(source, /exportPdfTable/)
  })
})

describe("registration capture", () => {
  it("records a referral only for a code that a real referrer owns", () => {
    const attribution = read("lib/referrals/attribution.ts")
    assert.match(attribution, /findReferralAccountByCode/)
    assert.match(attribution, /if \(referrer\.customerId === referredCustomerId\) return \{ status: "self_referral" \}/)
    assert.match(attribution, /prisma\.referral\.findUnique\(\{ where: \{ referredCustomerId \} \}\)/, "first touch is checked before writing")

    const register = read("app/api/auth/register/route.ts")
    assert.match(register, /captureReferral\(\{/)
    assert.match(register, /code: String\(body\.referralCode \|\| ""\),/)
    assert.match(register, /referral_capture_failed/, "a referral failure must never fail a signup")
  })

  it("sanitises the code carried on a registration link", () => {
    const program = read("lib/referrals/program.ts")
    assert.match(program, /sanitizeReferralCodeInput/)
    assert.match(program, /\.replace\(\/\[\^A-Z0-9\]\/g, ""\)/)

    const page = read("app/register/page.tsx")
    assert.match(page, /sanitizeReferralCodeInput\(params\.ref\)/)
  })

  it("keeps the referred customer to one referrer for life", () => {
    const schema = read("prisma/schema.prisma")
    assert.match(schema, /referredCustomerId\s+String\s+@unique @map\("referred_customer_id"\)/)
    const migration = read("prisma/migrations/20261010120000_referral_reporting/migration.sql")
    assert.match(migration, /CREATE UNIQUE INDEX "referrals_referred_customer_id_key"/)
    assert.match(migration, /CREATE UNIQUE INDEX "referral_commissions_order_id_key"/)
  })
})

describe("reporting reads authoritative records only", () => {
  it("derives revenue from paid service invoices through the shared revenue gate", () => {
    const commission = read("lib/referrals/commission.ts")
    assert.match(commission, /from "@\/lib\/revenue-analytics"/)
    assert.match(commission, /activeBillableOrderWhere, paidServiceInvoiceWhere/)
    assert.match(commission, /paidServiceInvoiceWhere\(\{ start: input\.start/)
    assert.doesNotMatch(commission, /customer\.createdAt/, "revenue must not be keyed to signup date")

    const reporting = read("lib/referrals/reporting.ts")
    assert.match(reporting, /const purchaseDate = invoice\.paidAt \|\| invoice\.createdAt/, "the transaction date is when the money arrived")
  })

  it("keeps one commission row per order so renewals earn separately", () => {
    const sync = read("lib/referrals/sync.ts")
    assert.match(sync, /orderId: \{\s*in: orderIds\s*\}/)
    assert.match(sync, /if \(current\.status !== "pending"\)/, "paid and reversed rows are historical facts")
    assert.match(sync, /status: "reversed"/)
  })
})

describe("UI surfaces the empty state and the truncated case", () => {
  it("client page renders an empty state and a mobile list", () => {
    const source = read("app/client-area/referrals/page.tsx")
    assert.match(source, /function EmptyState/)
    assert.match(source, /No referred customers match these filters yet\./)
    assert.match(source, /MobileCustomerList/)
    assert.match(source, /MobileOrderList/)
    assert.match(source, /sm:hidden/, "mobile layout must not be dropped")
  })

  it("admin page renders an empty state, pagination and export controls", () => {
    const source = read("app/admin/referrals/page.tsx")
    assert.match(source, /function EmptyAdmin/)
    assert.match(source, /Pagination/)
    assert.match(source, /csv/)
    assert.match(source, /"excel"/)
  })

  it("exposes the menu entry on both sides", () => {
    assert.match(read("components/client/client-sidebar.tsx"), /href: "\/client-area\/referrals"/)
    assert.match(read("components/admin/admin-sidebar.tsx"), /href: "\/admin\/referrals"/)
    assert.match(read("components/admin/admin-sidebar.tsx"), /label: "Referral Management"/)
  })
})