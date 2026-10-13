/**
 * Referral service layer.
 *
 * Both dashboards read through here so the client view and the admin view can
 * never disagree about what a number means: the same qualifying-transaction
 * query, the same commission rules, the same status derivation.
 *
 * Scoping is the important part. A client dataset is always narrowed to the
 * referral account that belongs to the authenticated customer id, and no client
 * endpoint accepts a referrer id from the caller - the owner always comes from
 * the session, never from the query string.
 */

import { prisma } from "@/lib/db"
import { buildReferralLink, ensureReferralAccount, type ReferralIdentity } from "@/lib/referrals/attribution"
import { getReferralProgramRule, type ReferralProgramRule } from "@/lib/referrals/program"
import {
  buildCustomerRows,
  buildPaginationMeta,
  customerMatchesSearch,
  customerMatchesStatus,
  fillMonthlySeries,
  groupTransactionsByDay,
  groupTransactionsByMonth,
  groupTransactionsByProduct,
  loadServiceStates,
  normalizePagination,
  sortCustomers,
  sortTransactions,
  summarizeReferralActivity,
  transactionInWindow,
  transactionMatchesProduct,
  transactionMatchesSearch,
  transactionMatchesStatus,
  type ReferralCustomerRow,
  type ReferralCustomerSource,
  type ReferralTransactionRow,
} from "@/lib/referrals/reporting"
import { billingPeriodLabel } from "@/lib/referrals/reporting"
import { MAX_REFERRAL_GROUP_ROWS, normalizeReferralSearch, type ReferralWindow } from "@/lib/referrals/filters"
import { publicOrigin } from "@/lib/public-url"
import { summarizeVisits } from "@/lib/referrals/visits"
import { roundMoney } from "@/lib/referrals/commission"

export const MAX_REFERRAL_SCAN_ROWS = MAX_REFERRAL_GROUP_ROWS

export type ReferralFilters = {
  range: string
  start: string
  end: string
  productId: string
  status: string
  commissionStatus: string
  search: string
  referrerCustomerId: string
  referredCustomerId: string
  orderStatus: string
  paymentStatus: string
  month: string
  sort: string
  direction: "asc" | "desc"
  page: number
  pageSize: number
}

export function referralFiltersFromParams(params: URLSearchParams | Record<string, string | undefined>): ReferralFilters {
  const read = (key: string) => {
    const value = (params instanceof URLSearchParams ? params.get(key) : params[key]) ?? ""
    return String(value).trim()
  }
  const direction = read("direction").toLowerCase() === "asc" ? "asc" : "desc"
  return {
    range: read("range"),
    start: read("start"),
    end: read("end"),
    productId: read("productId"),
    status: read("status").toLowerCase(),
    commissionStatus: read("commissionStatus").toLowerCase(),
    search: normalizeReferralSearch(read("search") || read("q")),
    referrerCustomerId: read("referrerCustomerId"),
    referredCustomerId: read("referredCustomerId"),
    orderStatus: read("orderStatus").toLowerCase(),
    paymentStatus: read("paymentStatus").toLowerCase(),
    month: /^\d{4}-\d{2}$/.test(read("month")) ? read("month") : "",
    sort: read("sort"),
    direction,
    page: Number(read("page") || 1),
    pageSize: Number(read("pageSize") || 20),
  }
}

export type ReferralScope = {
  account: ReferralIdentity | null
  program: ReferralProgramRule
  referralLink: string
}

async function resolveScopeForAccount(account: ReferralIdentity | null): Promise<ReferralScope> {
  let origin = ""
  try {
    origin = publicOrigin() || ""
  } catch {
    origin = ""
  }
  return {
    account,
    program: await getReferralProgramRule(),
    referralLink: account ? buildReferralLink(origin, account.code) : "",
  }
}

/**
 * Client scope. The referrer identity is derived from the authenticated
 * customer id only - there is deliberately no input that can move it.
 */
export async function getClientReferralScope(customerId: string): Promise<ReferralScope> {
  if (!customerId) return resolveScopeForAccount(null)
  const account = await ensureReferralAccount(customerId).catch((error) => {
    console.error("[REFERRALS] account_ensure_failed", error instanceof Error ? error.message : String(error))
    return null
  })
  return resolveScopeForAccount(account)
}

export type ReferralFetchResult = {
  sources: ReferralCustomerSource[]
  total: number
  truncated: boolean
}

export async function fetchReferralSources(input: {
  referrerAccountId?: string | null
  referrerCustomerId?: string | null
  referredCustomerId?: string | null
  search?: string
  limit?: number
}): Promise<ReferralFetchResult> {
  const search = normalizeReferralSearch(input.search)
  const where: Record<string, any> = {}
  if (input.referrerAccountId) where.referrerAccountId = input.referrerAccountId
  if (input.referrerCustomerId) where.referrerCustomerId = input.referrerCustomerId
  if (input.referredCustomerId) where.referredCustomerId = input.referredCustomerId
  if (search) {
    where.referredCustomer = {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    }
  }

  const limit = Math.max(1, Math.min(MAX_REFERRAL_SCAN_ROWS, Number(input.limit) || MAX_REFERRAL_SCAN_ROWS))
  const [total, rows] = await Promise.all([
    prisma.referral.count({ where }),
    prisma.referral.findMany({
      where,
      orderBy: { registeredAt: "desc" },
      take: limit,
      include: {
        referrer: { select: { id: true, name: true, email: true } },
        referredCustomer: { select: { id: true, name: true, email: true, status: true } },
      },
    }),
  ])

  return { sources: rows as unknown as ReferralCustomerSource[], total, truncated: total > rows.length }
}

export type ReferralDataset = {
  customers: ReferralCustomerRow[]
  transactions: ReferralTransactionRow[]
  windowTransactions: ReferralTransactionRow[]
  truncated: boolean
  referralTotal: number
  window: ReferralWindow
  /**
   * Link-opens for the referral codes in scope, split from the account and
   * purchase numbers. A click is not a customer and cannot become one here.
   */
  visits: {
    total: number
    inWindow: number
    registeredAccounts: number
    convertedCustomers: number
    conversionRate: number
    purchaseConversionRate: number
  }
}

/** Visits for a dataset, with the funnel rates derived rather than stored. */
export function visitSummaryFor(dataset: Pick<ReferralDataset, "visits">) {
  const visits = dataset.visits
  const conversionRate = visits.total > 0 ? roundMoney((visits.registeredAccounts / visits.total) * 100) : 0
  const purchaseConversionRate = visits.registeredAccounts > 0
    ? roundMoney((visits.convertedCustomers / visits.registeredAccounts) * 100)
    : 0
  return { ...visits, conversionRate, purchaseConversionRate }
}

/**
 * Loads the derived dataset for a set of referrals.
 *
 * Lifetime transactions are loaded once for the referrals in scope and the
 * range filter is then applied in memory, which is what makes "this month" and
 * "all time" return the same customer list with different totals.
 */
export async function buildReferralDataset(input: {
  sources: ReferralCustomerSource[]
  window: ReferralWindow
  maskEmails: boolean
  truncated?: boolean
  referralTotal?: number
  productId?: string | null
  commissionStatus?: string | null
  /** Referral codes in scope; used to attach the click funnel. */
  referralCodes?: string[]
}): Promise<ReferralDataset> {
  const { rows, transactions } = await buildCustomerRows({
    referrals: input.sources,
    maskEmails: input.maskEmails,
    lifetimeWindow: input.window,
  })

  const productId = String(input.productId || "")
  const commissionStatus = String(input.commissionStatus || "all")

  const windowTransactions = sortTransactions(
    transactions
      .filter((row) => transactionInWindow(row, input.window))
      .filter((row) => transactionMatchesProduct(row, productId))
      .filter((row) => transactionMatchesStatus(row, commissionStatus)),
    "earnedAt",
    "desc",
  )

  const customers = productId || (commissionStatus && commissionStatus !== "all")
    ? rows.filter((row) => windowTransactions.some((transaction) => transaction.referredCustomerId === row.referredCustomerId))
    : rows

  const codes = input.referralCodes ?? input.sources.map((row) => row.code)
  const visitSummary = await summarizeVisits(codes)
  const windowVisitSummary = await summarizeVisits(codes, { start: input.window.start, end: input.window.end })
  let totalVisits = 0
  let windowVisits = 0
  let registeredAccounts = 0
  let convertedCustomers = 0
  for (const code of codes) {
    const lifetime = visitSummary.get(code)
    const scoped = windowVisitSummary.get(code)
    totalVisits += lifetime?.visits ?? 0
    windowVisits += scoped?.visits ?? 0
    registeredAccounts += lifetime?.registeredAccounts ?? 0
    convertedCustomers += lifetime?.convertedCustomers ?? 0
  }

  return {
    customers,
    transactions,
    windowTransactions,
    truncated: Boolean(input.truncated),
    referralTotal: Number(input.referralTotal ?? input.sources.length),
    window: input.window,
    visits: {
      total: totalVisits,
      inWindow: windowVisits,
      registeredAccounts,
      convertedCustomers,
      conversionRate: totalVisits > 0 ? roundMoney((registeredAccounts / totalVisits) * 100) : 0,
      purchaseConversionRate: registeredAccounts > 0 ? roundMoney((convertedCustomers / registeredAccounts) * 100) : 0,
    },
  }
}

/**
 * Referred customers for a page of results.
 *
 * The search box covers customers *and* the things they bought, so typing an
 * order id, an invoice number or a product name finds the customer who made
 * that purchase instead of returning nothing.
 */
export function clientCustomerList(input: {
  dataset: ReferralDataset
  filters: ReferralFilters
  status: string
  search: string
}) {
  const searchMatchedCustomerIds = new Set(
    input.dataset.transactions
      .filter((row) => transactionMatchesSearch(row, input.search))
      .map((row) => row.referredCustomerId),
  )

  const filtered = input.dataset.customers
    .filter((row) => customerMatchesStatus(row, input.status))
    .filter((row) => customerMatchesSearch(row, input.search) || (Boolean(input.search) && searchMatchedCustomerIds.has(row.referredCustomerId)))
    .filter((row) => (input.filters.month ? row.latestBillingPeriod === billingPeriodLabel(input.filters.month) : true))

  const sorted = sortCustomers(filtered, input.filters.sort || "registeredAt", input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted.slice(pagination.skip, pagination.skip + pagination.take),
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function clientOrderList(input: {
  dataset: ReferralDataset
  filters: ReferralFilters
  search: string
}) {
  const filtered = input.dataset.windowTransactions
    .filter((row) => transactionMatchesSearch(row, input.search))
    .filter((row) => transactionMatchesProduct(row, input.filters.productId))
    .filter((row) => transactionMatchesStatus(row, input.filters.commissionStatus))
    .filter((row) => (input.filters.month ? row.billingPeriodKey === input.filters.month : true))
    .filter((row) => (input.filters.orderStatus ? String(row.orderStatus).toLowerCase() === input.filters.orderStatus : true))
    .filter((row) => (input.filters.paymentStatus ? String(row.paymentStatus).toLowerCase() === input.filters.paymentStatus : true))

  const sorted = sortTransactions(filtered, input.filters.sort || "earnedAt", input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted.slice(pagination.skip, pagination.skip + pagination.take),
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function clientCommissionList(input: {
  dataset: ReferralDataset
  filters: ReferralFilters
  search: string
  referrerCustomerId: string
}) {
  const rows = input.dataset.windowTransactions
    // Defence in depth: even if a dataset were ever assembled for more than one
    // referrer, a client request can only ever read its own rows.
    .filter((row) => !input.referrerCustomerId || row.referrerCustomerId === input.referrerCustomerId)
    .filter((row) => transactionMatchesSearch(row, input.search))
    .filter((row) => transactionMatchesProduct(row, input.filters.productId))
    .filter((row) => transactionMatchesStatus(row, input.filters.commissionStatus))
    .filter((row) => (input.filters.month ? row.billingPeriodKey === input.filters.month : true))

  const sorted = sortTransactions(rows, input.filters.sort || "earnedAt", input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted,
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function clientSummary(dataset: ReferralDataset) {
  const windowTotals = summarizeReferralActivity({
    customers: dataset.customers,
    transactions: dataset.windowTransactions,
  })
  const lifetimeTotals = summarizeReferralActivity({
    customers: dataset.customers,
    transactions: dataset.transactions,
  })
  return {
    window: windowTotals,
    lifetime: lifetimeTotals,
    // Headline cards are lifetime (what the referrer has earned to date); the
    // range selector scopes the tables and charts below them.
    ...lifetimeTotals,
    // The funnel is its own block: clicks, accounts and purchases are counted
    // separately so a click can never read as a customer.
    visits: visitSummaryFor(dataset),
    truncated: dataset.truncated,
  }
}

export function monthlyReport(dataset: ReferralDataset) {
  return fillMonthlySeries(groupTransactionsByMonth(dataset.windowTransactions), dataset.window)
}

export function dailyReport(dataset: ReferralDataset) {
  return groupTransactionsByDay(dataset.windowTransactions, dataset.window)
}

export function serviceReport(dataset: ReferralDataset) {
  return groupTransactionsByProduct(dataset.windowTransactions)
}

export type AdminReferrerRow = {
  referrerCustomerId: string
  name: string
  email: string
  accountStatus: string
  createdAt: string | null
  code: string | null
  totalReferrals: number
  activeReferrals: number
  inactiveReferrals: number
  registeredReferrals: number
  conversionRate: number
  /** Opens of this referrer's link. Not customers. */
  visits: number
  visitRegisteredAccounts: number
  visitConvertedCustomers: number
  visitConversionRate: number
  /** Product revenue excluding GST. */
  referralRevenue: number
  gstCollected: number
  totalCollected: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  orders: number
  commissionRatePercent: number
}

export async function adminReferrerRows(input: { dataset: ReferralDataset; filters: ReferralFilters; search: string }) {
  const accounts = await prisma.referralAccount.findMany({
    where: input.filters.referrerCustomerId ? { customerId: input.filters.referrerCustomerId } : undefined,
    select: {
      id: true,
      code: true,
      status: true,
      createdAt: true,
      customerId: true,
      customer: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_REFERRAL_SCAN_ROWS,
  })

  const accountByCustomer = new Map(accounts.map((account) => [account.customerId, account]))
  const search = input.search.toLowerCase()
  const rule = await getReferralProgramRule()

  const grouped = new Map<string, ReferralCustomerRow[]>()
  for (const customer of input.dataset.customers) {
    const list = grouped.get(customer.referrerCustomerId) || []
    list.push(customer)
    grouped.set(customer.referrerCustomerId, list)
  }

  const visitTotals = await summarizeVisits(accounts.map((account) => account.code))

  const transactionTotals = new Map<string, { revenue: number; gst: number; total: number; commission: number; pending: number; paid: number; reversed: number; orders: number }>()
  for (const transaction of input.dataset.windowTransactions) {
    const entry = transactionTotals.get(transaction.referrerCustomerId)
      || { revenue: 0, gst: 0, total: 0, commission: 0, pending: 0, paid: 0, reversed: 0, orders: 0 }
    // Revenue excludes GST, matching the commission basis and the dashboard.
    entry.revenue += transaction.eligibleBaseAmount
    entry.gst += transaction.taxAmount
    entry.total += transaction.amount
    entry.orders += 1
    const status = transaction.commission.materialised ? transaction.commission.status : "pending"
    if (status === "pending") entry.pending += transaction.commission.amount
    else if (status === "paid") entry.paid += transaction.commission.amount
    else if (status === "reversed" || status === "cancelled") entry.reversed += transaction.commission.amount
    entry.commission += transaction.commission.amount
    transactionTotals.set(transaction.referrerCustomerId, entry)
  }

  const rows: AdminReferrerRow[] = accounts.map((account) => {
    const customers = grouped.get(account.customerId) || []
    const totals = transactionTotals.get(account.customerId)
    const converted = customers.filter((row) => row.converted).length
    const name = account.customer.name || account.customer.email
    const funnel = visitTotals.get(account.code)
    return {
      visits: funnel?.visits ?? 0,
      visitRegisteredAccounts: funnel?.registeredAccounts ?? 0,
      visitConvertedCustomers: funnel?.convertedCustomers ?? 0,
      visitConversionRate: funnel && funnel.visits > 0 ? roundPercent((funnel.registeredAccounts / funnel.visits) * 100) : 0,
      referrerCustomerId: account.customerId,
      name,
      email: account.customer.email,
      accountStatus: account.status,
      createdAt: account.createdAt.toISOString(),
      code: account.code,
      totalReferrals: customers.length,
      activeReferrals: customers.filter((row) => row.status === "active").length,
      inactiveReferrals: customers.filter((row) => row.status === "inactive").length,
      registeredReferrals: customers.filter((row) => row.status === "registered").length,
      conversionRate: customers.length ? roundPercent((converted / customers.length) * 100) : 0,
      referralRevenue: round2(totals?.revenue || 0),
      gstCollected: round2(totals?.gst || 0),
      totalCollected: round2(totals?.total || 0),
      commissionEarned: round2(totals?.commission || 0),
      commissionPending: round2(totals?.pending || 0),
      commissionPaid: round2(totals?.paid || 0),
      commissionReversed: round2(totals?.reversed || 0),
      orders: totals?.orders || 0,
      commissionRatePercent: rule.commissionPercent,
    }
  })

  const filtered = search
    ? rows.filter((row) => [row.name, row.email, row.code || ""].some((value) => String(value || "").toLowerCase().includes(search)))
    : rows

  const sorted = sortReferrerRows(filtered, input.filters.sort, input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted.slice(pagination.skip, pagination.skip + pagination.take),
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function adminReferralRelations(input: { dataset: ReferralDataset; filters: ReferralFilters; search: string }) {
  let rows = input.dataset.customers
  if (input.search) rows = rows.filter((row) => customerMatchesSearch(row, input.search))
  if (input.filters.status && input.filters.status !== "all") rows = rows.filter((row) => customerMatchesStatus(row, input.filters.status))
  if (input.filters.referrerCustomerId) rows = rows.filter((row) => row.referrerCustomerId === input.filters.referrerCustomerId)
  if (input.filters.referredCustomerId) rows = rows.filter((row) => row.referredCustomerId === input.filters.referredCustomerId)
  if (input.filters.month) rows = rows.filter((row) => row.latestBillingPeriod === billingPeriodLabel(input.filters.month))

  const sorted = sortCustomers(rows, input.filters.sort || "registeredAt", input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted.slice(pagination.skip, pagination.skip + pagination.take),
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function adminOrderList(input: { dataset: ReferralDataset; filters: ReferralFilters; search: string }) {
  let rows = input.dataset.windowTransactions
  if (input.filters.referrerCustomerId) rows = rows.filter((row) => row.referrerCustomerId === input.filters.referrerCustomerId)
  if (input.filters.referredCustomerId) rows = rows.filter((row) => row.referredCustomerId === input.filters.referredCustomerId)
  if (input.search) rows = rows.filter((row) => transactionMatchesSearch(row, input.search))
  if (input.filters.productId) rows = rows.filter((row) => transactionMatchesProduct(row, input.filters.productId))
  if (input.filters.orderStatus) rows = rows.filter((row) => String(row.orderStatus).toLowerCase() === input.filters.orderStatus)
  if (input.filters.paymentStatus) rows = rows.filter((row) => String(row.paymentStatus).toLowerCase() === input.filters.paymentStatus)
  if (input.filters.month) rows = rows.filter((row) => row.billingPeriodKey === input.filters.month)

  const sorted = sortTransactions(rows, input.filters.sort || "earnedAt", input.filters.direction)
  const pagination = normalizePagination({ page: input.filters.page, pageSize: input.filters.pageSize })
  return {
    rows: sorted.slice(pagination.skip, pagination.skip + pagination.take),
    pagination: buildPaginationMeta({ ...pagination, total: sorted.length }),
    truncated: input.dataset.truncated,
  }
}

export function topReferredCustomers(dataset: ReferralDataset, limit = 10) {
  return dataset.customers
    .slice()
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, Math.max(1, Math.min(50, limit)))
}

export function topReferrers(dataset: ReferralDataset, limit = 10) {
  const byReferrer = new Map<string, {
    referralId: string
    referrerCustomerId: string
    referrerName: string
    referrerEmail: string
    referralCode: string
    orders: number
    referredCustomers: Set<string>
    revenue: number
    commissionEarned: number
  }>()

  for (const row of dataset.windowTransactions) {
    const entry = byReferrer.get(row.referrerCustomerId) || {
      referralId: row.referralId,
      referrerCustomerId: row.referrerCustomerId,
      referrerName: row.referrerName,
      referrerEmail: row.referrerEmail,
      referralCode: row.referralCode,
      orders: 0,
      referredCustomers: new Set<string>(),
      revenue: 0,
      commissionEarned: 0,
    }
    entry.orders += 1
    entry.referredCustomers.add(row.referredCustomerId)
    // Revenue excludes GST, matching every other figure in this feature.
    entry.revenue = round2(entry.revenue + row.eligibleBaseAmount)
    entry.commissionEarned = round2(entry.commissionEarned + row.commission.amount)
    byReferrer.set(row.referrerCustomerId, entry)
  }

  return Array.from(byReferrer.values())
    .map((entry) => ({
      referralId: entry.referralId,
      referrerCustomerId: entry.referrerCustomerId,
      name: entry.referrerName,
      email: entry.referrerEmail,
      code: entry.referralCode,
      orders: entry.orders,
      referredCustomers: entry.referredCustomers.size,
      revenue: entry.revenue,
      commissionEarned: entry.commissionEarned,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, Math.max(1, Math.min(50, limit)))
}

export async function referralStatusBreakdown(dataset: ReferralDataset) {
  const counts = { registered: 0, active: 0, inactive: 0, blocked: 0 }
  for (const row of dataset.customers) {
    if (row.status in counts) counts[row.status as keyof typeof counts] += 1
  }
  return counts
}

function roundPercent(value: number) {
  return Number((Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2))
}

function round2(value: number) {
  return Number((Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2))
}

function sortReferrerRows(rows: AdminReferrerRow[], sort: string, direction: "asc" | "desc"): AdminReferrerRow[] {
  const factor = direction === "asc" ? 1 : -1
  const copy = rows.slice()
  copy.sort((a, b) => {
    let delta = 0
    if (sort === "referrals") delta = a.totalReferrals - b.totalReferrals
    else if (sort === "active") delta = a.activeReferrals - b.activeReferrals
    else if (sort === "revenue") delta = a.referralRevenue - b.referralRevenue
    else if (sort === "commission") delta = a.commissionEarned - b.commissionEarned
    else delta = a.name.localeCompare(b.name)
    if (delta === 0) delta = a.name.localeCompare(b.name)
    return delta * factor
  })
  return copy
}