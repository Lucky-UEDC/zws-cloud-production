"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Calendar,
  CircleDollarSign,
  Download,
  Filter,
  Funnel,
  Loader2,
  ReceiptText,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatCurrency } from "@/lib/currency-format"
import { cn } from "@/lib/utils"

const RANGES = [
  ["today", "Today"],
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
  ["1y", "1Y"],
  ["custom", "Custom"],
] as const

const MODES = ["Revenue", "Payments", "Invoices", "Growth", "Taxes"] as const

type SeriesPoint = {
  date: string
  label: string
  grossRevenue: number
  netRevenue: number
  gstCollected: number
  discounts: number
  paidInvoices: number
  walletTopups: number
  walletTopupFees: number
  gatewayFees: number
  refunds: number
  collectedRevenue: number
  walletServicePayments: number
  gatewayServicePayments: number
  failedPaymentAmount: number
  failedPaymentCount: number
  pendingInvoiceAmount: number
  growthPercent: number
}

type RevenueCard = {
  current: number
  prior: number
  change: number
}

type RevenueData = {
  range: string
  start: string | null
  end: string | null
  priorPeriod: { start: string | null; end: string | null }
  cards: Record<string, RevenueCard>
  series: SeriesPoint[]
  insights: {
    revenueTrendPercent: number
    highestSalesDay: string
    averageOrderValue: number
    topPaymentSource: string
    paymentSuccessRate: number
    liveUpdatedAt: string
  }
  breakdowns: {
    gateway: Array<{ gateway: string; amount: number }>
    product: Array<{ product: string; amount: number }>
    source: Array<{ source: string; amount: number }>
    country: Array<{ country: string; amount: number }>
    node: Array<{ node: string; amount: number }>
    topCustomers: Array<{ customer: string; amount: number }>
    walletTopups: number
    walletTopupFees: number
    gatewayFees: number
    refunds: number
    gstCollected: number
    discounts: number
    failedPayments: number
    failedPaymentAmount: number
  }
  revenueByDay: Array<{ date: string; amount: number }>
  revenueByGateway: Array<{ gateway: string; amount: number }>
  revenueByProduct: Array<{ product: string; amount: number }>
  revenueBySource: Array<{ source: string; amount: number }>
  revenueByCountry: Array<{ country: string; amount: number }>
  revenueByNode: Array<{ node: string; amount: number }>
  recentPaidInvoices: Array<{
    id: string
    invoiceNumber: string
    customer: string
    product: string
    node: string
    country: string
    gateway: string
    amount: number
    netAmount: number
    tax: number
    discount: number
    paidAt: string
    orderStatus: string
    paymentStatus: string
  }>
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  failedPaymentsTable: Array<{ id: number; amount: number; status: string }>
  topProducts: Array<{ product: string; amount: number }>
  topNodes: Array<{ node: string; amount: number }>
  countryRevenue: Array<{ country: string; amount: number }>
  topCustomers: Array<{ customer: string; amount: number }>
  cardDefinitions: Array<{ key: string; label: string; description: string; format: string }>
}

function compactMoney(value: number) {
  const abs = Math.abs(value)
  if (abs >= 10_000_000) return `₹${(value / 10_000_000).toFixed(1)}Cr`
  if (abs >= 100_000) return `₹${(value / 100_000).toFixed(1)}L`
  if (abs >= 1_000) return `₹${(value / 1_000).toFixed(1)}K`
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
}

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}

function pct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`
}

function trendClass(value: number) {
  return value >= 0 ? "text-emerald-300" : "text-red-300"
}

function trendIcon(value: number) {
  return value >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />
}

export default function AdminRevenuePage() {
  const [range, setRange] = useState("30d")
  const [mode, setMode] = useState("Revenue")
  const [filters, setFilters] = useState({
    start: "",
    end: "",
    product: "",
    country: "",
    node: "",
    gateway: "",
    paymentStatus: "",
    orderStatus: "",
  })
  const [data, setData] = useState<RevenueData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; totalPages: number }>({ page: 1, pageSize: 20, total: 0, totalPages: 0 })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    async function load(silent = false) {
      if (!silent) setLoading(true)
      const params = new URLSearchParams({ range })
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
      params.set("page", String(pagination.page))
      params.set("pageSize", String(pagination.pageSize))
      try {
        const res = await fetch(`/api/admin/revenue?${params.toString()}`, { cache: "no-store" })
        const payload = await readJsonResponse<any>(res)
        if (cancelled) return
        if (!res.ok) {
          setError(payload?.error || "Unable to load revenue analytics")
          setData(null)
        } else {
          setError(null)
          setData(payload)
        }
      } catch (err: any) {
        if (cancelled) return
        setError(err?.message || "Unable to load revenue analytics")
        setData(null)
      } finally {
        if (!silent) setLoading(false)
      }
    }

    void load(false)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [range, filters, pagination.page, pagination.pageSize])

  const hasRevenue = data?.series.some((point) => point.grossRevenue > 0) ?? false

  const kpiCards = useMemo(() => {
    if (!data) return []
    const c = data.cards
    return [
      { key: "grossRevenue", label: "Gross Revenue", value: c.grossRevenue, icon: CircleDollarSign, accent: "text-emerald-300", description: "Sum of paid service invoices (tax-inclusive)" },
      { key: "netRevenue", label: "Net Revenue", value: c.netRevenue, icon: Banknote, accent: "text-blue-300", description: "Gross Revenue − GST/Tax collected" },
      { key: "collectedRevenue", label: "Collected", value: c.collectedRevenue, icon: ReceiptText, accent: "text-cyan-300", description: "Actual money collected via completed service payments" },
      { key: "gatewayFees", label: "Gateway Fees", value: c.gatewayFees, icon: ReceiptText, accent: "text-amber-300", description: "Wallet top-up fees + gateway settlement fees" },
      { key: "gstCollected", label: "GST/Tax", value: c.gstCollected, icon: ReceiptText, accent: "text-emerald-300", description: "Sum of invoice.taxAmount" },
      { key: "refunds", label: "Refunds", value: c.refunds, icon: ReceiptText, accent: "text-rose-300", description: "Completed wallet refunds (deduped)" },
      { key: "walletTopups", label: "Wallet Top-ups", value: c.walletTopups, icon: CircleDollarSign, accent: "text-purple-300", description: "WalletTransaction type=topup (liability, NOT revenue)" },
      { key: "walletServicePayments", label: "Wallet Service Payments", value: c.walletServicePayments, icon: Banknote, accent: "text-violet-300", description: "Service payments made via wallet (gateway=wallet)" },
      { key: "aov", label: "AOV", value: c.aov, icon: TrendingUp, accent: "text-lime-300", description: "Paid service revenue / paid service orders (excl. top-ups)" },
      { key: "mrr", label: "MRR", value: c.mrr, icon: Banknote, accent: "text-cyan-300", description: "Monthly Recurring Revenue (recurring, tax-exclusive)" },
      { key: "arr", label: "ARR", value: c.arr, icon: CircleDollarSign, accent: "text-violet-300", description: "Annual Recurring Revenue (MRR × 12)" },
      { key: "paidInvoices", label: "Paid Invoices", value: { current: c.paidInvoices.current, prior: c.paidInvoices.prior, change: c.paidInvoices.change }, icon: ReceiptText, accent: "text-blue-300", description: "Count of paid service invoices" },
    ]
  }, [data])

  function exportUrl(format: "pdf" | "csv" | "excel") {
    const params = new URLSearchParams({ range, format })
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
    return `/api/admin/revenue?${params.toString()}`
  }

  if (loading && !data) return <RevenueSkeleton />
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="relative overflow-hidden rounded-2xl border border-border/40 bg-card p-5 shadow-sm">
        <div className="absolute inset-0 opacity-10 [background-image:linear-gradient(rgba(148,163,184,.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.08)_1px,transparent_1px)] [background-size:36px_36px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              FinOps Intelligence
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Revenue Analytics</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Paid service revenue, wallet flow, gateway captures, invoice risk, and growth signals — all from authoritative financial records.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map(([value, label]) => (
              <Button key={value} type="button" size="sm" variant={range === value ? "default" : "outline"} onClick={() => setRange(value)}>
                {label}
              </Button>
            ))}
            {range === "custom" && (
              <>
                <Input type="date" value={filters.start} onChange={(e) => setFilters((c) => ({ ...c, start: e.target.value }))} className="w-36" />
                <span className="text-muted-foreground">to</span>
                <Input type="date" value={filters.end} onChange={(e) => setFilters((c) => ({ ...c, end: e.target.value }))} className="w-36" />
              </>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => window.open(exportUrl("pdf"), "_blank")}>
              <Download className="mr-2 h-4 w-4" />PDF
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => window.open(exportUrl("csv"), "_blank")}>
              <Download className="mr-2 h-4 w-4" />CSV
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => window.open(exportUrl("excel"), "_blank")}>
              <Download className="mr-2 h-4 w-4" />Excel
            </Button>
          </div>
        </div>
      </section>

      {/* Filters */}
      <Card className="border-border/40 bg-card">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Product"
              value={filters.product}
              onChange={(e) => setFilters((c) => ({ ...c, product: e.target.value }))}
              className="pl-9"
            />
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Country"
              value={filters.country}
              onChange={(e) => setFilters((c) => ({ ...c, country: e.target.value }))}
              className="pl-9"
            />
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Node"
              value={filters.node}
              onChange={(e) => setFilters((c) => ({ ...c, node: e.target.value }))}
              className="pl-9"
            />
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Gateway"
              value={filters.gateway}
              onChange={(e) => setFilters((c) => ({ ...c, gateway: e.target.value }))}
              className="pl-9"
            />
          </div>
          <Select value={filters.paymentStatus} onValueChange={(v) => setFilters((c) => ({ ...c, paymentStatus: v }))}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Payment Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="captured">Captured</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.orderStatus} onValueChange={(v) => setFilters((c) => ({ ...c, orderStatus: v }))}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Order Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="payment_verified">Payment Verified</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setFilters({ start: "", end: "", product: "", country: "", node: "", gateway: "", paymentStatus: "", orderStatus: "" })} className="h-10">
            <Funnel className="mr-2 h-4 w-4" />Clear Filters
          </Button>
        </CardContent>
      </Card>

      {/* KPI Cards — Responsive: 4 cols xl, 2 cols md, 1 col mobile */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
        {kpiCards.map((item) => (
          <KpiCard key={item.key} item={item} series={data?.series || []} />
        ))}
      </div>

      {/* Main Chart + Side Panels */}
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.8fr)]">
        <Card className="border-border/40 bg-card overflow-hidden">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Revenue Trend</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Service revenue (solid) vs Net revenue (tax-exclusive). Wallet top-ups & credits excluded.</p>
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border border-border/40 bg-muted/30 p-1">
              {MODES.map((item) => (
                <button key={item} type="button" onClick={() => setMode(item)} className={cn(
                  "rounded-md border border-transparent px-3 py-1.5 text-xs transition",
                  mode === item
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}>
                  {item}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <div className="relative h-[380px] overflow-hidden rounded-xl border border-border/30 bg-muted/20 p-3">
              {!hasRevenue ? (
                <EmptyRevenueState />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.series || []} margin={{ left: 4, right: 18, top: 18, bottom: 8 }}>
                    <defs>
                      <linearGradient id="grossRevenueGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#14B8A6" stopOpacity={0.24} />
                        <stop offset="45%" stopColor="#0F766E" stopOpacity={0.12} />
                        <stop offset="100%" stopColor="#0F766E" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="netRevenueGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10B981" stopOpacity={0.24} />
                        <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(148,163,184,0.14)" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "rgba(203,213,225,.72)", fontSize: 11 }} minTickGap={18} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: "rgba(203,213,225,.72)", fontSize: 11 }} tickFormatter={compactMoney} width={58} />
                    <Tooltip cursor={{ stroke: "rgba(20,184,166,.45)", strokeWidth: 1 }} content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="grossRevenue" stroke="#14B8A6" strokeWidth={3} fill="url(#grossRevenueGradient)" activeDot={{ r: 7, strokeWidth: 2, stroke: "#ECFEFF", fill: "#14B8A6" }} isAnimationActive={false} />
                    <Area type="monotone" dataKey="netRevenue" stroke="#10B981" strokeWidth={2} fill="url(#netRevenueGradient)" activeDot={{ r: 5, strokeWidth: 2, stroke: "#D1FAE5", fill: "#10B981" }} isAnimationActive={false} />
                    {mode === "Payments" && <Area type="monotone" dataKey="walletServicePayments" stroke="#A78BFA" strokeWidth={2} fill="rgba(124,58,237,.08)" />}
                    {mode === "Payments" && <Area type="monotone" dataKey="walletTopups" stroke="#F59E0B" strokeWidth={2} fill="rgba(245,158,11,.08)" />}
                    {mode === "Invoices" && <Area type="monotone" dataKey="pendingInvoiceAmount" stroke="#F59E0B" strokeWidth={2} fill="rgba(245,158,11,.1)" />}
                    {mode === "Growth" && <Line type="monotone" dataKey="growthPercent" stroke="#F0ABFC" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    {mode === "Taxes" && <Area type="monotone" dataKey="gstCollected" stroke="#F59E0B" strokeWidth={2} fill="rgba(245,158,11,.1)" />}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          {data?.insights && data?.breakdowns && (
            <>
              <InsightPanel insights={data.insights} breakdowns={data.breakdowns} />
              <PaymentMixPanel breakdowns={data.breakdowns} />
            </>
          )}
        </div>
      </section>

      {/* Breakdown Tables */}
      <section className="grid gap-4 xl:grid-cols-3">
        <RevenueBreakdownTable title="Revenue by Gateway" rows={data?.breakdowns?.gateway || []} labelKey="gateway" />
        <RevenueBreakdownTable title="Revenue by Product" rows={data?.breakdowns?.product || []} labelKey="product" />
        <RevenueBreakdownTable title="Revenue by Country" rows={data?.breakdowns?.country || []} labelKey="country" />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <RevenueBreakdownTable title="Revenue by Source" rows={data?.breakdowns?.source || []} labelKey="source" />
        <RevenueBreakdownTable title="Revenue by Node" rows={data?.breakdowns?.node || []} labelKey="node" />
        <TopCustomersTable rows={data?.breakdowns?.topCustomers || []} />
      </section>

      {/* Recent Paid Invoices — Paginated */}
      <Card className="border-border/40 bg-card">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Recent Paid Invoices</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(pagination.pageSize)} onValueChange={(v) => setPagination((p) => ({ ...p, pageSize: Number(v), page: 1 }))}>
              <SelectTrigger className="w-[120px]"><SelectValue placeholder="Page size" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
              <Button variant="ghost" size="icon" onClick={() => setPagination((p) => ({ ...p, page: Math.max(1, p.page - 1) }))} disabled={pagination.page === 1}><RefreshCw className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" onClick={() => setPagination((p) => ({ ...p, page: Math.min(p.totalPages, p.page + 1) }))} disabled={pagination.page >= pagination.totalPages}><RefreshCw className="h-4 w-4 rotate-180" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead>Gateway</TableHead>
                <TableHead>Order Status</TableHead>
                <TableHead>Payment Status</TableHead>
                <TableHead>Paid At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.recentPaidInvoices?.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.invoiceNumber}</TableCell>
                  <TableCell className="text-muted-foreground">{row.customer}</TableCell>
                  <TableCell>{row.product}</TableCell>
                  <TableCell className="text-right font-medium">{money(row.amount)}</TableCell>
                  <TableCell className="text-right">{money(row.netAmount)}</TableCell>
                  <TableCell className="text-right">{money(row.tax)}</TableCell>
                  <TableCell className="text-right">{money(row.discount)}</TableCell>
                  <TableCell><Badge variant="outline">{row.gateway}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{row.orderStatus}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{row.paymentStatus}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{new Date(row.paidAt).toLocaleString("en-IN")}</TableCell>
                </TableRow>
              ))}
              {!data?.recentPaidInvoices?.length && (
                <TableRow>
                  <TableCell colSpan={11} className="py-6 text-center text-muted-foreground">No paid invoices in this range.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function KpiCard({ item, series }: { item: any; series: SeriesPoint[] }) {
  const value = item.value
  const current = typeof value === "object" ? value.current : value
  const prior = typeof value === "object" ? value.prior : 0
  const change = typeof value === "object" ? value.change : 0
  const positive = change >= 0

  return (
    <Card className="border-border/40 bg-card overflow-hidden hover:shadow-lg transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums truncate">{compactMoney(current)}</p>
          </div>
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/30 bg-muted/30 ${item.accent}`}>
            <item.icon className="h-5 w-5" />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className={cn("flex items-center gap-1 text-xs font-medium", trendClass(change))}>
            {trendIcon(change)} {pct(change)}
            {prior > 0 && <span className="ml-2 text-xs text-muted-foreground">vs prior</span>}
          </span>
          <div className="h-12 w-28 opacity-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <Line type="monotone" dataKey={item.key === "paidInvoices" ? "paidInvoices" : item.key} stroke="currentColor" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload || {}
  return (
    <div className="min-w-56 rounded-xl border border-border/30 bg-card p-3 text-xs shadow-lg">
      <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />{label}
      </div>
      <div className="text-xl font-semibold">{money(point.grossRevenue)}</div>
      <div className="mt-3 grid gap-1.5 text-muted-foreground">
        <div className="flex justify-between"><span>Net Revenue</span><span className="text-foreground">{money(point.netRevenue)}</span></div>
        <div className="flex justify-between"><span>Growth</span><span className={trendClass(point.growthPercent)}>{pct(point.growthPercent)}</span></div>
        <div className="flex justify-between"><span>Invoices</span><span className="text-foreground">{point.paidInvoices || 0}</span></div>
        <div className="flex justify-between"><span>GST</span><span className="text-foreground">{money(point.gstCollected)}</span></div>
        <div className="flex justify-between"><span>Wallet Top-ups</span><span className="text-foreground">{money(point.walletTopups)}</span></div>
        <div className="flex justify-between"><span>Refunds</span><span className="text-foreground">{money(point.refunds)}</span></div>
        <div className="flex justify-between"><span>Gateway Fees</span><span className="text-foreground">{money(point.gatewayFees)}</span></div>
      </div>
    </div>
  )
}

function InsightPanel({ insights, breakdowns }: { insights: RevenueData["insights"]; breakdowns: RevenueData["breakdowns"] }) {
  const items = [
    ["Revenue Trend", `${pct(insights.revenueTrendPercent)} vs prior bucket`, trendClass(insights.revenueTrendPercent)],
    ["Highest Sales Day", insights.highestSalesDay || "No revenue", "text-foreground"],
    ["Avg Order Value", money(insights.averageOrderValue), "text-emerald-300"],
    ["Top Payment Source", insights.topPaymentSource || "No payments", "text-purple-300"],
    ["Payment Success", `${insights.paymentSuccessRate.toFixed(1)}%`, "text-blue-300"],
    ["Wallet Top-ups", money(breakdowns.walletTopups), "text-purple-300"],
    ["Gateway Fees", money(breakdowns.gatewayFees), "text-amber-300"],
    ["Refunds", money(breakdowns.refunds), "text-rose-300"],
    ["Active Services", String(breakdowns.failedPayments + breakdowns.failedPaymentAmount), "text-amber-300"],
  ]
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader><CardTitle>Revenue Intelligence</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {items.map(([label, value, color]) => (
          <div key={label} className="rounded-lg border border-border/30 bg-muted/30 px-3 py-2">
            <span className="text-sm text-muted-foreground">{label}</span>
            <div className={cn("text-sm font-medium", color)}>{value}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PaymentMixPanel({ breakdowns }: { breakdowns: RevenueData["breakdowns"] }) {
  const rows = [
    { name: "Gateway service", value: breakdowns.gatewayFees, color: "#14B8A6" },
    { name: "Wallet service", value: breakdowns.refunds, color: "#A78BFA" },
    { name: "Wallet top-ups", value: breakdowns.walletTopups, color: "#F59E0B" },
  ].filter((item) => item.value > 0)
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader><CardTitle>Payment Mix</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[140px_1fr]">
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows.length ? rows : [{ name: "No payments", value: 1 }]} dataKey="value" innerRadius={42} outerRadius={64} paddingAngle={4}>
                {(rows.length ? rows : [{ name: "No payments" }]).map((_, index) => (
                  <Cell key={index} fill={rows.length ? rows[index].color : "rgba(148,163,184,.25)"} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-2">
          {rows.length ? rows.map((row) => (
            <div key={row.name} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />{row.name}</span>
              <span className="font-medium">{compactMoney(row.value)}</span>
            </div>
          )) : <p className="text-sm text-muted-foreground">No payment mix in this range.</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function RevenueBreakdownTable({ title, rows, labelKey }: { title: string; rows: Array<{ [key: string]: any }>; labelKey: string }) {
  const max = Math.max(...rows.map((r) => Number(r.amount || 0)), 1)
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {rows.slice(0, 8).map((row, index) => (
          <div key={`${row[labelKey]}-${index}`}>
            <div className="mb-1 flex justify-between text-sm"><span className="truncate">{row[labelKey]}</span><span className="font-medium ml-4">{compactMoney(row.amount)}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/20">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(6, (Number(row.amount || 0) / max) * 100)}%` }} />
            </div>
          </div>
        ))}
        {!rows.length && <p className="py-4 text-sm text-muted-foreground">No revenue in this range.</p>}
      </CardContent>
    </Card>
  )
}

function TopCustomersTable({ rows }: { rows: Array<{ customer: string; amount: number }> }) {
  return (
    <Card className="border-border/40 bg-card">
      <CardHeader><CardTitle>Top Customers</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 10).map((row, index) => (
              <TableRow key={`${row.customer}-${index}`}>
                <TableCell className="truncate max-w-[200px]">{row.customer}</TableCell>
                <TableCell className="text-right font-medium">{money(row.amount)}</TableCell>
              </TableRow>
            ))}
            {!rows.length && <TableRow><TableCell colSpan={2} className="py-6 text-center text-muted-foreground">No customer revenue in this range.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function EmptyRevenueState() {
  return (
    <div className="relative z-10 flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border/30 bg-muted/30 text-muted-foreground">
          <CircleDollarSign className="h-6 w-6" />
        </div>
        <h3 className="mt-4 text-lg font-semibold">No paid revenue in this range</h3>
        <p className="mt-2 text-sm text-muted-foreground">Paid service payments will appear here with FinOps trend, source, invoice, and gateway analytics.</p>
      </div>
    </div>
  )
}

function RevenueSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
        {Array.from({ length: 10 }).map((_, index) => <div key={index} className="border-border/40 bg-card h-28 rounded-xl" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.8fr)]">
        <div className="border-border/40 bg-card h-[440px] rounded-xl" />
        <div className="grid gap-4">
          <div className="border-border/40 bg-card h-80 rounded-xl" />
          <div className="border-border/40 bg-card h-80 rounded-xl" />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-5">
      <div className="flex items-center gap-3">
        <CircleDollarSign className="h-5 w-5 text-red-400" />
        <div>
          <h3 className="font-semibold text-red-200">Unable to load revenue analytics</h3>
          <p className="text-sm text-red-300">{message}</p>
        </div>
      </div>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        <RefreshCw className="mr-2 h-4 w-4" />Retry
      </Button>
    </div>
  )
}