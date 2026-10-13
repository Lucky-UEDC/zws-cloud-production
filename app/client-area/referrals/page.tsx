"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Copy, Gift, RefreshCw, Search, TrendingUp, Users } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatsSkeleton, TableSkeleton } from "@/components/ui/page-skeletons"
import { readJsonResponse } from "@/lib/client/safe-json"
import { formatCurrency } from "@/lib/currency-format"

const RANGES = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "custom", label: "Custom" },
]

const STATUSES = [
  { key: "all", label: "All statuses" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "registered", label: "Registered" },
  { key: "blocked", label: "Blocked" },
]

const PAGE_SIZES = [10, 20, 50]

type VisitFunnel = {
  total: number
  inWindow: number
  registeredAccounts: number
  convertedCustomers: number
  conversionRate: number
  purchaseConversionRate: number
}

type Summary = {
  totalReferrals: number
  activeReferrals: number
  inactiveReferrals: number
  registeredReferrals: number
  conversionRate: number
  referredOrders: number
  /** Product revenue excluding GST. */
  referralRevenue: number
  gstCollected: number
  totalCollected: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  visits: VisitFunnel
  window: {
    totalReferrals: number
    referredOrders: number
    referralRevenue: number
    gstCollected: number
    commissionEarned: number
    commissionPending: number
    commissionPaid: number
  }
}

type CustomerRow = {
  referralId: string
  referredCustomerId: string
  name: string
  email: string
  registeredAt: string
  status: string
  converted: boolean
  firstPurchaseAt: string | null
  latestPurchaseAt: string | null
  orderCount: number
  /** Product spend excluding GST. */
  totalSpent: number
  /** What the customer actually paid, GST included. */
  totalPaid: number
  gstCollected: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  services: { totalServices: number; activeServices: number; serviceNames: string[]; productNames: string[]; lastServiceStatus: string | null }
  latestBillingPeriod: string | null
}

type OrderRow = {
  orderId: string
  orderNumber: string
  orderType: string | null
  invoiceNumber: string
  referredCustomerName: string
  referredCustomerEmail: string
  serviceName: string | null
  productName: string
  purchaseDate: string
  serviceStartDate: string
  billingPeriod: string
  renewalDate: string | null
  amount: number
  taxAmount: number
  eligibleBaseAmount: number
  paymentStatus: string
  orderStatus: string
  serviceStatus: string
  commission: { amount: number; status: string; kind: string; ratePercent: number; materialised: boolean; holdUntil: string | null; paidAt: string | null }
}

type Pagination = { page: number; pageSize: number; total: number; pages: number }

type ReportResponse = {
  monthly?: Array<{ month: string; label: string; orders: number; revenue: number; commissionEarned: number; commissionPending: number; commissionPaid: number; commissionReversed: number }>
  daily?: Array<{ day: string; orders: number; revenue: number; commissionEarned: number }>
  services?: Array<{ productId: string; productName: string; orders: number; customers: number; revenue: number; commissionEarned: number }>
}

type Filters = {
  range: string
  start: string
  end: string
  status: string
  commissionStatus: string
  productId: string
  search: string
  month: string
  sort: string
  direction: "asc" | "desc"
}

const DEFAULT_FILTERS: Filters = {
  range: "all",
  start: "",
  end: "",
  status: "all",
  commissionStatus: "all",
  productId: "",
  search: "",
  month: "",
  sort: "",
  direction: "desc",
}

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString("en-IN", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
}

function formatPercent(value?: number | null) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) return "0%"
  return `${number.toFixed(1).replace(/\.0$/, "")}%`
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const value = String(status || "").toLowerCase()
  if (value === "active" || value === "paid") return "default"
  if (value === "blocked" || value === "reversed") return "destructive"
  if (value === "registered" || value === "pending") return "secondary"
  return "outline"
}

export default function ClientReferralsPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [searchDraft, setSearchDraft] = useState("")
  const [summary, setSummary] = useState<Summary | null>(null)
  const visits = summary?.visits
  const [account, setAccount] = useState<{ code: string; status: string } | null>(null)
  const [referralLink, setReferralLink] = useState("")
  const [program, setProgram] = useState<{ commissionPercent: number; holdDays: number; minimumOrderAmount: number; isActive: boolean } | null>(null)
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [customerPage, setCustomerPage] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, pages: 1 })
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [orderPage, setOrderPage] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, pages: 1 })
  const [monthly, setMonthly] = useState<NonNullable<ReportResponse["monthly"]>>([])
  const [daily, setDaily] = useState<NonNullable<ReportResponse["daily"]>>([])
  const [services, setServices] = useState<NonNullable<ReportResponse["services"]>>([])
  const [customerPageIndex, setCustomerPageIndex] = useState(1)
  const [orderPageIndex, setOrderPageIndex] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("range", filters.range)
    if (filters.range === "custom") {
      if (filters.start) params.set("start", filters.start)
      if (filters.end) params.set("end", filters.end)
    }
    if (filters.status && filters.status !== "all") params.set("status", filters.status)
    if (filters.commissionStatus && filters.commissionStatus !== "all") params.set("commissionStatus", filters.commissionStatus)
    if (filters.productId) params.set("productId", filters.productId)
    if (filters.search) params.set("search", filters.search)
    if (filters.month) params.set("month", filters.month)
    if (filters.sort) params.set("sort", filters.sort)
    params.set("direction", filters.direction)
    return params
  }, [filters])

  const load = useCallback(async function load(silent = false) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const summaryParams = new URLSearchParams(queryString)
      const customerParams = new URLSearchParams(queryString)
      customerParams.set("page", String(customerPageIndex))
      customerParams.set("pageSize", String(customerPage.pageSize))
      const orderParams = new URLSearchParams(queryString)
      orderParams.set("page", String(orderPageIndex))
      orderParams.set("pageSize", String(orderPage.pageSize))
      const monthlyParams = new URLSearchParams(queryString)
      const dailyParams = new URLSearchParams(queryString)
      const serviceParams = new URLSearchParams(queryString)

      const [summaryRes, customerRes, orderRes, monthlyRes, dailyRes, serviceRes] = await Promise.all([
        fetch(`/api/client/referrals/summary?${summaryParams}`, { cache: "no-store" }),
        fetch(`/api/client/referrals/customers?${customerParams}`, { cache: "no-store" }),
        fetch(`/api/client/referrals/orders?${orderParams}`, { cache: "no-store" }),
        fetch(`/api/client/referrals/reports?${monthlyParams}&group=month`, { cache: "no-store" }),
        fetch(`/api/client/referrals/reports?${dailyParams}&group=day`, { cache: "no-store" }),
        fetch(`/api/client/referrals/reports?${serviceParams}&group=service`, { cache: "no-store" }),
      ])

      const [summaryJson, customerJson, orderJson, monthlyJson, dailyJson, serviceJson] = await Promise.all([
        readJsonResponse<any>(summaryRes),
        readJsonResponse<any>(customerRes),
        readJsonResponse<any>(orderRes),
        readJsonResponse<any>(monthlyRes),
        readJsonResponse<any>(dailyRes),
        readJsonResponse<any>(serviceRes),
      ])

      if (!summaryRes.ok) throw new Error(summaryJson?.error || "Unable to load referral summary")
      if (!customerRes.ok) throw new Error(customerJson?.error || "Unable to load referred customers")
      if (!orderRes.ok) throw new Error(orderJson?.error || "Unable to load referred orders")

      setSummary(summaryJson.summary || null)
      setAccount(summaryJson.account || null)
      setReferralLink(String(summaryJson.referralLink || ""))
      setProgram(summaryJson.program || null)
      setCustomers(Array.isArray(customerJson.customers) ? customerJson.customers : [])
      setCustomerPage(customerJson.pagination || { page: 1, pageSize: 20, total: 0, pages: 1 })
      setOrders(Array.isArray(orderJson.orders) ? orderJson.orders : [])
      setOrderPage(orderJson.pagination || { page: 1, pageSize: 20, total: 0, pages: 1 })
      setMonthly(monthlyRes.ok ? monthlyJson?.monthly || [] : [])
      setDaily(dailyRes.ok ? dailyJson?.daily || [] : [])
      setServices(serviceRes.ok ? serviceJson?.services || [] : [])
    } catch (err: any) {
      setError(err?.message || "Something could not load. Please retry.")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [queryString, customerPageIndex, customerPage.pageSize, orderPageIndex, orderPage.pageSize])

  useEffect(() => {
    void load()
  }, [load])

  function updateFilters(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setCustomerPageIndex(1)
    setOrderPageIndex(1)
  }

  function applySearch() {
    updateFilters({ search: searchDraft.trim() })
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS)
    setSearchDraft("")
    setCustomerPageIndex(1)
    setOrderPageIndex(1)
  }

  function copy(value: string, label: string) {
    if (!value) return
    navigator.clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Could not copy to clipboard"),
    )
  }

  if (loading && !summary) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Referrals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track who you referred, what they bought, and the commission you earned.</p>
        </div>
        <StatsSkeleton />
        <TableSkeleton rows={6} columns={6} />
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Referrals</h1>
        <Card className="border-red-400/20 bg-red-400/5">
          <CardContent className="flex flex-col items-start gap-3 p-5">
            <p className="font-medium">{error}</p>
            <Button variant="outline" onClick={() => void load()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Referrals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everyone who signed up with your code, the services they took, and the commission earned from each purchase.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load(true)}>
          <RefreshCw className="mr-2 h-4 w-4" />Refresh
        </Button>
      </div>

      {account ? (
        <Card className="glass border-border/40">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Your referral code</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xl font-semibold tracking-widest">{account.code}</span>
                <Badge variant={statusVariant(account.status)}>{account.status}</Badge>
              </div>
              {program?.isActive ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {program.commissionPercent}% commission{program.holdDays ? `, payable after a ${program.holdDays}-day hold` : ", payable immediately"}.
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">The referral programme is currently paused for commission payouts.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => copy(account.code, "Referral code")}>
                <Copy className="mr-2 h-4 w-4" />Copy code
              </Button>
              <Button size="sm" onClick={() => copy(referralLink, "Referral link")}>
                <Gift className="mr-2 h-4 w-4" />Copy invite link
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard label="Referral Visits" value={String(visits?.total ?? 0)} hint="Opens of your link" />
        <MetricCard label="Registered Accounts" value={String(visits?.registeredAccounts ?? 0)} hint={`${formatPercent(visits?.conversionRate)} of visits`} />
        <MetricCard label="Customers Who Purchased a VPS" value={String(visits?.convertedCustomers ?? 0)} hint={`${formatPercent(visits?.purchaseConversionRate)} of registrations`} />
        <MetricCard label="Referral Revenue (excl. GST)" value={formatCurrency(summary?.referralRevenue ?? 0)} hint={formatCurrency(summary?.gstCollected ?? 0).replace(/^/, "GST ")} />
        <MetricCard label="Commission Earned" value={formatCurrency(summary?.commissionEarned ?? 0)} hint={`${formatCurrency(summary?.commissionPending ?? 0)} pending`} />
        <MetricCard label="Commission Paid" value={formatCurrency(summary?.commissionPaid ?? 0)} hint={`${formatCurrency(summary?.commissionReversed ?? 0)} reversed`} />
      </div>

      <Card className="border-border/40 bg-muted/20">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Commission is {program?.commissionPercent ?? 0}% of the referred customer&apos;s first VPS purchase,
          calculated on the product price <strong className="text-foreground">before GST</strong>, and is paid once
          per referred customer. Opening your link and signing up both earn nothing; renewals and later purchases
          earn nothing. GST of {formatCurrency(summary?.gstCollected ?? 0)} was charged to your referred customers
          and is excluded from every revenue figure above.
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <Select value={filters.range} onValueChange={(value) => updateFilters({ range: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Date range" /></SelectTrigger>
            <SelectContent>
              {RANGES.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {filters.range === "custom" ? (
            <>
              <Input type="date" value={filters.start} onChange={(event) => updateFilters({ start: event.target.value })} aria-label="Start date" />
              <Input type="date" value={filters.end} onChange={(event) => updateFilters({ end: event.target.value })} aria-label="End date" />
            </>
          ) : null}
          <Select value={filters.status} onValueChange={(value) => updateFilters({ status: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Referral status" /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.commissionStatus} onValueChange={(value) => updateFilters({ commissionStatus: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Commission" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All commission</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="reversed">Reversed</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applySearch() }}
              placeholder="Customer, order ID, service"
              aria-label="Search referrals"
            />
            <Button type="button" variant="outline" onClick={applySearch} aria-label="Search">
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="customers" className="space-y-4">
        <TabsList>
          <TabsTrigger value="customers"><Users className="mr-1 h-4 w-4" />Referral Customers</TabsTrigger>
          <TabsTrigger value="orders"><TrendingUp className="mr-1 h-4 w-4" />Services &amp; Orders</TabsTrigger>
          <TabsTrigger value="reports">Monthly Report</TabsTrigger>
        </TabsList>

        <TabsContent value="customers">
          <Card className="border-border/40 bg-card">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Referral Customers</CardTitle>
                <CardDescription>Who you referred, when they joined, and what they have bought.</CardDescription>
              </div>
              <PageSizeSelect
                value={customerPage.pageSize}
                onChange={(value) => { setCustomerPage((p) => ({ ...p, pageSize: value })); setCustomerPageIndex(1) }}
              />
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {customers.length === 0 ? (
                <EmptyState message="No referred customers match these filters yet." />
              ) : (
                <>
                  <div className="hidden sm:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Customer</TableHead>
                          <TableHead>Registered</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Services</TableHead>
                          <TableHead>Orders</TableHead>
                          <TableHead>Amount Spent</TableHead>
                          <TableHead>Commission</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {customers.map((row) => (
                          <TableRow key={row.referralId}>
                            <TableCell className="whitespace-normal">
                              <div className="font-medium">{row.name}</div>
                              <div className="text-xs text-muted-foreground">{row.email}</div>
                            </TableCell>
                            <TableCell>{formatDate(row.registeredAt)}</TableCell>
                            <TableCell><Badge variant={statusVariant(row.status)}>{row.status}</Badge></TableCell>
                            <TableCell className="whitespace-normal">
                              <div className="text-sm">{row.services.activeServices} active / {row.services.totalServices} total</div>
                              {row.services.productNames.length ? (
                                <div className="text-xs text-muted-foreground">{row.services.productNames.slice(0, 3).join(", ")}</div>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">{row.orderCount}</div>
                              {row.latestBillingPeriod ? <div className="text-xs text-muted-foreground">{row.latestBillingPeriod}</div> : null}
                            </TableCell>
                            <TableCell>{formatCurrency(row.totalSpent)}</TableCell>
                            <TableCell className="whitespace-normal">
                              <div className="text-sm">{formatCurrency(row.commissionEarned)}</div>
                              <div className="text-xs text-muted-foreground">
                                {formatCurrency(row.commissionPending)} pending · {formatCurrency(row.commissionPaid)} paid
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <MobileCustomerList rows={customers} />
                </>
              )}
            </CardContent>
            <PaginationBar
              pagination={customerPage}
              onChange={setCustomerPageIndex}
              disabled={loading}
            />
          </Card>
        </TabsContent>

        <TabsContent value="orders">
          <Card className="border-border/40 bg-card">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Services &amp; Orders</CardTitle>
                <CardDescription>
                  One row per purchase: which customer, which service, which order, which date, which billing month.
                </CardDescription>
              </div>
              <PageSizeSelect
                value={orderPage.pageSize}
                onChange={(value) => { setOrderPage((p) => ({ ...p, pageSize: value })); setOrderPageIndex(1) }}
              />
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {orders.length === 0 ? (
                <EmptyState message="No referred purchases match these filters yet." />
              ) : (
                <>
                  <div className="hidden sm:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead>Order</TableHead>
                        <TableHead>Purchase Date</TableHead>
                        <TableHead>Billing Period</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Commission</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((row) => (
                        <TableRow key={row.orderId}>
                          <TableCell className="whitespace-normal">
                            <div className="font-medium">{row.referredCustomerName}</div>
                            <div className="text-xs text-muted-foreground">{row.referredCustomerEmail}</div>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="text-sm">{row.productName}</div>
                            {row.serviceName ? <div className="text-xs text-muted-foreground">{row.serviceName}</div> : null}
                            {row.orderType === "renewal" ? <Badge variant="outline" className="mt-1">Renewal</Badge> : null}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.orderNumber}</TableCell>
                          <TableCell>
                            <div className="text-sm">{formatDate(row.purchaseDate)}</div>
                            <div className="text-xs text-muted-foreground">Renews {formatDate(row.renewalDate)}</div>
                          </TableCell>
                          <TableCell>{row.billingPeriod}</TableCell>
                          <TableCell>{formatCurrency(row.amount)}</TableCell>
                          <TableCell className="whitespace-normal">
                            <Badge variant={statusVariant(row.paymentStatus)}>{row.paymentStatus}</Badge>
                            <div className="mt-1 text-xs text-muted-foreground">{row.serviceStatus}</div>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="text-sm">{formatCurrency(row.commission.amount)}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.commission.status}{row.commission.materialised ? "" : " (calculated)"}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <MobileOrderList rows={orders} />
                </>
              )}
            </CardContent>
            <PaginationBar pagination={orderPage} onChange={setOrderPageIndex} disabled={loading} />
          </Card>
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          <Card className="border-border/40 bg-card">
            <CardHeader>
              <CardTitle>Monthly Referral Performance</CardTitle>
              <CardDescription>Grouped by the month each transaction was paid for, not the signup month.</CardDescription>
            </CardHeader>
            <CardContent>
              {monthly.length === 0 ? (
                <EmptyState message="No referral activity in this period." />
              ) : (
                <>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={monthly}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(value: any, name: any) => [formatCurrency(Number(value)), String(name)]} />
                        <Bar dataKey="revenue" name="Revenue" fill="#22c55e" isAnimationActive={false} />
                        <Bar dataKey="commissionEarned" name="Commission" fill="#14b8a6" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Month</TableHead>
                          <TableHead className="text-right">Orders</TableHead>
                          <TableHead className="text-right">Revenue</TableHead>
                          <TableHead className="text-right">Commission</TableHead>
                          <TableHead className="text-right">Pending</TableHead>
                          <TableHead className="text-right">Paid</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {monthly.map((row) => (
                          <TableRow key={row.month}>
                            <TableCell>{row.label}</TableCell>
                            <TableCell className="text-right">{row.orders}</TableCell>
                            <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(row.commissionEarned)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(row.commissionPending)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(row.commissionPaid)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/40 bg-card">
              <CardHeader>
                <CardTitle>Date-wise Activity</CardTitle>
                <CardDescription>Qualifying transactions per day.</CardDescription>
              </CardHeader>
              <CardContent>
                {daily.length === 0 ? (
                  <EmptyState message="No daily activity in this period." />
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={daily}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(value: any) => formatCurrency(Number(value))} />
                        <Area type="monotone" dataKey="revenue" stroke="#14b8a6" fill="#14b8a633" isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-card">
              <CardHeader>
                <CardTitle>Service-wise Performance</CardTitle>
                <CardDescription>Revenue and commission by product.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {services.length === 0 ? (
                  <EmptyState message="No service activity in this period." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Customers</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">Commission</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {services.map((row) => (
                        <TableRow key={row.productId}>
                          <TableCell className="whitespace-normal">{row.productName}</TableCell>
                          <TableCell className="text-right">{row.orders}</TableCell>
                          <TableCell className="text-right">{row.customers}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.commissionEarned)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="glass border-border/40">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/40 p-10 text-center">
      <Gift className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Share your referral link to get started - referrals appear here as soon as someone signs up with your code.
      </p>
    </div>
  )
}

function PageSizeSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger className="w-[110px]"><SelectValue placeholder="Rows" /></SelectTrigger>
      <SelectContent>
        {PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function PaginationBar({
  pagination,
  onChange,
  disabled,
}: {
  pagination: Pagination
  onChange: (page: number) => void
  disabled?: boolean
}) {
  if (!pagination.total) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-4 py-3 text-sm text-muted-foreground">
      <span>
        Page {pagination.page} of {Math.max(1, pagination.pages)} ({pagination.total} total)
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={disabled || pagination.page <= 1} onClick={() => onChange(Math.max(1, pagination.page - 1))}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || pagination.page >= pagination.pages} onClick={() => onChange(Math.min(pagination.pages, pagination.page + 1))}>
          Next
        </Button>
      </div>
    </div>
  )
}

function MobileCustomerList({ rows }: { rows: CustomerRow[] }) {
  return (
    <div className="mt-3 grid gap-3 sm:hidden">
      {rows.map((row) => (
        <div key={row.referralId} className="rounded-lg border border-border/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{row.name}</div>
              <div className="truncate text-xs text-muted-foreground">{row.email}</div>
            </div>
            <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <Row label="Registered" value={formatDate(row.registeredAt)} />
            <Row label="Services" value={`${row.services.activeServices} active / ${row.services.totalServices} total`} />
            <Row label="Orders" value={String(row.orderCount)} />
            <Row label="Spent (excl. GST)" value={formatCurrency(row.totalSpent)} />
            <Row label="GST charged" value={formatCurrency(row.gstCollected)} />
            <Row label="Total paid" value={formatCurrency(row.totalPaid)} />
            <Row label="Commission" value={formatCurrency(row.commissionEarned)} />
          </dl>
        </div>
      ))}
    </div>
  )
}

function MobileOrderList({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="mt-3 grid gap-3 sm:hidden">
      {rows.map((row) => (
        <div key={row.orderId} className="rounded-lg border border-border/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{row.productName}</div>
              <div className="truncate text-xs text-muted-foreground">{row.referredCustomerName}</div>
            </div>
            <Badge variant={statusVariant(row.paymentStatus)}>{row.paymentStatus}</Badge>
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <Row label="Order" value={row.orderNumber} />
            <Row label="Purchased" value={formatDate(row.purchaseDate)} />
            <Row label="Billing period" value={row.billingPeriod} />
            <Row label="Renews" value={formatDate(row.renewalDate)} />
            <Row label="Product price (excl. GST)" value={formatCurrency(row.eligibleBaseAmount)} />
            <Row label="GST" value={formatCurrency(row.taxAmount)} />
            <Row label="Total paid" value={formatCurrency(row.amount)} />
            <Row label="Commission rate" value={`${row.commission.ratePercent}%`} />
            <Row label="Commission" value={`${formatCurrency(row.commission.amount)} (${row.commission.status})`} />
          </dl>
        </div>
      ))}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">{value}</dd>
    </div>
  )
}