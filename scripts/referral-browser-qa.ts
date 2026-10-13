/**
 * Browser QA for the referral screens.
 *
 * Drives the real production build with real sessions against the live
 * database, so what it reports is what an operator or customer would see.
 *
 *   tsx scripts/referral-browser-qa.ts
 */

import { chromium, type Browser } from "@playwright/test"

const BASE_URL = process.env.REFERRAL_QA_BASE_URL || "http://127.0.0.1:3111"
const OUT_DIR = process.env.REFERRAL_QA_OUT || "/tmp/opencode/referral-qa"

let failures = 0

function check(label: string, condition: boolean, detail: unknown = "") {
  if (!condition) failures += 1
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`)
}

/** Host the session cookie must be scoped to, derived from BASE_URL. */
const cookieDomain = (() => {
  try {
    return new URL(BASE_URL).hostname
  } catch {
    return "127.0.0.1"
  }
})()

async function cookieValue(cookie: string) {
  // The `__Host-` prefix forces Secure + host-only, which Chromium refuses to
  // set over plain http. The platform also accepts the legacy cookie names for
  // exactly this kind of local run, so use those here.
  const [rawName, ...rest] = cookie.split("=")
  const name = rawName.startsWith("__Host-") ? rawName.replace("__Host-", "") : rawName
  return { name, value: rest.join("=") }
}

const IGNORED_CONSOLE = [
  // Next.js dev mode needs eval() but the platform ships a production CSP.
  "eval() is not supported",
]

function collect(page: any, sink: string[]) {
  page.on("pageerror", (error: any) => {
    const text = String(error)
    if (!IGNORED_CONSOLE.some((ignored) => text.includes(ignored))) sink.push(text)
  })
  page.on("console", (message: any) => {
    if (message.type() !== "error") return
    const text = message.text()
    if (!IGNORED_CONSOLE.some((ignored) => text.includes(ignored))) sink.push(text)
  })
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

async function main() {
  const clientCookie = process.env.REFERRAL_QA_CLIENT_COOKIE || ""
  const adminCookie = process.env.REFERRAL_QA_ADMIN_COOKIE || ""
  if (!clientCookie || !adminCookie) throw new Error("Both session cookies are required")

  await withBrowser(async (browser) => {
    // ---------------------------------------------------------------- client
    console.log("Client: /client-area/referrals")
    const clientContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await clientContext.addCookies([{ ...(await cookieValue(clientCookie)), domain: cookieDomain, path: "/", secure: BASE_URL.startsWith("https") } as any])
    const client = await clientContext.newPage()
    const consoleErrors: string[] = []
    collect(client, consoleErrors)

    await client.goto(`${BASE_URL}/client-area/referrals`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await client.locator("h1", { hasText: "Referrals" }).first().waitFor({ timeout: 30_000 })
    await client.locator("text=/your referral code/i").first().waitFor({ timeout: 30_000 })
    check("client page renders the Referrals heading", true)
    check("referral code card is shown", await client.locator("text=/your referral code/i").count() > 0)
    check("nav has the Referrals entry", await client.locator('a[href="/client-area/referrals"]').count() > 0)

    const codeText = (await client.locator("text=/your referral code/i").first().locator("xpath=../..").innerText()).trim()
    check("a referral code is rendered", /[A-Z0-9]{6,16}/.test(codeText), codeText.split("\n").slice(0, 4).join(" | "))

    await client.locator('[data-slot="card-title"]').first().waitFor({ timeout: 30_000 })
    await client.waitForTimeout(1200)
    const cards = await client.locator('[data-slot="card-title"]').allInnerTexts()
    check("summary cards render", cards.length >= 6, cards)
    const totals = await client.locator("text=Referral Revenue").first().locator("xpath=..").innerText()
    check("referral revenue card shows a value", /\d/.test(totals), totals.replace(/\n/g, " "))

    // The click -> account -> purchase funnel must be three separate numbers.
    const visitsCard = await client.locator("text=Referral Visits").first().locator("xpath=..").innerText()
    const accountsCard = await client.locator("text=Registered Accounts").first().locator("xpath=..").innerText()
    const buyersCard = await client.locator("text=Customers Who Purchased a VPS").first().locator("xpath=..").innerText()
    check("visits are counted separately from accounts and purchases",
      /\d/.test(visitsCard) && /\d/.test(accountsCard) && /\d/.test(buyersCard),
      [visitsCard, accountsCard, buyersCard].map((row) => row.replace(/\n/g, " ")).join(" | "))

    const customerRows = await client.locator("table tbody tr").count()
    check("referred customer rows render", customerRows >= 1, `rows=${customerRows}`)
    const customerTable = await client.locator("table").first().innerText()
    check("referred customer email is masked in the table", customerTable.includes("***"), "")
    check("referred customer email is not shown in full", !customerTable.includes("@zws.local.test") || customerTable.includes("te***@zws.local.test"), "")

    // Services & orders tab
    await client.getByRole("tab", { name: /Services & Orders/i }).click()
    await client.waitForTimeout(1200)
    const orderTable = await client.locator("table").first().innerText()
    check("order history renders a billing period", /[A-Z][a-z]{2} \d{4}/.test(orderTable), orderTable.split("\n").slice(0, 6).join(" | "))
    check("order history shows a commission column", /Commission/i.test(orderTable), "")
    check("order history shows a purchase date", /2026/.test(orderTable), "")
    check("order history shows the service", /Zp2|Cloud|VPS|Dedicated/i.test(orderTable), "")

    // Monthly report tab
    await client.getByRole("tab", { name: /Monthly Report/i }).click()
    await client.waitForTimeout(1200)
    const monthlyText = await client.locator("body").innerText()
    check("monthly report renders", monthlyText.includes("Monthly Referral Performance"), "")
    check("monthly report lists a month row", /[A-Z][a-z]{2} \d{4}/.test(monthlyText), "")
    check("service-wise report renders", monthlyText.includes("Service-wise Performance"), "")
    check("date-wise report renders", monthlyText.includes("Date-wise Activity"), "")

    // Filters
    await client.getByRole("tab", { name: /Referral Customers/i }).click()
    await client.waitForTimeout(800)
    const searchBox = client.getByPlaceholder("Customer, order ID, service")
    await searchBox.fill("TEST-465543")
    await searchBox.press("Enter")
    await client.waitForTimeout(1500)
    const searched = await client.locator("table tbody tr").count()
    check("search by order id returns the referred order's customer", searched >= 1, `rows=${searched}`)
    await searchBox.fill("definitely-no-such-referral")
    await searchBox.press("Enter")
    await client.waitForTimeout(1500)
    check("search with no match shows the empty state", await client.locator("text=No referred customers match these filters yet.").count() > 0, "")
    await client.screenshot({ path: `${OUT_DIR}/client-empty-state.png`, fullPage: true })

    // Date range filter
    await searchBox.fill("")
    await searchBox.press("Enter")
    await client.waitForTimeout(1000)
    await client.locator("button").filter({ hasText: "All time" }).first().click()
    await client.waitForTimeout(500)
    await client.getByRole("option", { name: "This month" }).click()
    await client.waitForTimeout(1800)
    check("date range filter applies without error", consoleErrors.length === 0, consoleErrors.slice(0, 3))

    await client.screenshot({ path: `${OUT_DIR}/client-referrals-desktop.png`, fullPage: true })

    // Mobile
    const mobile = await clientContext.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(`${BASE_URL}/client-area/referrals`, { waitUntil: "domcontentloaded" })
    await mobile.waitForTimeout(2500)
    const hasHorizontalOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
    check("mobile layout has no horizontal page overflow", !hasHorizontalOverflow, "")
    await mobile.screenshot({ path: `${OUT_DIR}/client-referrals-mobile.png`, fullPage: true })
    await mobile.close()

    check("no client-side console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3))
    await clientContext.close()

    // ----------------------------------------------------------------- admin
    console.log("\nAdmin: /admin/referrals")
    const adminContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    await adminContext.addCookies([{ ...(await cookieValue(adminCookie)), domain: cookieDomain, path: "/", secure: BASE_URL.startsWith("https") } as any])
    const admin = await adminContext.newPage()
    const adminErrors: string[] = []
    collect(admin, adminErrors)

    await admin.goto(`${BASE_URL}/admin/referrals`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await admin.waitForSelector("text=Referral Management", { timeout: 30_000 })
    check("admin page renders the heading", true)
    check("sidebar shows Referral Management", await admin.locator("text=Referral Management").count() > 0)

    const selectedNavItems = async () => {
      // The sidebar renders twice (desktop rail + mobile drawer), and a parent
      // group stays highlighted while one of its children is active, so only
      // the leaf `?tab=` links are counted.
      const links = await admin.locator('aside a[href^="/admin/referrals?tab="]').all()
      const selected = new Set<string>()
      for (const link of links) {
        const className = (await link.getAttribute("class")) || ""
        if (!className.includes("selected-item")) continue
        selected.add(`${await link.getAttribute("href")}`)
      }
      return [...selected]
    }
    check("no referral leaf nav item is active at rest", (await selectedNavItems()).length === 0, await selectedNavItems())
    await admin.goto(`${BASE_URL}/admin/referrals?tab=commissions`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await admin.waitForSelector("text=Referral Management", { timeout: 30_000 })
    check("the ?tab= link activates exactly one nav item", (await selectedNavItems()).length === 1, await selectedNavItems())
    await admin.goto(`${BASE_URL}/admin/referrals`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await admin.waitForSelector("text=Referral Management", { timeout: 30_000 })

    await admin.locator("text=Top Referrers").first().waitFor({ timeout: 60_000 })
    await admin.waitForTimeout(1500)
    const overviewText = await admin.locator("body").innerText()
    for (const label of ["Referrers", "Referred Customers", "Conversion Rate", "Unique Visits", "Registered Accounts", "First-Purchase Conversions", "Referral Revenue excl. GST", "GST Collected", "Commission Earned", "Commission Paid", "Pending Commission", "Reversed Commission"]) {
      check(`overview card: ${label}`, overviewText.includes(label), "")
    }
    check("overview renders top referrers", overviewText.includes("Top Referrers"), "")
    check("overview renders top referred customers", overviewText.includes("Top Referred Customers"), "")
    check("overview renders monthly performance", overviewText.includes("Monthly Referral Performance"), "")
    check("overview renders active vs inactive", overviewText.includes("Active vs Inactive Referrals"), "")
    check("admin sees the referred customer's real email", overviewText.includes("test-order-465543@zws.local.test"), "")
    await admin.screenshot({ path: `${OUT_DIR}/admin-referrals-overview.png`, fullPage: true })

    for (const [tab, marker] of [
      ["Referrers", "Referrers"],
      ["Referrals", "Referral Relationships"],
      ["Orders", "Referred Orders"],
      ["Commissions", "Commission Ledger"],
      ["Reports", "Monthly Referral Report"],
    ] as const) {
      await admin.getByRole("tab", { name: new RegExp(`^${tab}$`, "i") }).click()
      // Soft navigation can settle a tick after the click, so poll for the
      // panel content instead of trusting a fixed sleep.
      let markerVisible = false
      for (let attempt = 0; attempt < 20 && !markerVisible; attempt += 1) {
        await admin.waitForTimeout(500)
        markerVisible = (await admin.locator("body").innerText()).includes(marker)
      }
      check(`tab ${tab} renders ${marker}`, markerVisible, "")
    }
    await admin.screenshot({ path: `${OUT_DIR}/admin-referrals-reports.png`, fullPage: true })

    // Export buttons hit the export endpoint.
    const csvResponse = adminContext.request.get(`${BASE_URL}/api/admin/referrals/export?format=csv&dataset=orders`, {
      headers: { cookie: adminCookie },
    })
    const csv = await csvResponse
    check("admin CSV export responds", csv.status() === 200, `status=${csv.status()}`)
    check("admin CSV export is an attachment", (csv.headers()["content-disposition"] || "").includes("attachment"), csv.headers()["content-type"])

    check("no admin console errors", adminErrors.length === 0, adminErrors.slice(0, 3))
    await adminContext.close()
  })

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} BROWSER CHECK(S) FAILED`}`)
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error("[REFERRAL_BROWSER_QA] failed", error)
  process.exitCode = 1
})