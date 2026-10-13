/**
 * Referral reporting.
 *
 * Everything in this module is derived from authoritative rows at query time:
 *
 *   revenue   <- Invoice (paid, type=service) joined through Order, gated by
 *                the same `activeBillableOrderWhere()` the revenue report uses
 *   commission<- ReferralCommission (materialised ledger) with a live fallback
 *                that recomputes from the current programme rate when a ledger
 *                row has not been written yet
 *   status    <- derived from the referred customer's live services, never
 *                from the referral row's stored value alone
 *
 * Every list query is paginated server side and loads related rows with a
 * bounded number of follow-up queries, so no report ever pulls the referral
 * table into the browser.
 */

import { prisma } from "@/lib/db"
import {
  buildPaginationMeta,
  normalizePagination,
  normalizeReferralSearch,
  referralDayKey,
  referralDaySeries,
  referralMonthKey,
  referralMonthSeries,
  referralWindowWhere,
  type ReferralWindow,
} from "@/lib/referrals/filters"
import {
  commissionKindForOrderType,
  loadQualifyingInvoices,
  roundMoney,
  selectFirstQualifyingPurchases,
  sumCommissionTotals,
  type QualifyingInvoiceRow,
} from "@/lib/referrals/commission"
import { getReferralProgramRule } from "@/lib/referrals/program"

export const REFERRAL_STATUS_VALUES = ["registered", "active", "inactive", "blocked"] as const
export type ReferralStatus = (typeof REFERRAL_STATUS_VALUES)[number]

const LIVE_SERVICE_STATUSES = new Set(["active", "running", "started", "live", "up", "installing", "delivered", "provisioned"])
const LIVE_DEDICATED_STATUSES = new Set(["active", "running", "started", "live", "up", "installed", "delivered"])

export function maskEmailForReferrer(email: string | null | undefined): string {
  const value = String(email || "").trim()
  if (!value) return ""
  const at = value.indexOf("@")
  if (at <= 0) return `${value.slice(0, 2)}***`
  const local = value.slice(0, at)
  const domain = value.slice(at)
  const head = local.slice(0, Math.min(2, local.length))
  return `${head}***${domain}`
}

export function deriveReferralStatus(input: {
  storedStatus?: string | null
  hasPurchase: boolean
  hasLiveService: boolean
}): ReferralStatus {
  if (String(input.storedStatus || "").toLowerCase() === "blocked") return "blocked"
  if (input.hasLiveService) return "active"
  if (input.hasPurchase) return "inactive"
  return "registered"
}

export function billingPeriodLabel(monthKey: string | null): string {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return "-"
  const [year, month] = monthKey.split("-").map(Number)
  if (!year || !month) return "-"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${months[month - 1] || "-"} ${year}`
}

function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime())
  out.setMonth(out.getMonth() + months)
  return out
}

/**
 * The billing period a transaction belongs to.
 *
 * The period is keyed on when the money was paid, not on the service's next
 * renewal date: an order bought on 14 September is September's revenue even
 * though its renewal lands in October. `start`/`end` describe the window of
 * service that purchase paid for, so "Sep 2026, renewing 14 Oct" is a complete
 * and unambiguous sentence.
 */
export function billingPeriodForTransaction(input: {
  purchaseDate: Date
  serviceRenewalDueAt?: Date | null
  serviceNextRenewalAt?: Date | null
  serviceTermMonths?: number | null
  isRenewal?: boolean
}): { key: string | null; label: string; start: Date | null; end: Date | null } {
  const term = Math.max(1, Math.trunc(Number(input.serviceTermMonths) || 1))
  const key = referralMonthKey(input.purchaseDate)
  return {
    key,
    label: billingPeriodLabel(key),
    start: input.purchaseDate,
    end: addMonths(input.purchaseDate, term),
  }
}

export type ReferralCommissionView = {
  /** Ledger row id, or null while the commission is only computed live. */
  id: string | null
  amount: number
  ratePercent: number
  status: string
  kind: string
  materialised: boolean
  holdUntil: string | null
  paidAt: string | null
  reversedAt: string | null
  reversalReason: string | null
  notes: string | null
}

export type ReferralTransactionRow = {
  referralId: string
  referralCode: string
  referrerCustomerId: string
  referrerName: string
  referrerEmail: string
  referredCustomerId: string
  referredCustomerName: string
  referredCustomerEmail: string
  serviceId: string | null
  serviceName: string | null
  productId: string | null
  productName: string | null
  orderId: string
  orderNumber: string
  orderType: string | null
  invoiceId: string
  invoiceNumber: string
  purchaseDate: string
  serviceStartDate: string | null
  serviceActivatedAt: string | null
  billingPeriod: string
  billingPeriodKey: string | null
  billingPeriodStart: string | null
  billingPeriodEnd: string | null
  renewalDate: string | null
  expiryDate: string | null
  amount: number
  taxAmount: number
  /**
   * Product amount after discount and before GST. This - not `amount` - is
   * the figure every revenue total in this feature sums, and the figure
   * commission is a percentage of.
   */
  eligibleBaseAmount: number
  currency: string
  paymentStatus: string
  orderStatus: string
  serviceStatus: string
  commission: ReferralCommissionView
}

export type ReferralCommissionLedgerRow = {
  id: string
  orderId: string
  amount: unknown
  ratePercent: unknown
  status: string
  kind: string
  holdUntil: Date | null
  paidAt: Date | null
  reversedAt: Date | null
  reversalReason: string | null
  notes: string | null
  referralId: string
  referrerCustomerId: string
  referredCustomerId: string
  productId: string | null
  serviceId: string | null
  earnedAt: Date
  createdAt: Date
}

async function loadLedgerByOrderIds(orderIds: string[]): Promise<Map<string, ReferralCommissionLedgerRow>> {
  const ids = Array.from(new Set(orderIds.filter(Boolean)))
  if (!ids.length) return new Map()
  const rows = await prisma.referralCommission.findMany({
    where: { orderId: { in: ids } },
    select: {
      id: true,
      orderId: true,
      amount: true,
      ratePercent: true,
      status: true,
      kind: true,
      holdUntil: true,
      paidAt: true,
      reversedAt: true,
      reversalReason: true,
      notes: true,
      referralId: true,
      referrerCustomerId: true,
      referredCustomerId: true,
      productId: true,
      serviceId: true,
      earnedAt: true,
      createdAt: true,
    },
  }) as unknown as ReferralCommissionLedgerRow[]
  return new Map(rows.map((row) => [row.orderId, row]))
}

function commissionViewFor(input: {
  ledger: ReferralCommissionLedgerRow | undefined
  amount: number
  rule: { commissionPercent: number; holdDays: number; isActive: boolean }
  purchaseDate: Date
  orderType: string | null | undefined
  /**
   * Whether this transaction can earn under the first-purchase policy. False
   * for renewals and for every purchase after a customer's first qualifying
   * one, so the live fallback reports 0 for them exactly as the ledger does.
   */
  eligible: boolean
}): ReferralCommissionView {
  if (input.ledger) {
    return {
      id: input.ledger.id,
      amount: roundMoney(input.ledger.amount),
      ratePercent: Number(input.ledger.ratePercent || 0),
      status: String(input.ledger.status || "pending"),
      kind: String(input.ledger.kind || commissionKindForOrderType(input.orderType)),
      materialised: true,
      holdUntil: input.ledger.holdUntil ? input.ledger.holdUntil.toISOString() : null,
      paidAt: input.ledger.paidAt ? input.ledger.paidAt.toISOString() : null,
      reversedAt: input.ledger.reversedAt ? input.ledger.reversedAt.toISOString() : null,
      reversalReason: input.ledger.reversalReason || null,
      notes: input.ledger.notes || null,
    }
  }

  const rate = input.rule.isActive ? input.rule.commissionPercent : 0
  const amount = input.eligible && rate > 0 ? roundMoney((input.amount * rate) / 100) : 0
  const holdUntil = input.eligible && input.rule.holdDays > 0
    ? new Date(input.purchaseDate.getTime() + input.rule.holdDays * 86_400_000).toISOString()
    : null
  return {
    id: null,
    amount,
    ratePercent: rate,
    // Not yet written to the ledger: it is still earning its hold window.
    status: amount > 0 ? "pending" : input.eligible ? "not_eligible" : "not_first_purchase",
    kind: commissionKindForOrderType(input.orderType),
    materialised: false,
    holdUntil,
    paidAt: null,
    reversedAt: null,
    reversalReason: null,
    notes: null,
  }
}

export function buildTransactionRows(input: {
  invoices: QualifyingInvoiceRow[]
  ledger: Map<string, ReferralCommissionLedgerRow>
  customers: Map<string, { id: string; name: string | null; email: string }>
  referrals: Map<string, { id: string; code: string; referrerCustomerId: string; referrerName: string; referrerEmail: string }>
  rule: { commissionPercent: number; holdDays: number; isActive: boolean }
  maskEmails: boolean
  /** Defaults to the first qualifying purchase per referred customer. */
  commissionableOrderIds?: Set<string>
}): ReferralTransactionRow[] {
  // Under the first-purchase policy exactly one transaction per referred
  // customer earns. Everything else still appears in the report, with its
  // revenue, but with zero commission.
  const commissionable = input.commissionableOrderIds
    || new Set(selectFirstQualifyingPurchases(input.invoices).map((row) => row.orderId))

  return input.invoices.flatMap((invoice): ReferralTransactionRow[] => {
    const referral = input.referrals.get(invoice.customerId)
    if (!referral || !invoice.orderId) return []
    const customer = input.customers.get(invoice.customerId)
    const purchaseDate = invoice.paidAt || invoice.createdAt
    const isRenewal = commissionKindForOrderType(invoice.orderType) === "renewal"
    const period = billingPeriodForTransaction({
      purchaseDate,
      serviceRenewalDueAt: isRenewal ? purchaseDate : invoice.serviceRenewalDueAt,
      serviceNextRenewalAt: invoice.serviceNextRenewalAt,
      serviceTermMonths: invoice.serviceBillingTermMonths,
      isRenewal,
    })
    const renewalDate = invoice.serviceNextRenewalAt || invoice.serviceRenewalDueAt || period.end

    return [{
      referralId: referral.id,
      referralCode: referral.code,
      referrerCustomerId: referral.referrerCustomerId,
      referrerName: referral.referrerName,
      referrerEmail: referral.referrerEmail,
      referredCustomerId: invoice.customerId,
      referredCustomerName: customer?.name || "Referred customer",
      referredCustomerEmail: input.maskEmails ? maskEmailForReferrer(customer?.email) : String(customer?.email || ""),
      serviceId: invoice.serviceId,
      serviceName: invoice.serviceName,
      productId: invoice.productId,
      productName: invoice.productName || "Custom / addon",
      orderId: invoice.orderId,
      orderNumber: invoice.orderNumber || invoice.orderId,
      orderType: invoice.orderType,
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      purchaseDate: purchaseDate.toISOString(),
      serviceStartDate: (invoice.serviceActivatedAt || purchaseDate).toISOString(),
      serviceActivatedAt: invoice.serviceActivatedAt ? invoice.serviceActivatedAt.toISOString() : null,
      billingPeriod: period.label,
      billingPeriodKey: period.key,
      billingPeriodStart: period.start ? period.start.toISOString() : null,
      billingPeriodEnd: period.end ? period.end.toISOString() : null,
      renewalDate: renewalDate ? new Date(renewalDate).toISOString() : null,
      expiryDate: renewalDate ? new Date(renewalDate).toISOString() : null,
      amount: roundMoney(invoice.amount),
      taxAmount: roundMoney(invoice.taxAmount),
      eligibleBaseAmount: roundMoney(invoice.eligibleBaseAmount),
      currency: invoice.currency || "INR",
      paymentStatus: "paid",
      orderStatus: String(invoice.orderStatus || ""),
      serviceStatus: String(invoice.serviceStatus || "not_provisioned"),
      commission: commissionViewFor({
        ledger: input.ledger.get(invoice.orderId),
        // The live fallback must use the same base as the ledger, otherwise a
        // report before and after a sync would disagree.
        amount: roundMoney(invoice.eligibleBaseAmount),
        rule: input.rule,
        purchaseDate,
        orderType: invoice.orderType,
        eligible: commissionable.has(invoice.orderId),
      }),
    }]
  })
}

export type ReferralServiceState = {
  totalServices: number
  activeServices: number
  serviceNames: string[]
  productNames: string[]
  lastServiceStatus: string | null
}

export async function loadServiceStates(customerIds: string[]): Promise<Map<string, ReferralServiceState>> {
  const ids = Array.from(new Set(customerIds.filter(Boolean)))
  const out = new Map<string, ReferralServiceState>()
  if (!ids.length) return out

  const [vms, dedicated] = await Promise.all([
    prisma.vpsInstance.findMany({
      where: { customerId: { in: ids }, deletedAt: null },
      select: {
        customerId: true,
        name: true,
        hostname: true,
        status: true,
        product: { select: { name: true } },
        order: { select: { product: { select: { name: true } } } },
      },
    }),
    prisma.dedicatedService.findMany({
      where: { customerId: { in: ids } },
      select: {
        customerId: true,
        hostname: true,
        serviceNumber: true,
        status: true,
        product: { select: { name: true } },
      },
    }),
  ])

  for (const id of ids) out.set(id, { totalServices: 0, activeServices: 0, serviceNames: [], productNames: [], lastServiceStatus: null })

  for (const vm of vms) {
    const entry = out.get(vm.customerId)
    if (!entry) continue
    entry.totalServices += 1
    if (LIVE_SERVICE_STATUSES.has(String(vm.status || "").toLowerCase())) entry.activeServices += 1
    const label = vm.name || vm.hostname
    if (label) entry.serviceNames.push(label)
    const product = vm.product?.name || vm.order?.product?.name
    if (product) entry.productNames.push(product)
    entry.lastServiceStatus = entry.lastServiceStatus || String(vm.status || "")
  }

  for (const service of dedicated) {
    const entry = out.get(service.customerId)
    if (!entry) continue
    entry.totalServices += 1
    if (LIVE_DEDICATED_STATUSES.has(String(service.status || "").toLowerCase())) entry.activeServices += 1
    const label = service.hostname || service.serviceNumber
    if (label) entry.serviceNames.push(label)
    const product = service.product?.name
    if (product) entry.productNames.push(product)
    entry.lastServiceStatus = entry.lastServiceStatus || String(service.status || "")
  }

  for (const entry of out.values()) {
    entry.serviceNames = Array.from(new Set(entry.serviceNames)).slice(0, 20)
    entry.productNames = Array.from(new Set(entry.productNames)).slice(0, 20)
  }

  return out
}

export type ReferralCustomerRow = {
  referralId: string
  referralCode: string
  referrerCustomerId: string
  referrerName: string
  referrerEmail: string
  referredCustomerId: string
  name: string
  email: string
  registeredAt: string
  status: ReferralStatus
  converted: boolean
  firstPurchaseAt: string | null
  latestPurchaseAt: string | null
  orderCount: number
  totalSpent: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  services: ReferralServiceState
  latestServiceStatus: string | null
  latestBillingPeriod: string | null
}

export type ReferralCustomerSource = {
  id: string
  code: string
  status: string
  registeredAt: Date
  referrerCustomerId: string
  referrer: { id: string; name: string | null; email: string }
  referredCustomer: { id: string; name: string | null; email: string; status: string }
}

export async function buildCustomerRows(input: {
  referrals: ReferralCustomerSource[]
  maskEmails: boolean
  lifetimeWindow?: ReferralWindow | null
}): Promise<{ rows: ReferralCustomerRow[]; transactions: ReferralTransactionRow[] }> {
  const customerIds = input.referrals.map((row) => row.referredCustomer.id)
  if (!customerIds.length) return { rows: [], transactions: [] }

  const [rule, serviceStates] = await Promise.all([
    getReferralProgramRule(),
    loadServiceStates(customerIds),
  ])
  const [invoices, customers] = await Promise.all([
    loadQualifyingInvoices({ customerIds, start: null, end: null }),
    prisma.customer.findMany({
      where: { id: { in: Array.from(new Set([...customerIds, ...input.referrals.map((row) => row.referrerCustomerId)])) } },
      select: { id: true, name: true, email: true, status: true },
    }),
  ])

  const ledger = await loadLedgerByOrderIds(invoices.map((row) => row.orderId || ""))
  const transactions = buildTransactionRows({
    invoices,
    ledger,
    customers: new Map(customers.map((row) => [row.id, { id: row.id, name: row.name, email: row.email }])),
    referrals: new Map(input.referrals.map((row) => [row.referredCustomer.id, {
      id: row.id,
      code: row.code,
      referrerCustomerId: row.referrerCustomerId,
      referrerName: row.referrer?.name || "Referrer",
      referrerEmail: String(row.referrer?.email || ""),
    }])),
    rule,
    maskEmails: input.maskEmails,
  })

  const byCustomer = new Map<string, ReferralTransactionRow[]>()
  for (const transaction of transactions) {
    const list = byCustomer.get(transaction.referredCustomerId) || []
    list.push(transaction)
    byCustomer.set(transaction.referredCustomerId, list)
  }

  const rows: ReferralCustomerRow[] = input.referrals.map((referral) => {
    const list = (byCustomer.get(referral.referredCustomer.id) || []).slice()
    list.sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime())
    const services = serviceStates.get(referral.referredCustomer.id) || {
      totalServices: 0, activeServices: 0, serviceNames: [], productNames: [], lastServiceStatus: null,
    }
    const totals = sumCommissionTotals(list.map((row) => ({ amount: row.commission.amount, status: row.commission.materialised ? row.commission.status : "pending" })))
    const status = deriveReferralStatus({
      storedStatus: referral.status,
      hasPurchase: list.length > 0,
      hasLiveService: services.activeServices > 0,
    })
    const inWindow = input.lifetimeWindow?.start || input.lifetimeWindow?.end
      ? list.filter((row) => transactionInWindow(row, input.lifetimeWindow as ReferralWindow))
      : list

    const referrer = customers.find((row) => row.id === referral.referrerCustomerId)

    return {
      referralId: referral.id,
      referralCode: referral.code,
      referrerCustomerId: referral.referrerCustomerId,
      referrerName: referrer?.name || referral.referrer?.name || "Referrer",
      referrerEmail: input.maskEmails ? maskEmailForReferrer(referrer?.email || referral.referrer?.email) : String(referrer?.email || referral.referrer?.email || ""),
      referredCustomerId: referral.referredCustomer.id,
      name: referral.referredCustomer.name || "Referred customer",
      email: input.maskEmails ? maskEmailForReferrer(referral.referredCustomer.email) : referral.referredCustomer.email,
      registeredAt: referral.registeredAt.toISOString(),
      status,
      converted: list.length > 0,
      firstPurchaseAt: list.length ? list[list.length - 1].purchaseDate : null,
      latestPurchaseAt: list.length ? list[0].purchaseDate : null,
      orderCount: inWindow.length,
      totalSpent: roundMoney(inWindow.reduce((sum, row) => sum + row.eligibleBaseAmount, 0)),
      totalPaid: roundMoney(inWindow.reduce((sum, row) => sum + row.amount, 0)),
      gstCollected: roundMoney(inWindow.reduce((sum, row) => sum + row.taxAmount, 0)),
      commissionEarned: totals.earned,
      commissionPending: totals.pending,
      commissionPaid: totals.paid,
      commissionReversed: totals.reversed,
      services,
      latestServiceStatus: services.lastServiceStatus,
      latestBillingPeriod: list.length ? billingPeriodLabel(referralMonthKey(new Date(list[0].purchaseDate))) : null,
    }
  })

  return { rows, transactions }
}

export function customerMatchesStatus(row: ReferralCustomerRow, status: string): boolean {
  const normalized = String(status || "all").toLowerCase()
  if (!normalized || normalized === "all") return true
  return row.status === normalized
}

export function customerMatchesSearch(row: ReferralCustomerRow, search: string): boolean {
  const needle = normalizeReferralSearch(search)
  if (!needle) return true
  const lowered = needle.toLowerCase()
  return [row.name, row.email, row.referralCode, row.referredCustomerId]
    .some((value) => String(value || "").toLowerCase().includes(lowered))
}

export function transactionMatchesSearch(row: ReferralTransactionRow, search: string): boolean {
  const needle = normalizeReferralSearch(search)
  if (!needle) return true
  const lowered = needle.toLowerCase()
  return [row.orderNumber, row.orderId, row.invoiceNumber, row.productName, row.serviceName, row.referredCustomerName, row.referredCustomerEmail]
    .some((value) => String(value || "").toLowerCase().includes(lowered))
}

export function transactionMatchesProduct(row: ReferralTransactionRow, productId: string): boolean {
  const value = String(productId || "").trim()
  if (!value || value === "all") return true
  return row.productId === value
}

export function transactionMatchesStatus(row: ReferralTransactionRow, status: string): boolean {
  const value = String(status || "all").toLowerCase()
  if (!value || value === "all") return true
  return row.commission.status === value
}

export function transactionInWindow(row: ReferralTransactionRow, window: ReferralWindow): boolean {
  const at = new Date(row.purchaseDate).getTime()
  if (window.start && at < window.start.getTime()) return false
  if (window.end && at > window.end.getTime()) return false
  return true
}

export function sortTransactions(rows: ReferralTransactionRow[], sort: string, direction: "asc" | "desc"): ReferralTransactionRow[] {
  const factor = direction === "asc" ? 1 : -1
  const copy = rows.slice()
  copy.sort((a, b) => {
    let delta = 0
    if (sort === "amount") delta = a.amount - b.amount
    else if (sort === "commission") delta = a.commission.amount - b.commission.amount
    else if (sort === "name") delta = a.referredCustomerName.localeCompare(b.referredCustomerName)
    else delta = new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime()
    if (delta === 0) delta = a.orderId.localeCompare(b.orderId)
    return delta * factor
  })
  return copy
}

export function sortCustomers(rows: ReferralCustomerRow[], sort: string, direction: "asc" | "desc"): ReferralCustomerRow[] {
  const factor = direction === "asc" ? 1 : -1
  const copy = rows.slice()
  copy.sort((a, b) => {
    let delta = 0
    if (sort === "totalSpent") delta = a.totalSpent - b.totalSpent
    else if (sort === "orders") delta = a.orderCount - b.orderCount
    else if (sort === "commission") delta = a.commissionEarned - b.commissionEarned
    else if (sort === "name") delta = a.name.localeCompare(b.name)
    else delta = new Date(a.registeredAt).getTime() - new Date(b.registeredAt).getTime()
    if (delta === 0) delta = a.referredCustomerId.localeCompare(b.referredCustomerId)
    return delta * factor
  })
  return copy
}

export type ReferralTotals = {
  totalReferrals: number
  activeReferrals: number
  inactiveReferrals: number
  registeredReferrals: number
  blockedReferrals: number
  conversionRate: number
  referredOrders: number
  /** Product revenue excluding GST. This is the figure commission tracks. */
  referralRevenue: number
  /** GST charged on those orders, reported separately and never in revenue. */
  gstCollected: number
  /** What the referred customers actually paid, revenue plus GST. */
  totalCollected: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  totalServices: number
  activeServices: number
}

export function summarizeReferralActivity(input: {
  customers: ReferralCustomerRow[]
  transactions: ReferralTransactionRow[]
}): ReferralTotals {
  const customers = input.customers
  const transactions = input.transactions
  const totals = sumCommissionTotals(transactions.map((row) => ({
    amount: row.commission.amount,
    status: row.commission.materialised ? row.commission.status : "pending",
  })))
  const activeReferrals = customers.filter((row) => row.status === "active").length
  const converted = customers.filter((row) => row.converted).length

  return {
    totalReferrals: customers.length,
    activeReferrals,
    inactiveReferrals: customers.filter((row) => row.status === "inactive").length,
    registeredReferrals: customers.filter((row) => row.status === "registered").length,
    blockedReferrals: customers.filter((row) => row.status === "blocked").length,
    conversionRate: customers.length ? roundMoney((converted / customers.length) * 100) : 0,
    referredOrders: transactions.length,
    referralRevenue: roundMoney(transactions.reduce((sum, row) => sum + row.eligibleBaseAmount, 0)),
    gstCollected: roundMoney(transactions.reduce((sum, row) => sum + row.taxAmount, 0)),
    totalCollected: roundMoney(transactions.reduce((sum, row) => sum + row.amount, 0)),
    commissionEarned: totals.earned,
    commissionPending: totals.pending,
    commissionPaid: totals.paid,
    commissionReversed: totals.reversed,
    totalServices: customers.reduce((sum, row) => sum + row.services.totalServices, 0),
    activeServices: customers.reduce((sum, row) => sum + row.services.activeServices, 0),
  }
}

export function groupTransactionsByMonth(rows: ReferralTransactionRow[]): Array<{
  month: string
  label: string
  orders: number
  revenue: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  newReferrals: number
}> {
  const buckets = new Map<string, ReferralTransactionRow[]>()
  for (const row of rows) {
    const key = referralMonthKey(row.purchaseDate) || "unknown"
    const list = buckets.get(key) || []
    list.push(row)
    buckets.set(key, list)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, list]) => {
      const totals = sumCommissionTotals(list.map((row) => ({
        amount: row.commission.amount,
        status: row.commission.materialised ? row.commission.status : "pending",
      })))
      return {
        month,
        label: billingPeriodLabel(month),
        orders: list.length,
        revenue: roundMoney(list.reduce((sum, row) => sum + row.eligibleBaseAmount, 0)),
      gstCollected: roundMoney(list.reduce((sum, row) => sum + row.taxAmount, 0)),
        commissionEarned: totals.earned,
        commissionPending: totals.pending,
        commissionPaid: totals.paid,
        commissionReversed: totals.reversed,
        newReferrals: 0,
      }
    })
}

export function fillMonthlySeries(rows: Array<{ month: string; label: string; orders: number; revenue: number; commissionEarned: number; commissionPending: number; commissionPaid: number; commissionReversed: number; newReferrals: number }>, window: ReferralWindow) {
  if (!window.start || !window.end) return rows
  const first = referralMonthKey(window.start)
  const last = referralMonthKey(window.end)
  if (!first || !last) return rows
  const keys = referralMonthSeries(first, last)
  if (keys.length <= 1) return rows
  const byKey = new Map(rows.map((row) => [row.month, row]))
  return keys.map((key) => byKey.get(key) || {
    month: key,
    label: billingPeriodLabel(key),
    orders: 0,
    revenue: 0,
    commissionEarned: 0,
    commissionPending: 0,
    commissionPaid: 0,
    commissionReversed: 0,
    newReferrals: 0,
  })
}

export function groupTransactionsByDay(rows: ReferralTransactionRow[], window: ReferralWindow) {
  const buckets = new Map<string, ReferralTransactionRow[]>()
  for (const row of rows) {
    const key = referralDayKey(row.purchaseDate) || "unknown"
    const list = buckets.get(key) || []
    list.push(row)
    buckets.set(key, list)
  }
  const entries = Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => {
    const totals = sumCommissionTotals(list.map((row) => ({
      amount: row.commission.amount,
      status: row.commission.materialised ? row.commission.status : "pending",
    })))
    return {
      day,
      orders: list.length,
      revenue: roundMoney(list.reduce((sum, row) => sum + row.eligibleBaseAmount, 0)),
      gstCollected: roundMoney(list.reduce((sum, row) => sum + row.taxAmount, 0)),
      commissionEarned: totals.earned,
    }
  })
  if (!window.start || !window.end) return entries
  const keys = referralDaySeries(window.start, window.end)
  if (!keys.length) return entries
  const byKey = new Map(entries.map((row) => [row.day, row]))
  return keys.map((key) => byKey.get(key) || { day: key, orders: 0, revenue: 0, commissionEarned: 0 })
}

export function groupTransactionsByProduct(rows: ReferralTransactionRow[]) {
  const buckets = new Map<string, { productId: string; productName: string; orders: number; revenue: number; commissionEarned: number; customers: Set<string> }>()
  for (const row of rows) {
    const key = row.productId || "uncategorised"
    const entry = buckets.get(key) || {
      productId: row.productId || "uncategorised",
      productName: row.productName || "Custom / addon",
      orders: 0,
      revenue: 0,
      commissionEarned: 0,
      customers: new Set<string>(),
    }
    entry.orders += 1
    entry.revenue = roundMoney(entry.revenue + row.eligibleBaseAmount)
    entry.commissionEarned = roundMoney(entry.commissionEarned + row.commission.amount)
    entry.customers.add(row.referredCustomerId)
    buckets.set(key, entry)
  }
  return Array.from(buckets.values())
    .map((entry) => ({
      productId: entry.productId,
      productName: entry.productName,
      orders: entry.orders,
      customers: entry.customers.size,
      revenue: entry.revenue,
      commissionEarned: entry.commissionEarned,
    }))
    .sort((a, b) => b.revenue - a.revenue)
}

export { buildPaginationMeta, normalizePagination }