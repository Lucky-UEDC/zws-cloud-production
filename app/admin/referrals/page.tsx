"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  BadgeIndianRupee,
  Download,
  Gift,
  Loader2,
  Percent,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

const ORDER_STATUSES = ["all", "paid", "active", "completed", "payment_verified", "pending", "cancelled", "refunded"]
const PAYMENT_STATUSES = ["all", "paid", "pending", "failed", "refunded"]
const REFERRAL_STATUSES = ["all", "active", "inactive", "registered", "blocked"]
const COMMISSION_STATUSES = ["all", "pending", "paid", "reversed"]
const PAGE_SIZES = [10, 20, 50]

const EXPORT_DATASETS = [
  { key: "referrals", label: "Referral relationships" },
  { key: "referrers", label: "Referrers" },
  { key: "orders", label: "Referred orders" },
  { key: "monthly", label: "Monthly report" },
  { key: "daily", label: "Daily report" },
  { key: "services", label: "Service-wise report" },
]

const REFERRAL_TABS = ["overview", "referrers", "referrals", "orders", "commissions", "reports"]

type Pagination = { page: number; pageSize: number; total: number; pages: number }

type Overview = {
  overview: {
    totalReferrers: number
    totalReferredCustomers: number
    statusBreakdown: { registered: number; active: number; inactive: number; blocked: number }
    conversionRate: number
    visits: {
      total: number
      inWindow: number
      registeredAccounts: number
      convertedCustomers: number
      conversionRate: number
      purchaseConversionRate: number
    }
    ledgerCommission: Array<{ status: string; amount: number; count: number }>
  }
  window: { range: string; start: string | null; end: string | null }
  totals: {
    window: Totals
    lifetime: Totals
  }
  program: { commissionPercent: number; holdDays: number; minimumOrderAmount: number; isActive: boolean }
  topReferrers: Array<{ referralId: string; name: string; email: string; code: string; orders: number; referredCustomers: number; revenue: number; commissionEarned: number }>
  topReferredCustomers: CustomerRow[]
  monthly: MonthlyRow[]
  daily: Array<{ day: string; orders: number; revenue: number; commissionEarned: number }>
  services: ServiceRow[]
  truncated: boolean
}

type Totals = {
  totalReferrals: number
  activeReferrals: number
  inactiveReferrals: number
  registeredReferrals: number
  blockedReferrals: number
  conversionRate: number
  referredOrders: number
  referralRevenue: number
  gstCollected: number
  totalCollected: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  totalServices: number
  activeServices: number
}

type CustomerRow = {
  referralId: string
  referralCode: string
  referrerCustomerId: string
  referrerName: string
  referrerEmail: string
  referredCustomerId: string
  name: string
  email: string
  registeredAt: string
  status: string
  converted: boolean
  firstPurchaseAt: string | null
  latestPurchaseAt: string | null
  orderCount: number
  totalSpent: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  services: { totalServices: number; activeServices: number; serviceNames: string[]; productNames: string[]; lastServiceStatus: string | null }
}

type OrderRow = {
  referralId: string
  referrerCustomerId: string
  referrerName: string
  referredCustomerId: string
  referredCustomerName: string
  referredCustomerEmail: string
  serviceId: string | null
  serviceName: string | null
  productId: string | null
  productName: string
  orderId: string
  orderNumber: string
  orderType: string | null
  invoiceNumber: string
  purchaseDate: string
  serviceStartDate: string
  serviceActivatedAt: string | null
  billingPeriod: string
  billingPeriodKey: string | null
  renewalDate: string | null
  amount: number
  taxAmount: number
  eligibleBaseAmount: number
  paymentStatus: string
  orderStatus: string
  serviceStatus: string
  commission: { id: string | null; amount: number; ratePercent: number; status: string; kind: string; materialised: boolean; holdUntil: string | null; paidAt: string | null; reversedAt: string | null; reversalReason: string | null }
}

type ReferrerRow = {
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
  referralRevenue: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
  orders: number
}

type MonthlyRow = {
  month: string
  label: string
  orders: number
  revenue: number
  commissionEarned: number
  commissionPending: number
  commissionPaid: number
  commissionReversed: number
}

type ServiceRow = { productId: string; productName: string; orders: number; customers: number; revenue: number; commissionEarned: number }

type Filters = {
  range: string
  start: string
  end: string
  status: string
  commissionStatus: string
  productId: string
  search: string
  referrerCustomerId: string
  referredCustomerId: string
  orderStatus: string
  paymentStatus: string
  month: string
  sort: string
  direction: "asc" | "desc"
}

const DEFAULT_FILTERS: Filters = {
  range: "last_30_days",
  start: "",
  end: "",
  status: "all",
  commissionStatus: "all",
  productId: "",
  search: "",
  referrerCustomerId: "",
  referredCustomerId: "",
  orderStatus: "all",
  paymentStatus: "all",
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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const value = String(status || "").toLowerCase()
  if (["active", "paid", "completed"].includes(value)) return "default"
  if (["blocked", "reversed", "failed", "cancelled", "refunded"].includes(value)) return "destructive"
  if (["registered", "pending", "inactive"].includes(value)) return "secondary"
  return "outline"
}

export default function AdminReferralsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = REFERRAL_TABS.includes(searchParams.get("tab") || "") ? String(searchParams.get("tab")) : "overview"
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [searchDraft, setSearchDraft] = useState("")
  const [overview, setOverview] = useState<Overview | null>(null)
  const [referrers, setReferrers] = useState<ReferrerRow[]>([])
  const [relationships, setRelationships] = useState<CustomerRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [commissions, setCommissions] = useState<OrderRow[]>([])
  const [ledgerTotals, setLedgerTotals] = useState<{ lifetime: Totals | null; window: Totals | null; ledger: Array<{ status: string; amount: number; count: number }> } | null>(null)
  const [pagination, setPagination] = useState<Record<string, Pagination>>({
    referrers: { page: 1, pageSize: 20, total: 0, pages: 1 },
    relationships: { page: 1, pageSize: 20, total: 0, pages: 1 },
    orders: { page: 1, pageSize: 20, total: 0, pages: 1 },
    commissions: { page: 1, pageSize: 20, total: 0, pages: 1 },
  })
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportDataset, setExportDataset] = useState("referrals")

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("range", filters.range)
    if (filters.range === "custom") {
      if (filters.start) params.set("start", filters.start)
      if (filters.end) params.set("end", filters.end)
    }
    if (filters.status !== "all") params.set("status", filters.status)
    if (filters.commissionStatus !== "all") params.set("commissionStatus", filters.commissionStatus)
    if (filters.productId) params.set("productId", filters.productId)
    if (filters.search) params.set("search", filters.search)
    if (filters.referrerCustomerId) params.set("referrerCustomerId", filters.referrerCustomerId)
    if (filters.referredCustomerId) params.set("referredCustomerId", filters.referredCustomerId)
    if (filters.orderStatus !== "all") params.set("orderStatus", filters.orderStatus)
    if (filters.paymentStatus !== "all") params.set("paymentStatus", filters.paymentStatus)
    if (filters.month) params.set("month", filters.month)
    if (filters.sort) params.set("sort", filters.sort)
    params.set("direction", filters.direction)
    return params
  }, [filters])

  const load = useCallback(async function load(silent = false) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const paged = (key: string, size: number) => {
        const params = new URLSearchParams(queryString)
        params.set("page", String(pagination[key].page))
        params.set("pageSize", String(size))
        return params
      }

      const responses = await Promise.all([
        fetch(`/api/admin/referrals/overview?${queryString}`, { cache: "no-store" }),
        fetch(`/api/admin/referrals/referrers?${paged("referrers", pagination.referrers.pageSize)}`, { cache: "no-store" }),
        fetch(`/api/admin/referrals/relationships?${paged("relationships", pagination.relationships.pageSize)}`, { cache: "no-store" }),
        fetch(`/api/admin/referrals/orders?${paged("orders", pagination.orders.pageSize)}`, { cache: "no-store" }),
        fetch(`/api/admin/referrals/commissions?${paged("commissions", pagination.commissions.pageSize)}`, { cache: "no-store" }),
      ])

      const [overviewRes, referrersRes, relationshipsRes, ordersRes, commissionsRes] = responses
      const [overviewJson, referrersJson, relationshipsJson, ordersJson, commissionsJson] = await Promise.all([
        readJsonResponse<any>(overviewRes),
        readJsonResponse<any>(referrersRes),
        readJsonResponse<any>(relationshipsRes),
        readJsonResponse<any>(ordersRes),
        readJsonResponse<any>(commissionsRes),
      ])

      if (!overviewRes.ok) throw new Error(overviewJson?.error || "Unable to load referral overview")
      if (!referrersRes.ok) throw new Error(referrersJson?.error || "Unable to load referrers")
      if (!relationshipsRes.ok) throw new Error(relationshipsJson?.error || "Unable to load referrals")
      if (!ordersRes.ok) throw new Error(ordersJson?.error || "Unable to load referred orders")
      if (!commissionsRes.ok) throw new Error(commissionsJson?.error || "Unable to load commissions")

      setOverview(overviewJson)
      setReferrers(referrersJson.referrers || [])
      setRelationships(relationshipsJson.referrals || [])
      setOrders(ordersJson.orders || [])
      setCommissions(commissionsJson.commissions || [])
      setLedgerTotals({ lifetime: commissionsJson.totals?.lifetime || null, window: commissionsJson.totals?.window || null, ledger: commissionsJson.totals?.ledger || [] })
      // Only replace pagination when a value actually moved. Returning the same
      // object keeps `load`'s identity stable, which is what stops the effect
      // below from refetching in a loop every time a response arrives.
      setPagination((current) => {
        const next = { ...current }
        let changed = false
        const incoming: Record<string, any> = {
          referrers: referrersJson.pagination,
          relationships: relationshipsJson.pagination,
          orders: ordersJson.pagination,
          commissions: commissionsJson.pagination,
        }
        for (const key of Object.keys(incoming)) {
          const value = incoming[key]
          if (!value) continue
          const currentRow = current[key as keyof typeof current]
          if (
            currentRow.page !== value.page
            || currentRow.pageSize !== value.pageSize
            || currentRow.total !== value.total
            || currentRow.pages !== value.pages
          ) {
            next[key as keyof typeof next] = { ...currentRow, ...value }
            changed = true
          }
        }
        return changed ? next : current
      })
    } catch (err: any) {
      setError(err?.message || "Something could not load. Please retry.")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [queryString, pagination])

  useEffect(() => {
    void load()
  }, [load])

  function updateFilters(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setPagination((current) => ({
      referrers: { ...current.referrers, page: 1 },
      relationships: { ...current.relationships, page: 1 },
      orders: { ...current.orders, page: 1 },
      commissions: { ...current.commissions, page: 1 },
    }))
  }

  function updatePagination(key: string, patch: Partial<Pagination>) {
    setPagination((current) => ({ ...current, [key]: { ...current[key], ...patch } }))
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS)
    setSearchDraft("")
    setPagination((current) => ({
      referrers: { ...current.referrers, page: 1 },
      relationships: { ...current.relationships, page: 1 },
      orders: { ...current.orders, page: 1 },
      commissions: { ...current.commissions, page: 1 },
    }))
  }

  function exportUrl(format: string) {
    const params = new URLSearchParams(queryString)
    params.set("dataset", exportDataset)
    params.set("format", format)
    return `/api/admin/referrals/export?${params.toString()}`
  }

  async function syncCommissions() {
    setSyncing(true)
    try {
      const response = await fetch(`/api/admin/referrals/commissions/sync?${queryString}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      })
      const json = await readJsonResponse<any>(response)
      if (!response.ok) throw new Error(json?.error || "Sync failed")
      const result = json?.result || {}
      toast.success(`Ledger synced: ${result.synced?.created ?? 0} created, ${result.synced?.updated ?? 0} updated, ${result.reversed ?? 0} reversed`)
      await load(true)
    } catch (err: any) {
      toast.error(err?.message || "Could not sync commissions")
    } finally {
      setSyncing(false)
    }
  }

  async function commissionAction(commissionId: string, action: "pay" | "reverse") {
    if (!commissionId) {
      toast.error("This commission has not been written to the ledger yet. Run Sync commission ledger first.")
      return
    }
    try {
      const response = await fetch(`/api/admin/referrals/commissions/${commissionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: action === "reverse" ? "Reversed by administrator" : undefined }),
      })
      const json = await readJsonResponse<any>(response)
      if (!response.ok) throw new Error(json?.error || "Update failed")
      toast.success(`Commission ${action === "pay" ? "marked paid" : "reversed"}`)
      await load(true)
    } catch (err: any) {
      toast.error(err?.message || "Could not update the commission")
    }
  }

  const statusPie = useMemo(() => {
    if (!overview) return []
    const breakdown = overview.overview.statusBreakdown
    return [
      { name: "Active", value: breakdown.active, color: "#22c55e" },
      { name: "Inactive", value: breakdown.inactive, color: "#f59e0b" },
      { name: "Registered", value: breakdown.registered, color: "#38bdf8" },
      { name: "Blocked", value: breakdown.blocked, color: "#ef4444" },
    ].filter((item) => item.value > 0)
  }, [overview])

  if (loading && !overview) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error && !overview) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Referral Management</h1>
        <Card className="border-red-400/20 bg-red-400/5">
          <CardContent className="flex flex-col items-start gap-3 p-5">
            <p className="font-medium">{error}</p>
            <Button variant="outline" onClick={() => void load()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const lifetime = overview?.totals.lifetime
  const windowTotals = overview?.totals.window

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Referral Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every referrer, every referred customer, the services they took and the commission each transaction earned.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            <RefreshCw className="mr-2 h-4 w-4" />Refresh
          </Button>
          <Button variant="outline" size="sm" disabled={syncing} onClick={() => void syncCommissions()}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BadgeIndianRupee className="mr-2 h-4 w-4" />}
            Sync commission ledger
          </Button>
        </div>
      </div>

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
              <Input type="date" value={filters.start} onChange={(e) => updateFilters({ start: e.target.value })} aria-label="Start date" />
              <Input type="date" value={filters.end} onChange={(e) => updateFilters({ end: e.target.value })} aria-label="End date" />
            </>
          ) : null}
          <Select value={filters.status} onValueChange={(value) => updateFilters({ status: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Referral status" /></SelectTrigger>
            <SelectContent>
              {REFERRAL_STATUSES.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.commissionStatus} onValueChange={(value) => updateFilters({ commissionStatus: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Commission status" /></SelectTrigger>
            <SelectContent>
              {COMMISSION_STATUSES.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.orderStatus} onValueChange={(value) => updateFilters({ orderStatus: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Order status" /></SelectTrigger>
            <SelectContent>
              {ORDER_STATUSES.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.paymentStatus} onValueChange={(value) => updateFilters({ paymentStatus: value })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Payment status" /></SelectTrigger>
            <SelectContent>
              {PAYMENT_STATUSES.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") updateFilters({ search: searchDraft.trim() }) }}
            placeholder="Customer, email, code, order ID"
            aria-label="Search referrals"
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => updateFilters({ search: searchDraft.trim() })}>
              <Search className="mr-2 h-4 w-4" />Search
            </Button>
            <Button variant="outline" onClick={resetFilters}>Reset</Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
        <MetricCard label="Unique Visits" value={String(overview?.overview.visits?.total ?? 0)} />
        <MetricCard label="Registered Accounts" value={String(overview?.overview.visits?.registeredAccounts ?? 0)} />
        <MetricCard label="First-Purchase Conversions" value={String(overview?.overview.visits?.convertedCustomers ?? 0)} />
        <MetricCard label="Visit → Account Rate" value={`${overview?.overview.visits?.conversionRate ?? 0}%`} icon={<Percent className="h-4 w-4" />} />
        <MetricCard label="Account → Purchase Rate" value={`${overview?.overview.visits?.purchaseConversionRate ?? 0}%`} icon={<Percent className="h-4 w-4" />} />
        <MetricCard label="Referrers" value={String(overview?.overview.totalReferrers ?? 0)} icon={<Users className="h-4 w-4" />} />
        <MetricCard label="Referred Customers" value={String(overview?.overview.totalReferredCustomers ?? 0)} />
        <MetricCard label="Conversion Rate" value={`${overview?.overview.conversionRate ?? 0}%`} icon={<Percent className="h-4 w-4" />} />
        <MetricCard label="Referral Revenue excl. GST (range)" value={formatCurrency(windowTotals?.referralRevenue ?? 0)} />
        <MetricCard label="GST Collected (range)" value={formatCurrency(windowTotals?.gstCollected ?? 0)} />
        <MetricCard label="Commission Earned" value={formatCurrency(lifetime?.commissionEarned ?? 0)} icon={<TrendingUp className="h-4 w-4" />} />
        <MetricCard label="Commission Paid" value={formatCurrency(lifetime?.commissionPaid ?? 0)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Pending Commission" value={formatCurrency(lifetime?.commissionPending ?? 0)} />
        <MetricCard label="Reversed Commission" value={formatCurrency(lifetime?.commissionReversed ?? 0)} />
        <MetricCard label="Referred Orders (range)" value={String(windowTotals?.referredOrders ?? 0)} />
        <MetricCard label="Active Services" value={String(overview?.overview.statusBreakdown.active ?? 0)} />
      </div>

      {overview?.truncated ? (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4 text-sm text-amber-300">
            This report covers the most recent referral records only. Narrow the date range or filters to see the rest.
          </CardContent>
        </Card>
      ) : null}

      <Tabs value={activeTab} onValueChange={(value) => router.replace(value === "overview" ? "/admin/referrals" : `/admin/referrals?tab=${value}`, { scroll: false })} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="referrers">Referrers</TabsTrigger>
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="commissions">Commissions</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/40 bg-card">
              <CardHeader>
                <CardTitle>Monthly Referral Performance</CardTitle>
                <CardDescription>Revenue and commission by the month each transaction was paid for.</CardDescription>
              </CardHeader>
              <CardContent>
                {(overview?.monthly?.length ?? 0) === 0 ? (
                  <EmptyAdmin message="No referral activity in this period." />
                ) : (
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={overview?.monthly || []}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(value: any, name: any) => [formatCurrency(Number(value)), String(name)]} />
                        <Bar dataKey="revenue" name="Revenue" fill="#22c55e" isAnimationActive={false} />
                        <Bar dataKey="commissionEarned" name="Commission" fill="#14b8a6" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-card">
              <CardHeader>
                <CardTitle>Active vs Inactive Referrals</CardTitle>
                <CardDescription>Derived from each referred customer&rsquo;s live services.</CardDescription>
              </CardHeader>
              <CardContent>
                {statusPie.length === 0 ? (
                  <EmptyAdmin message="No referred customers in this period." />
                ) : (
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={statusPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} isAnimationActive={false}>
                          {statusPie.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/40 bg-card">
              <CardHeader><CardTitle>Top Referrers</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                {(overview?.topReferrers?.length ?? 0) === 0 ? <EmptyAdmin message="No referrer activity in this period." /> : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Referrer</TableHead>
                        <TableHead className="text-right">Customers</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">Commission</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(overview?.topReferrers || []).map((row) => (
                        <TableRow key={row.referralId}>
                          <TableCell className="whitespace-normal">
                            <div className="font-medium">{row.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">{row.code}</div>
                          </TableCell>
                          <TableCell className="text-right">{row.referredCustomers}</TableCell>
                          <TableCell className="text-right">{row.orders}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.commissionEarned)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-card">
              <CardHeader><CardTitle>Top Referred Customers</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                {(overview?.topReferredCustomers?.length ?? 0) === 0 ? <EmptyAdmin message="No referred customers in this period." /> : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Referrer</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Spent</TableHead>
                        <TableHead className="text-right">Commission</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(overview?.topReferredCustomers || []).map((row) => (
                        <TableRow key={row.referralId}>
                          <TableCell className="whitespace-normal">
                            <div className="font-medium">{row.name}</div>
                            <div className="text-xs text-muted-foreground">{row.email}</div>
                          </TableCell>
                          <TableCell>{row.referrerName}</TableCell>
                          <TableCell className="text-right">{row.orderCount}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.totalSpent)}</TableCell>
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

        <TabsContent value="referrers">
          <DataCard
            title="Referrers"
            description="Every customer with a referral account, their code and what they have brought in."
            pagination={pagination.referrers}
            onPagination={(patch) => updatePagination("referrers", patch)}
            toolbar={(
              <div className="flex flex-wrap items-center gap-2">
                <PageSizeSelect value={pagination.referrers.pageSize} onChange={(value) => updatePagination("referrers", { pageSize: value, page: 1 })} />
                <ExportMenu dataset={exportDataset} onDataset={setExportDataset} queryString={queryString} />
              </div>
            )}
            headers={["Referrer", "Code", "Referrals", "Active", "Conversion", "Orders", "Revenue", "Commission", "Pending", "Paid", "Reversed"]}
            rows={referrers.map((row) => [
              `${row.name}\n${row.email}`,
              row.code || "-",
              String(row.totalReferrals),
              String(row.activeReferrals),
              `${row.conversionRate}%`,
              String(row.orders),
              formatCurrency(row.referralRevenue),
              formatCurrency(row.commissionEarned),
              formatCurrency(row.commissionPending),
              formatCurrency(row.commissionPaid),
              formatCurrency(row.commissionReversed),
            ])}
            emptyMessage="No referrers match these filters yet."
          />
        </TabsContent>

        <TabsContent value="referrals">
          <DataCard
            title="Referral Relationships"
            description="Referrer to referred customer, with registration date, service state, and totals."
            pagination={pagination.relationships}
            onPagination={(patch) => updatePagination("relationships", patch)}
            toolbar={(
              <div className="flex flex-wrap items-center gap-2">
                <PageSizeSelect value={pagination.relationships.pageSize} onChange={(value) => updatePagination("relationships", { pageSize: value, page: 1 })} />
                <ExportMenu dataset={exportDataset} onDataset={setExportDataset} queryString={queryString} />
              </div>
            )}
            headers={["Referred Customer", "Referrer", "Registered", "Status", "First Purchase", "Latest Purchase", "Services", "Orders", "Revenue", "Commission"]}
            rows={relationships.map((row) => [
              `${row.name}\n${row.email}`,
              `${row.referrerName}\n${row.referralCode}`,
              formatDate(row.registeredAt),
              row.status,
              formatDate(row.firstPurchaseAt),
              formatDate(row.latestPurchaseAt),
              `${row.services.activeServices} active / ${row.services.totalServices} total`,
              String(row.orderCount),
              formatCurrency(row.totalSpent),
              formatCurrency(row.commissionEarned),
            ])}
            statusColumn={3}
            emptyMessage="No referrals match these filters yet."
          />
        </TabsContent>

        <TabsContent value="orders">
          <DataCard
            title="Referred Orders"
            description="One row per qualifying transaction, including renewals."
            pagination={pagination.orders}
            onPagination={(patch) => updatePagination("orders", patch)}
            toolbar={(
              <div className="flex flex-wrap items-center gap-2">
                <PageSizeSelect value={pagination.orders.pageSize} onChange={(value) => updatePagination("orders", { pageSize: value, page: 1 })} />
                <ExportMenu dataset={exportDataset} onDataset={setExportDataset} queryString={queryString} />
              </div>
            )}
            headers={["Customer", "Referrer", "Service", "Order", "Purchase Date", "Billing Period", "Renewal", "Product (excl. GST)", "GST", "Total Paid", "Payment", "Service Status", "Commission"]}
            rows={orders.map((row) => [
              `${row.referredCustomerName}\n${row.referredCustomerEmail}`,
              row.referrerName,
              `${row.productName}${row.serviceName ? `\n${row.serviceName}` : ""}${row.orderType === "renewal" ? "\nRenewal" : ""}`,
              `${row.orderNumber}\n${row.invoiceNumber}`,
              formatDate(row.purchaseDate, true),
              row.billingPeriod,
              formatDate(row.renewalDate),
              formatCurrency(row.eligibleBaseAmount),
              formatCurrency(row.taxAmount),
              formatCurrency(row.amount),
              row.paymentStatus,
              row.serviceStatus,
              `${formatCurrency(row.commission.amount)}\n${row.commission.status}`,
            ])}
            emptyMessage="No referred orders match these filters yet."
          />
        </TabsContent>

        <TabsContent value="commissions">
          <Card className="border-border/40 bg-card">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Commission Ledger</CardTitle>
                <CardDescription>Earned, pending, paid and reversed, kept separate so the numbers never blur together.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PageSizeSelect value={pagination.commissions.pageSize} onChange={(value) => updatePagination("commissions", { pageSize: value, page: 1 })} />
                <ExportMenu dataset={exportDataset} onDataset={setExportDataset} queryString={queryString} />
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {commissions.length === 0 ? (
                <EmptyAdmin message="No commission rows match these filters yet." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead>Earned At</TableHead>
                      <TableHead className="text-right">Base (excl. GST)</TableHead>
                      <TableHead className="text-right">GST</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commissions.map((row) => (
                      <TableRow key={row.orderId}>
                        <TableCell className="whitespace-normal">{row.referredCustomerName}</TableCell>
                        <TableCell className="font-mono text-xs">{row.orderNumber}</TableCell>
                        <TableCell>{formatDate(row.purchaseDate, true)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.eligibleBaseAmount)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatCurrency(row.taxAmount)}</TableCell>
                        <TableCell className="text-right">{row.commission.ratePercent}%</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.commission.amount)}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(row.commission.status)}>{row.commission.status}</Badge>
                          {!row.commission.materialised ? (
                            <div className="mt-1 text-xs text-muted-foreground">calculated, not yet in ledger</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {row.commission.status === "pending" ? (
                              <Button size="sm" variant="outline" onClick={() => void commissionAction(row.commission.id || "", "pay")}>Mark paid</Button>
                            ) : null}
                            {row.commission.status === "paid" ? (
                              <Button size="sm" variant="outline" onClick={() => void commissionAction(row.commission.id || "", "reverse")}>Reverse</Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-4 py-3 text-sm text-muted-foreground">
              <span>Page {pagination.commissions.page} of {Math.max(1, pagination.commissions.pages)} ({pagination.commissions.total} total)</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pagination.commissions.page <= 1} onClick={() => updatePagination("commissions", { page: Math.max(1, pagination.commissions.page - 1) })}>Previous</Button>
                <Button size="sm" variant="outline" disabled={pagination.commissions.page >= pagination.commissions.pages} onClick={() => updatePagination("commissions", { page: Math.min(pagination.commissions.pages, pagination.commissions.page + 1) })}>Next</Button>
              </div>
            </div>
          </Card>
          {ledgerTotals?.ledger?.length ? (
            <Card className="border-border/40 bg-card">
              <CardHeader><CardTitle>Materialised ledger</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-6">
                {ledgerTotals.ledger.map((row) => (
                  <div key={row.status}>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{row.status}</div>
                    <div className="text-lg font-semibold">{formatCurrency(row.amount)}</div>
                    <div className="text-xs text-muted-foreground">{row.count} rows</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          <Card className="border-border/40 bg-card">
            <CardHeader>
              <CardTitle>Monthly Referral Report</CardTitle>
              <CardDescription>Each month is its own row, so renewals in later months count again.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {(overview?.monthly?.length ?? 0) === 0 ? <EmptyAdmin message="No monthly activity in this period." /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Earned</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Reversed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overview?.monthly || []).map((row: MonthlyRow) => (
                      <TableRow key={row.month}>
                        <TableCell>{row.label}</TableCell>
                        <TableCell className="text-right">{row.orders}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.commissionEarned)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.commissionPending)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.commissionPaid)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.commissionReversed)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/40 bg-card">
              <CardHeader><CardTitle>Daily Referral Report</CardTitle></CardHeader>
              <CardContent>
                {(overview?.daily?.length ?? 0) === 0 ? <EmptyAdmin message="No daily activity in this period." /> : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={overview?.daily || []}>
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
              <CardHeader><CardTitle>Service / Product-wise Report</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                {(overview?.services?.length ?? 0) === 0 ? <EmptyAdmin message="No service activity in this period." /> : (
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
                      {(overview?.services || []).map((row: ServiceRow) => (
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

function MetricCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">{icon}{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function EmptyAdmin({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/40 p-10 text-center">
      <Gift className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
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

function ExportMenu({
  dataset,
  onDataset,
  queryString,
}: {
  dataset: string
  onDataset: (value: string) => void
  queryString: URLSearchParams
}) {
  function url(format: string) {
    const params = new URLSearchParams(queryString.toString())
    params.set("dataset", dataset)
    params.set("format", format)
    return `/api/admin/referrals/export?${params.toString()}`
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={dataset} onValueChange={onDataset}>
        <SelectTrigger className="w-[190px]"><SelectValue placeholder="Export" /></SelectTrigger>
        <SelectContent>
          {EXPORT_DATASETS.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={() => window.open(url("csv"), "_blank")}>
        <Download className="mr-2 h-4 w-4" />CSV
      </Button>
      <Button size="sm" variant="outline" onClick={() => window.open(url("excel"), "_blank")}>
        <Download className="mr-2 h-4 w-4" />Excel
      </Button>
      <Button size="sm" variant="outline" onClick={() => window.open(url("pdf"), "_blank")}>
        <Download className="mr-2 h-4 w-4" />PDF
      </Button>
    </div>
  )
}

function DataCard({
  title,
  description,
  headers,
  rows,
  emptyMessage,
  pagination,
  onPagination,
  toolbar,
  statusColumn,
}: {
  title: string
  description: string
  headers: string[]
  rows: string[][]
  emptyMessage: string
  pagination: Pagination
  onPagination: (patch: Partial<Pagination>) => void
  toolbar?: React.ReactNode
  statusColumn?: number
}) {
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {toolbar}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyAdmin message={emptyMessage} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    {headers.map((header) => <TableHead key={header}>{header}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow key={index}>
                      {row.map((cell, cellIndex) => (
                        <TableCell key={cellIndex} className="whitespace-normal align-top">
                          {cellIndex === statusColumn
                            ? <Badge variant={statusVariant(cell)}>{cell}</Badge>
                            : cell.split("\n").map((line, lineIndex) => (
                              <span key={lineIndex} className={lineIndex === 0 ? "block" : "block text-xs text-muted-foreground"}>{line}</span>
                            ))}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-3 md:hidden">
              {rows.map((row, index) => (
                <div key={index} className="rounded-lg border border-border/40 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 text-sm font-medium">{row[0]?.split("\n")[0] || "-"}</div>
                    {statusColumn === 0 && row[0] ? <Badge variant={statusVariant(row[statusColumn])}>{row[statusColumn]}</Badge> : null}
                  </div>
                  <dl className="mt-2 space-y-1 text-xs">
                    {row.map((cell, cellIndex) => (
                      <div key={cellIndex} className="flex items-start justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{headers[cellIndex]}</dt>
                        <dd className="text-right font-medium">{cell.replace(/\n/g, ", ") || "-"}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-4 py-3 text-sm text-muted-foreground">
        <span>Page {pagination.page} of {Math.max(1, pagination.pages)} ({pagination.total} total)</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={pagination.page <= 1} onClick={() => onPagination({ page: Math.max(1, pagination.page - 1) })}>Previous</Button>
          <Button size="sm" variant="outline" disabled={pagination.page >= pagination.pages} onClick={() => onPagination({ page: Math.min(pagination.pages, pagination.page + 1) })}>Next</Button>
        </div>
      </div>
    </Card>
  )
}