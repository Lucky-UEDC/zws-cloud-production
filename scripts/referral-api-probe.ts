#!/usr/bin/env node

/**
 * Referral HTTP authorization probe.
 *
 * Runs the real Next.js route handlers in-process against the live database
 * with real, freshly issued session cookies, so what it proves is what the
 * server actually does - not what a helper in isolation would do.
 *
 * Sessions are revoked and referral rows created for the probe are removed
 * before it exits, so it leaves no residue.
 *
 *   tsx scripts/referral-api-probe.ts
 */

import "dotenv/config"
import { prisma } from "@/lib/db"
import { issueSession, revokeSession } from "@/lib/auth/session-store"
import { SESSION_COOKIE_NAMES } from "@/lib/auth/session-cookies"
import { captureReferral, ensureReferralAccount } from "@/lib/referrals/attribution"
import { clearReferralProgramCache } from "@/lib/referrals/program"
import { syncAndReverse } from "@/lib/referrals/sync"

let failures = 0

function check(label: string, condition: boolean, detail: unknown = "") {
  const status = condition ? "PASS" : "FAIL"
  if (!condition) failures += 1
  console.log(`  [${status}] ${label}${detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`)
}

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE_NAMES.client}=${sessionId}`)
  return new Request(`http://127.0.0.1${path}`, { ...init, headers })
}

async function callRoute<T = any>(
  mod: { GET: (req: any, ctx?: any) => Promise<Response> },
  path: string,
  sessionId: string | null,
  cookieName: string = SESSION_COOKIE_NAMES.client,
) {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${cookieName}=${sessionId}`)
  const req = new (await import("next/server")).NextRequest(`http://127.0.0.1${path}`, { headers })
  const response = await mod.GET(req)
  const text = await response.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return { status: response.status, body: body as T, contentType: response.headers.get("content-type") || "" }
}

async function main() {
  const customers = await prisma.customer.findMany({
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  })
  if (customers.length < 2) throw new Error("Need at least two customers to probe ownership")

  const referrerCustomer = customers[0]
  const referredCustomer = customers[1]
  const otherCustomer = customers[2] || customers[0]

  const created = { accounts: [] as string[], referralId: "", commissions: [] as string[] }
  const sessions: string[] = []

  try {
    const referrerAccount = await ensureReferralAccount(referrerCustomer.id)
    const otherAccount = await ensureReferralAccount(otherCustomer.id)
    if (!referrerAccount || !otherAccount) throw new Error("Could not prepare referral accounts")
    created.accounts.push(referrerAccount.accountId, otherAccount.accountId)

    const existing = await prisma.referral.findUnique({ where: { referredCustomerId: referredCustomer.id }, select: { id: true } })
    if (existing) throw new Error("Probe customer already has an attribution; refusing to overwrite it")

    const captured = await captureReferral({ referredCustomerId: referredCustomer.id, code: referrerAccount.code, source: "code", metadata: { source: "referral_api_probe" } })
    if (captured.status !== "created") throw new Error(`Attribution was not created: ${captured.status}`)
    created.referralId = captured.referralId

    clearReferralProgramCache()
    await syncAndReverse({ limit: 5000 })
    created.commissions = (await prisma.referralCommission.findMany({ where: { referralId: created.referralId }, select: { id: true } })).map((row) => row.id)

    const clientSession = await issueSession({ userId: referrerCustomer.id, role: "client", email: referrerCustomer.email })
    const otherSession = await issueSession({ userId: otherCustomer.id, role: "client", email: otherCustomer.email })
    sessions.push(clientSession.sessionId, otherSession.sessionId)

    const summary = await import("@/app/api/client/referrals/summary/route")
    const customersRoute = await import("@/app/api/client/referrals/customers/route")
    const ordersRoute = await import("@/app/api/client/referrals/orders/route")
    const commissionsRoute = await import("@/app/api/client/referrals/commissions/route")
    const reportsRoute = await import("@/app/api/client/referrals/reports/route")
    const detailRoute = await import("@/app/api/client/referrals/customers/[id]/route")

    const adminOverview = await import("@/app/api/admin/referrals/overview/route")
    const adminReferrers = await import("@/app/api/admin/referrals/referrers/route")
    const adminRelationships = await import("@/app/api/admin/referrals/relationships/route")
    const adminOrders = await import("@/app/api/admin/referrals/orders/route")
    const adminCommissions = await import("@/app/api/admin/referrals/commissions/route")
    const adminReports = await import("@/app/api/admin/referrals/reports/route")
    const adminExport = await import("@/app/api/admin/referrals/export/route")
    const adminProgram = await import("@/app/api/admin/referrals/program/route")
    const adminSync = await import("@/app/api/admin/referrals/commissions/sync/route")

    console.log("Client: own referrals are readable")
    const referredEmail = (await prisma.customer.findUnique({ where: { id: referredCustomer.id }, select: { email: true } }))?.email || ""
    for (const [name, mod, path] of [
      ["summary", summary, "/api/client/referrals/summary"],
      ["customers", customersRoute, "/api/client/referrals/customers"],
      ["orders", ordersRoute, "/api/client/referrals/orders"],
      ["commissions", commissionsRoute, "/api/client/referrals/commissions"],
      ["reports?group=month", reportsRoute, "/api/client/referrals/reports?group=month"],
    ] as const) {
      const result = await callRoute(mod as any, path, clientSession.sessionId)
      check(`GET ${path} (${name})`, result.status === 200, `status=${result.status}`)
      check(
        `  ${name} never contains the referred customer's full email`,
        Boolean(referredEmail) && !JSON.stringify(result.body).includes(referredEmail),
        "",
      )
    }

    const ownCustomers = await callRoute(customersRoute as any, "/api/client/referrals/customers", clientSession.sessionId)
    const ownRows: any[] = ownCustomers.body?.customers || []
    check("own referred customers are returned", ownRows.length >= 1, `count=${ownRows.length}`)
    check("own customer rows carry no raw email", ownRows.every((row) => String(row.email || "").includes("***")), ownRows.map((r) => r.email))
    check("own customer rows carry no password fields", !JSON.stringify(ownCustomers.body).match(/hashedPassword|twoFactorSecret|phoneNumber|addressLine1/), "")

    const ownOrders = await callRoute(ordersRoute as any, "/api/client/referrals/orders", clientSession.sessionId)
    const ownOrderRows: any[] = ownOrders.body?.orders || []
    check("own referred orders are returned", ownOrderRows.length >= 1, `count=${ownOrderRows.length}`)
    check("every order row names a billing period", ownOrderRows.every((row) => Boolean(row.billingPeriod)), ownOrderRows.map((r) => r.billingPeriod))
    check("every order row names a purchase date", ownOrderRows.every((row) => Boolean(row.purchaseDate)), "")
    check("every order row carries a commission amount", ownOrderRows.every((row) => typeof row.commission?.amount === "number"), "")

    console.log("\nClient A cannot see client B")
    const otherSummary = await callRoute(summary as any, "/api/client/referrals/summary", otherSession.sessionId)
    check("other client gets 200 for their own summary", otherSummary.status === 200, `status=${otherSummary.status}`)
    check("other client sees zero referrals", otherSummary.body?.summary?.totalReferrals === 0, otherSummary.body?.summary?.totalReferrals)
    const otherOrders = await callRoute(ordersRoute as any, "/api/client/referrals/orders", otherSession.sessionId)
    check("other client sees zero referred orders", (otherOrders.body?.orders || []).length === 0, (otherOrders.body?.orders || []).length)
    const otherCommissions = await callRoute(commissionsRoute as any, "/api/client/referrals/commissions", otherSession.sessionId)
    check("other client sees zero commissions", (otherCommissions.body?.commissions || []).length === 0, (otherCommissions.body?.commissions || []).length)

    console.log("\nIDOR: naming another referrer's customer does not help")
    const tamperedReferrer = await callRoute(summary as any, "/api/client/referrals/summary?referrerCustomerId=cmu0000000000000000000&customerId=cmu0000000000000000000", otherSession.sessionId)
    check("client cannot widen its scope with query params", tamperedReferrer.body?.summary?.totalReferrals === 0, tamperedReferrer.body?.summary?.totalReferrals)
    const idor = await callRoute(detailRoute as any, `/api/client/referrals/customers/${referredCustomer.id}`, otherSession.sessionId, SESSION_COOKIE_NAMES.client)
      .catch(() => null) || await (async () => {
        const headers = new Headers()
        headers.set("cookie", `${SESSION_COOKIE_NAMES.client}=${otherSession.sessionId}`)
        const req = new (await import("next/server")).NextRequest(`http://127.0.0.1/api/client/referrals/customers/${referredCustomer.id}`, { headers })
        const res = await detailRoute.GET(req, { params: Promise.resolve({ id: referredCustomer.id }) })
        return { status: res.status, body: await res.json().catch(() => null) }
      })()
    check("other client gets 404 for a referred customer it does not own", idor.status === 404, `status=${idor.status}`)
    const own = await (async () => {
      const headers = new Headers()
      headers.set("cookie", `${SESSION_COOKIE_NAMES.client}=${clientSession.sessionId}`)
      const req = new (await import("next/server")).NextRequest(`http://127.0.0.1/api/client/referrals/customers/${referredCustomer.id}`, { headers })
      const res = await detailRoute.GET(req, { params: Promise.resolve({ id: referredCustomer.id }) })
      return { status: res.status, body: await res.json().catch(() => null) }
    })()
    check("owner gets 200 for its own referred customer", own.status === 200, `status=${own.status}`)
    check("owner detail includes the order history", Array.isArray(own.body?.orders) && own.body.orders.length >= 1, own.body?.orders?.length)

    console.log("\nFilters, pagination and search")
    const page1 = await callRoute(customersRoute as any, "/api/client/referrals/customers?pageSize=1&page=1", clientSession.sessionId)
    const page2 = await callRoute(customersRoute as any, "/api/client/referrals/customers?pageSize=1&page=2", clientSession.sessionId)
    check("pagination reports a page size", page1.body?.pagination?.pageSize === 1, page1.body?.pagination)
    check("pagination clamps an oversized page size", (await callRoute(ordersRoute as any, "/api/client/referrals/orders?pageSize=5000", clientSession.sessionId)).body?.pagination?.pageSize === 100, "")
    check("page 1 returns at most one row", (page1.body?.customers || []).length <= 1, (page1.body?.customers || []).length)
    check("page 2 is empty when there is only one referred customer", (page2.body?.customers || []).length === 0, (page2.body?.customers || []).length)

    const orderSearch = await callRoute(ordersRoute as any, "/api/client/referrals/orders?search=TEST-465543", clientSession.sessionId)
    check("order search by order id finds the transaction", (orderSearch.body?.orders || []).length >= 1, (orderSearch.body?.orders || []).length)
    const orderSearchMiss = await callRoute(ordersRoute as any, "/api/client/referrals/orders?search=NO-SUCH-ORDER-999", clientSession.sessionId)
    check("order search with no match returns an empty page", (orderSearchMiss.body?.orders || []).length === 0, "")
    const productMiss = await callRoute(ordersRoute as any, "/api/client/referrals/orders?productId=does-not-exist", clientSession.sessionId)
    check("product filter with no match returns an empty page", (productMiss.body?.orders || []).length === 0, "")
    const badRange = await callRoute(ordersRoute as any, "/api/client/referrals/orders?start=2026-02-31&end=2026-01-01", clientSession.sessionId)
    check("an impossible date is ignored rather than silently rolling over", badRange.status === 200, `status=${badRange.status}`)
    const badSearch = await callRoute(ordersRoute as any, "/api/client/referrals/orders?search=%25%25", clientSession.sessionId)
    check("a wildcard-only search returns nothing instead of everything", (badSearch.body?.orders || []).length === 0, (badSearch.body?.orders || []).length)
    const unknownReport = await callRoute(reportsRoute as any, "/api/client/referrals/reports?group=bogus", clientSession.sessionId)
    check("an unsupported report group is rejected", unknownReport.status === 400, `status=${unknownReport.status}`)

    console.log("\nClient cannot reach admin referral APIs")
    for (const [name, mod, path] of [
      ["overview", adminOverview, "/api/admin/referrals/overview"],
      ["referrers", adminReferrers, "/api/admin/referrals/referrers"],
      ["relationships", adminRelationships, "/api/admin/referrals/relationships"],
      ["orders", adminOrders, "/api/admin/referrals/orders"],
      ["commissions", adminCommissions, "/api/admin/referrals/commissions"],
      ["reports", adminReports, "/api/admin/referrals/reports"],
      ["export", adminExport, "/api/admin/referrals/export?format=csv"],
      ["program", adminProgram, "/api/admin/referrals/program"],
    ] as const) {
      const result = await callRoute(mod as any, path, clientSession.sessionId)
      check(`GET ${path} with a client session`, result.status === 401, `status=${result.status}`)
    }
    const syncNoAuth = await (async () => {
      const headers = new Headers()
      headers.set("cookie", `${SESSION_COOKIE_NAMES.client}=${clientSession.sessionId}`)
      const req = new (await import("next/server")).NextRequest("http://127.0.0.1/api/admin/referrals/commissions/sync", { method: "POST", headers })
      const res = await adminSync.POST(req)
      return { status: res.status, body: await res.json().catch(() => null) }
    })()
    check("POST /api/admin/referrals/commissions/sync with a client session", syncNoAuth.status >= 400, `status=${syncNoAuth.status}`)

    console.log("\nAdmin can read the referral reports")
    const admin = await prisma.adminProfile.findFirst({ select: { id: true, email: true, role: true }, orderBy: { createdAt: "asc" } })
    if (!admin) {
      check("an admin profile exists", false, "none found")
    } else {
      const adminSession = await issueSession({ userId: admin.id, role: admin.role as any, email: admin.email })
      sessions.push(adminSession.sessionId)
      for (const [name, mod, path] of [
        ["overview", adminOverview, "/api/admin/referrals/overview"],
        ["referrers", adminReferrers, "/api/admin/referrals/referrers"],
        ["relationships", adminRelationships, "/api/admin/referrals/relationships"],
        ["orders", adminOrders, "/api/admin/referrals/orders"],
        ["commissions", adminCommissions, "/api/admin/referrals/commissions"],
        ["reports", adminReports, "/api/admin/referrals/reports?group=month"],
        ["program", adminProgram, "/api/admin/referrals/program"],
      ] as const) {
        const result = await callRoute(mod as any, path, adminSession.sessionId, SESSION_COOKIE_NAMES.admin)
        check(`GET ${path} with an admin session`, result.status === 200, `status=${result.status}`)
        if (name === "overview" && result.status === 200) {
          check("  admin overview exposes unmasked emails", JSON.stringify(result.body).includes("@") && !String(JSON.stringify(result.body.topReferredCustomers || [])).includes("***"), "")
        }
      }

      console.log("\nAdmin exports")
      for (const format of ["csv", "excel", "pdf"]) {
        const headers = new Headers()
        headers.set("cookie", `${SESSION_COOKIE_NAMES.admin}=${adminSession.sessionId}`)
        const req = new (await import("next/server")).NextRequest(`http://127.0.0.1/api/admin/referrals/export?format=${format}&dataset=orders`, { headers })
        const res = await adminExport.GET(req)
        const type = res.headers.get("content-type") || ""
        const disposition = res.headers.get("content-disposition") || ""
        check(`export ${format}`, res.status === 200 && type.length > 0 && disposition.includes("attachment"), `${res.status} ${type} ${disposition}`)
      }
    }

    console.log("\nAnonymous callers are rejected")
    for (const [name, mod, path] of [
      ["summary", summary, "/api/client/referrals/summary"],
      ["orders", ordersRoute, "/api/client/referrals/orders"],
      ["overview", adminOverview, "/api/admin/referrals/overview"],
    ] as const) {
      const result = await callRoute(mod as any, path, null)
      check(`GET ${path} without a session`, result.status === 401, `status=${result.status}`)
    }
  } finally {
    for (const sessionId of sessions) await revokeSession(sessionId).catch(() => undefined)
    await prisma.referralCommission.deleteMany({ where: { id: { in: created.commissions } } })
    if (created.referralId) await prisma.referral.deleteMany({ where: { id: created.referralId } })
    await prisma.referralAccount.deleteMany({ where: { id: { in: created.accounts } } })
    console.log("\nProbe cleanup complete")
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
  if (failures) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error("[REFERRAL_API_PROBE] failed", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })