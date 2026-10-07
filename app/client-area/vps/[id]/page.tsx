"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import { customerDatabaseRepairMessage } from "@/lib/client/database-error"
import { startPaymentRedirect } from "@/lib/client/payment-redirect"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import dynamic from "next/dynamic"
import { toast } from "sonner"
import {
  BarChart3,
  Clipboard,
  CreditCard,
  Eye,
  EyeOff,
  FileText,
  Gauge,
  Globe2,
  HardDrive,
  KeyRound,
  MemoryStick,
  Monitor,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  Tag,
  UserRound,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Container } from "@/components/layout/container"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSmartPolling, formatLastUpdated } from "@/lib/hooks/use-smart-polling"
import { CopyableIp } from "@/components/copyable-ip"
import type { VpsMetricPoint } from "@/components/client/vps-live-usage-charts"
import { deriveCounterRates, formatByteRateDecimal, formatBytesDecimal, formatGbDecimal, formatPercent, formatRateDecimal } from "@/lib/format-units"
import { formatCurrency } from "@/lib/currency-format"
import { cn } from "@/lib/utils"

const VpsLiveUsageCharts = dynamic(
  () => import("@/components/client/vps-live-usage-charts").then((mod) => mod.VpsLiveUsageCharts),
  {
    ssr: false,
    loading: () => <div className="h-72 rounded-md border border-border/40 bg-background/60" />,
  },
)

type VpsStatus = {
  success?: boolean
  status: string
  displayStatus?: string
  provisioningStatus?: string
  currentStep?: string
  hostname?: string
  displayTag?: string | null
  name?: string | null
  ipAddress?: string | null
  plan?: string
  os?: string | null
  runtimeStatus?: string | null
  createdAt?: string
  username?: string | null
  access?: { isWindows?: boolean; sshEnabled?: boolean; rdpEnabled?: boolean }
  credentialVerification?: { status?: string | null; label?: string | null; checkedAt?: string | null; verifiedAt?: string | null }
  console?: { available?: boolean; label?: string; access?: { enabled?: boolean; terminal?: boolean; graphical?: boolean } }
  resources?: { cpuCores?: number | null; ramGb?: number | null; diskGb?: number | null; bandwidthTb?: number | null; bandwidthLabel?: string | null }
  storage?: {
    diskGb?: number | null
    displayName?: string | null
    primaryDisk?: { id: string; displayName: string; sizeGb: number; storagePoolName?: string | null } | null
    disks?: Array<{ id: string; displayName: string; sizeGb: number; isPrimary: boolean; status: string; storagePoolName?: string | null }>
    enterprise?: { tier?: string | null; technology?: string | null; health?: string | null }
  }
  infrastructure?: { infrastructure?: string; region?: string; network?: string; status?: string }
  renewalDueAt?: string | null
  nextRenewalAt?: string | null
  suspendAt?: string | null
  deletionAt?: string | null
  renewalAmount?: number | null
  dueInvoice?: { id: string; invoiceNumber: string; status: string; totalAmount: number; currency?: string | null; dueDate: string } | null
  cpuPercent?: number
  cpuCores?: number
  ramUsedBytes?: number
  ramTotalBytes?: number
  ramPercent?: number
  diskUsedBytes?: number
  diskTotalBytes?: number
  diskPercent?: number
  uptime?: number
  expiry?: { state?: string; daysToExpire?: number | null; expiresAt?: string | null; expired?: boolean }
  daysToExpire?: number | null
  expiresAt?: string | null
  deadlineAt?: string | null
  diskUsage?: { usedGb?: number | null; freeGb?: number | null; totalGb?: number | null; percent?: number | null; reported?: boolean; checkedAt?: string | null; source?: string | null; freshness?: { state?: "CURRENT" | "STALE" | "UNAVAILABLE"; source?: string | null; lastUpdatedAt?: string | null; errorCode?: string | null; error?: string | null } }
  netin?: number
  netout?: number
  overloaded?: boolean
  metricsFreshness?: Record<string, { state?: "CURRENT" | "STALE" | "UNAVAILABLE"; lastUpdatedAt?: string | null; source?: string | null }>
  monitoringStatus?: string | null
  guestAgentStatus?: string | null
  // Deliberately absent: the Proxmox node name, the VMID, and the internal
  // infrastructure ids. The customer's page shows the server tag, the address,
  // the region, the status, uptime, days to expiry, the OS and the MAC — nothing
  // about how or where it is hosted internally.
  template?: { id?: string; name?: string | null; family?: string | null; version?: string | null } | null
  macAddress?: string | null
  network?: { gateway?: string | null; cidr?: number | null; dns?: string | null; bridge?: string | null; macAddress?: string | null; vlanTag?: number | null; model?: string | null; lastSyncedAt?: string | null; source?: string | null }
  firewall?: { available?: boolean; rules?: Array<Record<string, unknown>>; status?: string | null }
  snapshots?: { count?: number; items?: Array<{ id?: string; name?: string | null; snapname?: string | null; description?: string | null; status?: string | null; createdAt?: string | null }> }
  backups?: { count?: number; items?: Array<{ id?: string; status?: string | null; schedule?: string | null; fileName?: string | null; sizeBytes?: number | null; startedAt?: string | null; finishedAt?: string | null; completedAt?: string | null; createdAt?: string | null; durationMs?: number | null; error?: string | null }> }
  provisionLogs?: Array<{ id?: string; createdAt?: string; level?: string; title?: string; message?: string } | null>
}

type MetricPoint = VpsMetricPoint
type LiveConnectionState = "connected" | "reconnecting" | "offline"

type BandwidthSummary = {
  rxRateBps?: number
  txRateBps?: number
  monthlyTotalBytes?: number
  includedBytes?: number
  overLimit?: boolean
  throttled?: boolean
  currentRateLimit?: number | null
  throttleRateMbps?: number | null
  cycleEndsAt?: string | null
  freshness?: { state?: string; lastUpdatedAt?: string | null; source?: string | null }
}

const provisioningStates = new Set(["CREATING", "QUEUED", "CLONING_TEMPLATE", "RESIZING_DISK", "ASSIGNING_IP", "APPLYING_CLOUD_INIT", "STARTING_VM", "VERIFYING_VM", "UPGRADE_QUEUED", "UPDATING_CONFIG", "REINSTALLING"])
const panelActionButtonClass = "h-9 rounded-md px-3 text-sm gap-2"
const iconActionButtonClass = "h-8 w-8 rounded-md"

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString("en-IN", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
}

function formatUptime(seconds?: number | null) {
  const value = Number(seconds || 0)
  if (!Number.isFinite(value) || value <= 0) return null
  const days = Math.floor(value / 86400)
  const hours = Math.floor((value % 86400) / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function expiryStateOf(status?: VpsStatus | null) {
  const state = status?.expiry?.state || ""
  const days = status?.expiry?.daysToExpire
  if (state === "expired" || status?.expiry?.expired) return "expired"
  if (state === "expiring_soon" || (days !== null && days !== undefined && days <= 7)) return "expiring_soon"
  return "active"
}

/**
 * Metric freshness, expressed the way an operator thinks about it.
 *
 * The raw wire value is still `CURRENT` / `STALE` / `UNAVAILABLE` and stays
 * internal to this module: the customer sees when the number was measured, not
 * a transport-state badge. `neverMeasured` is the important distinction - it is
 * the only case where we have nothing to show at all.
 */
function freshnessLabel(item?: { state?: string; lastUpdatedAt?: string | null }) {
  const state = String(item?.state || "UNAVAILABLE").toUpperCase()
  const stamp = item?.lastUpdatedAt ? String(item.lastUpdatedAt) : ""
  const measuredAt = stamp && !Number.isNaN(new Date(stamp).getTime()) ? formatDate(stamp, true) : ""
  if (!measuredAt) return { state, updated: "Not collected yet", neverMeasured: true }
  if (state === "CURRENT") return { state, updated: `Updated ${measuredAt}`, neverMeasured: false }
  return { state, updated: `Last recorded ${measuredAt}`, neverMeasured: false }
}

/**
 * Disk freshness. Same rule as every other metric: a number with a timestamp,
 * or an honest "not collected yet". Never a stale badge.
 *
 * A stopped server keeps its last real sample, so "Last recorded ..." is the
 * normal case there and is not a fault.
 */
function diskFreshnessLabel(item: any, running = false) {
  const f = item?.freshness || item
  const state = String(f?.state || "UNAVAILABLE").toUpperCase()
  const stamp = f?.lastUpdatedAt || f?.checkedAt || ""
  const measuredAt = stamp && !Number.isNaN(new Date(stamp).getTime()) ? formatDate(String(stamp), true) : ""
  const source = f?.source || item?.source || "unknown"
  const sourceLabel = source === "guest-agent" || source === "template-collector" || source === "cached" || source === "guest-filesystem"
    ? "measured inside the server"
    : source === "last-known"
      ? "last known value"
      : "measured inside the server"
  const checked = !measuredAt
    ? "Not collected yet"
    : state === "CURRENT"
      ? running
        ? `Last checked ${measuredAt} · ${sourceLabel}`
        : `Last recorded before shutdown · ${measuredAt}`
      : `Last recorded ${measuredAt} · ${sourceLabel}`
  return { state, checked, source, neverMeasured: !measuredAt, errorCode: f?.errorCode, error: f?.error }
}

function metricUnavailable(item?: { state?: string; source?: string | null }) {
  const state = String(item?.state || "").toUpperCase()
  const source = String(item?.source || "").toLowerCase()
  return state === "UNAVAILABLE" || source === "unavailable"
}

function normalizeMetricPoint(point: any): MetricPoint | null {
  const recordedAt = point?.recordedAt && !Number.isNaN(new Date(point.recordedAt).getTime()) ? point.recordedAt : new Date().toISOString()
  return {
    recordedAt,
    cpuPercent: Number(point?.cpuPercent || 0),
    ramPercent: Number(point?.ramPercent || 0),
    diskPercent: Number(point?.diskPercent || 0),
    diskReadBytes: Number(point?.diskReadBytes || 0),
    diskWriteBytes: Number(point?.diskWriteBytes || 0),
    networkInBytes: Number(point?.networkInBytes || 0),
    networkOutBytes: Number(point?.networkOutBytes || 0),
  }
}

function mergeMetrics(current: MetricPoint[], incoming: any[]) {
  const merged = new Map(current.map((point) => [point.recordedAt, point]))
  for (const item of incoming) {
    const point = normalizeMetricPoint(item)
    if (point) merged.set(point.recordedAt, point)
  }
  return Array.from(merged.values())
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
    .slice(-720)
}

function mergeLogs(current: Array<{ id: string; createdAt: string; level: string; title?: string; message: string }>, incoming: any[]) {
  const merged = new Map(current.map((log) => [log.id, log]))
  for (const log of incoming) {
    if (!log?.id) continue
    merged.set(String(log.id), {
      id: String(log.id),
      createdAt: log.createdAt || new Date().toISOString(),
      level: log.level || "info",
      title: log.title,
      message: log.message || "",
    })
  }
  return Array.from(merged.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200)
}

function stateOf(status?: VpsStatus | null) {
  const raw = String(status?.status || "").toUpperCase()
  const runtime = String(status?.runtimeStatus || "").toLowerCase()
  const prov = String(status?.provisioningStatus || status?.currentStep || "").toUpperCase()
  if (["FAILED", "ERROR", "START_FAILED", "REPAIR_NEEDED"].includes(raw)) return "error"
  if (["SUSPENDED", "PENDING_TERMINATION"].includes(raw)) return "suspended"
  if (raw === "STOPPED" || runtime === "stopped") return "stopped"
  // An active VM must look active even if a stale provisioning row says
  // STARTING_VM: Proxmox + guest verification own the truth here.
  if (raw === "ACTIVE" || raw === "RUNNING" || raw === "OVERLOADED" || runtime === "running") return "running"
  if (provisioningStates.has(raw) || provisioningStates.has(prov)) return "provisioning"
  return status ? "stopped" : "loading"
}

/**
 * Customer-facing service state.
 *
 * Deliberately plain: the customer cares whether their server is usable. No
 * `CURRENT` / `RUNNING` / `LIVE` transport vocabulary, and no `Provisioning`
 * once the server exists - that was the original bug, where a server that was
 * running and guest-verified still read "Provisioning" because of a stale order
 * row. Power state is shown separately and labelled as such.
 */
function stateLabel(state: string) {
  if (state === "running") return "Active"
  if (state === "stopped") return "Stopped"
  if (state === "provisioning") return "Setting up"
  if (state === "suspended") return "Suspended"
  if (state === "error") return "Needs attention"
  return "Loading"
}

function statusClass(state: string) {
  if (state === "running") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
  if (state === "provisioning") return "border-sky-400/30 bg-sky-400/10 text-sky-200"
  if (state === "suspended") return "border-orange-400/30 bg-orange-400/10 text-orange-200"
  if (state === "error") return "border-red-400/30 bg-red-400/10 text-red-200"
  return "border-zinc-400/30 bg-zinc-400/10 text-zinc-200"
}

export default function VPSControlPanel() {
  const { id } = useParams()
  const [status, setStatus] = useState<VpsStatus | null>(null)
  const [metrics, setMetrics] = useState<MetricPoint[]>([])
  const [range, setRange] = useState<"1h" | "24h" | "48h">("1h")
  const [, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [logs, setLogs] = useState<Array<{ id: string; createdAt: string; level: string; title?: string; message: string }>>([])
  const [liveState, setLiveState] = useState<LiveConnectionState>("reconnecting")
  const [bandwidth, setBandwidth] = useState<BandwidthSummary | null>(null)
  const statusRequestRef = useRef(0)
  const pendingStatusRef = useRef<AbortController | null>(null)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [upgradeForm, setUpgradeForm] = useState({ cpuCores: "", ramGb: "", diskGb: "", termMonths: "1", paymentMethod: "gateway" as "gateway" | "wallet" })
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ password: "", confirmPassword: "" })
  const [credentials, setCredentials] = useState<{ ip?: string | null; username?: string | null; password?: string | null; passwordAvailable?: boolean; hostname?: string | null } | null>(null)
  const [showCredentialPassword, setShowCredentialPassword] = useState(false)
  const [rotationStatus, setRotationStatus] = useState<{ state: string; lastChangedAt: string | null; method?: string; username?: string | null } | null>(null)
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const supplementalFetchRef = useRef({ logsAt: 0, bandwidthAt: 0, metricsAt: 0 })

  const currentState = stateOf(status)
  const isRunning = currentState === "running"
  const isStopped = currentState === "stopped"
  const isProvisioning = currentState === "provisioning"
  const isLocked = currentState === "suspended" || currentState === "error" || isProvisioning
  const proxmoxActionsAvailable = Boolean(status?.console?.available)
  const metricSeries = useMemo(() => deriveCounterRates(metrics, ["diskReadBytes", "diskWriteBytes", "networkInBytes", "networkOutBytes"]) as MetricPoint[], [metrics])
  const latestMetric = metricSeries[metricSeries.length - 1] as (MetricPoint & Record<string, number>) | undefined
  const networkDownRate = latestMetric?.networkInBytesRate || 0
  const networkUpRate = latestMetric?.networkOutBytesRate || 0
  const bandwidthTotal = bandwidth?.monthlyTotalBytes ?? 0
  const bandwidthIncluded = bandwidth?.includedBytes ?? 0
  const bandwidthPercent = bandwidthIncluded > 0 ? Math.min(100, Math.max(0, (bandwidthTotal / bandwidthIncluded) * 100)) : 0
  const networkQuality = bandwidth?.throttled ? "Limited" : liveState === "offline" ? "Offline" : liveState === "connected" ? "Good" : "Checking"
  const bandwidthFreshness = freshnessLabel(bandwidth?.freshness)
  const diskReadRate = latestMetric?.diskReadBytesRate || 0
  const diskWriteRate = latestMetric?.diskWriteBytesRate || 0

  const fetchStatus = useCallback(async () => {
    if (!id || typeof window === "undefined") return
    const requestId = ++statusRequestRef.current
    const controller = new AbortController()
    pendingStatusRef.current?.abort()
    pendingStatusRef.current = controller
    try {
      const res = await fetch(`/api/client/vps/${id}/status`, { cache: "no-store", signal: controller.signal })
      const data = await readJsonResponse<any>(res)
      if (requestId !== statusRequestRef.current) return
      if (!res.ok) throw new Error(data?.error || "Unable to load server state. Please retry.")
      setStatus(data)
      sessionStorage.setItem(`vps-status:${id}`, JSON.stringify(data))
      setError(null)
    } catch (err: any) {
      if (err?.name === "AbortError") return
      if (requestId !== statusRequestRef.current) return
      setError(err?.message || "Unable to load server state. Please retry.")
    } finally {
      if (requestId === statusRequestRef.current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    void fetchStatus()
  }, [id, fetchStatus])

  const fetchMetrics = useCallback(async () => {
    if (!id) return
    const res = await fetch(`/api/client/vps/${id}/metrics?range=${range}`, { cache: "no-store" })
    const data = await readJsonResponse<any>(res)
    if (res.ok && Array.isArray(data.points)) {
      setMetrics((current) => mergeMetrics(current, data.points))
    }
  }, [id, range])

  const fetchBandwidth = useCallback(async () => {
    if (!id) return
    const res = await fetch(`/api/client/vps/${id}/bandwidth?period=month`, { cache: "no-store" })
    const data = await readJsonResponse<any>(res)
    if (res.ok && data?.summary) setBandwidth(data.summary)
  }, [id])

  const fetchDiskUsage = useCallback(async () => {
    if (!id) return
    const res = await fetch(`/api/client/vps/${id}/disk-usage`, { cache: "no-store" })
    const data = await readJsonResponse<any>(res)
    if (res.ok && data?.diskUsage) {
      setStatus((current) => current ? { ...current, diskUsage: data.diskUsage } : current)
    }
  }, [id])

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/client/vps/${id}/logs`, { cache: "no-store" })
      const data = await readJsonResponse<any>(res)
      if (res.ok) setLogs((current) => mergeLogs(current, (data.logs || []).map((log: any) => ({ id: log.id, createdAt: log.createdAt, level: log.level, title: log.title, message: log.message }))))
    } catch {
      // Activity is supplemental; keep the page usable if it fails.
    }
  }, [id])

  const { lastUpdatedAt } = useSmartPolling(async () => {
    await fetchStatus()
    const now = Date.now()
    const supplemental: Array<Promise<void>> = []
    if (now - supplementalFetchRef.current.logsAt > 20_000) {
      supplementalFetchRef.current.logsAt = now
      supplemental.push(fetchLogs())
    }
    if (now - supplementalFetchRef.current.bandwidthAt > 30_000) {
      supplementalFetchRef.current.bandwidthAt = now
      supplemental.push(fetchBandwidth())
    }
    // Poll disk usage every 30s ONLY while VM is running (lightweight endpoint)
    if (isRunning && now - supplementalFetchRef.current.metricsAt > 30_000) {
      supplementalFetchRef.current.metricsAt = now
      supplemental.push(fetchDiskUsage())
    }
    // Full metrics (CPU/RAM/Network) only when live stream is not connected
    if (isRunning && liveState !== "connected" && now - supplementalFetchRef.current.metricsAt > 15_000) {
      supplementalFetchRef.current.metricsAt = now
      supplemental.push(fetchMetrics())
    }
    if (supplemental.length) await Promise.all(supplemental)
  }, isRunning || isProvisioning, [id, range, isRunning, isProvisioning, liveState])

  useEffect(() => {
    if (!id || status || typeof window === "undefined") return
    const cached = sessionStorage.getItem(`vps-status:${id}`)
    if (!cached) return
    try {
      setStatus(JSON.parse(cached))
      setLoading(false)
    } catch {
      sessionStorage.removeItem(`vps-status:${id}`)
    }
  }, [id, status])

  useEffect(() => {
    void fetchBandwidth()
  }, [fetchBandwidth])

  useEffect(() => {
    if (!id || !("EventSource" in window)) {
      setLiveState("offline")
      return
    }
    let closed = false
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
    const markStale = () => {
      if (!closed) setLiveState("reconnecting")
    }
    const refreshHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      heartbeatTimer = setTimeout(markStale, 15000)
    }
    const source = new EventSource(`/api/client/vps/${id}/live/stream`)
    source.addEventListener("ready", () => {
      setLiveState("connected")
      refreshHeartbeat()
    })
    source.addEventListener("heartbeat", () => {
      setLiveState("connected")
      refreshHeartbeat()
    })
    source.addEventListener("metrics", (event) => {
      const rows = JSON.parse((event as MessageEvent).data)
      setLiveState("connected")
      refreshHeartbeat()
      setMetrics((current) => mergeMetrics(current, Array.isArray(rows) ? rows : [rows]))
    })
    source.addEventListener("logs", (event) => {
      const rows = JSON.parse((event as MessageEvent).data)
      setLiveState("connected")
      refreshHeartbeat()
      setLogs((current) => mergeLogs(current, Array.isArray(rows) ? rows : [rows]))
    })
    source.onerror = () => {
      setLiveState((current) => current === "offline" ? "offline" : "reconnecting")
    }
    return () => {
      closed = true
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      source.close()
    }
  }, [id])

  async function performAction(action: string) {
    setLoadingAction(action)
    try {
      const res = await fetch(`/api/client/vps/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await readJsonResponse<any>(res) || {}
      if (!res.ok) throw new Error(customerDatabaseRepairMessage(data))
      toast.success(`Server ${action === "reboot" ? "restart" : action} requested`)
      await fetchStatus()
    } catch (err: any) {
      toast.error(customerDatabaseRepairMessage(err?.message || "Action failed"))
    } finally {
      setLoadingAction(null)
    }
  }

  async function renewNow() {
    try {
      const res = await fetch(`/api/client/vps/${id}/renew`, { method: "POST" })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data.error || "Unable to start renewal")
      if (data.redirectUrl) window.location.href = data.redirectUrl
      else toast.success(data.message || "Renewal request created")
    } catch (err: any) {
      toast.error(err.message || "Unable to renew")
    }
  }

  async function fetchCredentials(reveal = false) {
    const res = await fetch(`/api/client/vps/${id}/credentials${reveal ? "?reveal=1" : ""}`, { cache: "no-store" })
    const data = await readJsonResponse<any>(res)
    if (!res.ok) throw new Error(data?.error || "Unable to load credentials")
    return data
  }

  async function revealCredentials() {
    if (showCredentialPassword) {
      setShowCredentialPassword(false)
      setCredentials((current) => current ? { ...current, password: null } : current)
      return
    }
    try {
      const data = await fetchCredentials(true)
      setCredentials(data)
      setShowCredentialPassword(true)
    } catch (err: any) {
      toast.error(err?.message || "Unable to load credentials")
    }
  }

  async function copySecret(value?: string | null, label = "Copied") {
    if (!value) {
      toast.error("Nothing to copy")
      return
    }
    await navigator.clipboard.writeText(value)
    toast.success(label)
  }

  async function copyPassword() {
    try {
      const data = showCredentialPassword && credentials?.password ? credentials : await fetchCredentials(true)
      const password = String(data?.password || "")
      if (!password) return toast.error("Password is not available")
      await navigator.clipboard.writeText(password)
      toast.success("Password copied")
      if (showCredentialPassword) {
        setCredentials(data)
      } else {
        setCredentials((current) => ({
          ...(current || {}),
          ...data,
          password: null,
          passwordAvailable: data?.passwordAvailable ?? Boolean(password),
        }))
      }
    } catch (err: any) {
      toast.error(err?.message || "Unable to copy password")
    }
  }

  function openUpgrade() {
    setUpgradeForm({
      cpuCores: String(status?.resources?.cpuCores || ""),
      ramGb: String(status?.resources?.ramGb || ""),
      diskGb: String(status?.resources?.diskGb || status?.storage?.diskGb || ""),
      termMonths: String((status as any)?.billingLabels?.billingCycle === "yearly" ? 12 : 1),
      paymentMethod: "gateway",
    })
    setUpgradeOpen(true)
  }

  async function requestUpgrade() {
    const cpuCores = Number(upgradeForm.cpuCores)
    const ramGb = Number(upgradeForm.ramGb)
    const diskGb = Number(upgradeForm.diskGb)
    const termMonths = Number(upgradeForm.termMonths)
    const currentCpu = Number(status?.resources?.cpuCores || 0)
    const currentRam = Number(status?.resources?.ramGb || 0)
    const currentDisk = Number(status?.resources?.diskGb || status?.storage?.diskGb || 0)
    if (![cpuCores, ramGb, diskGb].every((value) => Number.isFinite(value) && value > 0)) return toast.error("Enter valid CPU, RAM, and disk values")
    if (cpuCores < currentCpu || ramGb < currentRam) return toast.error("Upgrade values cannot be lower than current resources")
    if (diskGb < currentDisk) return toast.error("Disk size cannot be lower than current resources")
    if (cpuCores === currentCpu && ramGb === currentRam && diskGb === currentDisk) return toast.error("Choose at least one higher resource value")
    try {
      const res = await fetch(`/api/client/vps/${id}/upgrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpuCores, ramGb, diskGb, termMonths, paymentMethod: upgradeForm.paymentMethod }),
      })
      const data = await readJsonResponse<any>(res) || {}
      if (!res.ok) throw new Error(data.error || "Upgrade failed")
      await startPaymentRedirect(data)
      setUpgradeOpen(false)
      await fetchStatus()
    } catch (err: any) {
      toast.error(err.message || "Upgrade failed")
    }
  }

  async function fetchRotationStatus() {
    if (!id) return
    try {
      const res = await fetch(`/api/client/vps/${id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotation_status" }),
        cache: "no-store" as RequestCache,
      })
      const data = await readJsonResponse<any>(res)
      if (res.ok && data?.success) setRotationStatus(data.rotation || null)
    } catch {
      // Rotation state is supplemental; keep the page usable if it fails.
    }
  }

  async function changePassword() {
    const password = passwordForm.password
    if (password.length < 12) return toast.error("Password must be at least 12 characters")
    if (password !== passwordForm.confirmPassword) return toast.error("Password confirmation does not match")
    setLoadingAction("password")
    try {
      const res = await fetch(`/api/client/vps/${id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate", password, confirmPassword: password }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data?.rotation?.message || data?.error || "Password change failed")
      setPasswordForm({ password: "", confirmPassword: "" })
      setShowCredentialPassword(false)
      setCredentials((current) => (current ? { ...current, password: null } : current))
      await fetchRotationStatus()
      toast.success(data?.rotation?.message || "Password updated inside the guest and stored credential synced.")
      setPasswordOpen(false)
    } catch (err: any) {
      toast.error(err.message || "Password change failed", { duration: 8000 })
    } finally {
      setLoadingAction(null)
    }
  }

  useEffect(() => {
    if (isRunning) void fetchRotationStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning])

  const storageDisks = useMemo(() => {
    if (status?.storage?.disks?.length) return status.storage.disks
    return [{
      id: "primary",
      displayName: status?.storage?.primaryDisk?.displayName || "disk1",
      sizeGb: status?.storage?.primaryDisk?.sizeGb || status?.storage?.diskGb || status?.resources?.diskGb || 0,
      isPrimary: true,
      status: "ACTIVE",
      storagePoolName: status?.storage?.primaryDisk?.storagePoolName || status?.storage?.displayName || null,
    }]
  }, [status])

  const upgradeQuote = useMemo(() => {
    const currentCpu = Number(status?.resources?.cpuCores || 0)
    const currentRam = Number(status?.resources?.ramGb || 0)
    const currentDisk = Number(status?.resources?.diskGb || status?.storage?.diskGb || 0)
    const nextCpu = Number(upgradeForm.cpuCores || currentCpu)
    const nextRam = Number(upgradeForm.ramGb || currentRam)
    const nextDisk = Number(upgradeForm.diskGb || currentDisk)
    const term = Math.max(1, Number(upgradeForm.termMonths || 1))
    const currentMonthly = currentCpu * 150 + currentRam * 70 + currentDisk * 7
    const newMonthly = nextCpu * 150 + nextRam * 70 + nextDisk * 7
    const difference = Math.max(0, newMonthly - currentMonthly)
    const due = status?.renewalDueAt || status?.nextRenewalAt
    const dueAt = due ? new Date(due).getTime() : NaN
    const remainingRatio = Number.isFinite(dueAt) ? Math.max(0, Math.min(1, (dueAt - Date.now()) / (30 * 86400000))) : 1
    const proratedAmount = Number((difference * remainingRatio).toFixed(2))
    const renewalAmount = Number((newMonthly * term).toFixed(2))
    const percent = (from: number, to: number) => from > 0 ? Math.round(((to - from) / from) * 100) : to > 0 ? 100 : 0
    return {
      currentCpu,
      currentRam,
      currentDisk,
      nextCpu,
      nextRam,
      nextDisk,
      term,
      currentMonthly,
      newMonthly,
      difference,
      proratedAmount: Math.max(1, proratedAmount || difference),
      renewalAmount,
      cpuIncrease: percent(currentCpu, nextCpu),
      ramIncrease: percent(currentRam, nextRam),
      diskIncrease: percent(currentDisk, nextDisk),
    }
  }, [status, upgradeForm])

  if (error && !status) {
    return (
      <Container className="py-8">
        <Card className="border-red-400/20 bg-red-400/5">
          <CardContent className="flex flex-col items-start gap-4 p-6">
            <div>
              <h1 className="text-xl font-semibold">Unable to load server state.</h1>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              <p className="mt-1 text-sm text-muted-foreground">Service information is still available from the provider even when live telemetry is temporarily unavailable.</p>
            </div>
            <Button onClick={fetchStatus} className="gap-2"><RefreshCw className="h-4 w-4" />Retry</Button>
          </CardContent>
        </Card>
      </Container>
    )
  }

  async function saveServerTag() {
    setTagSaving(true)
    setTagError(null)
    try {
      const body = await readJsonResponse(
        await fetch(`/api/client/vps/${id}/tag`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serverTag: tagDraft }),
        }),
      )
      if (!body?.success) throw new Error(body?.error || "Failed to update Server Tag.")
      const savedTag = String(body.serverTag || "")
      setStatus((prev) => (prev ? { ...prev, displayTag: savedTag, name: savedTag || prev.name } : prev))
      setTagDialogOpen(false)
      toast.success("Server Tag updated")
    } catch (e: any) {
      setTagError(e?.message || "Failed to update Server Tag.")
    } finally {
      setTagSaving(false)
    }
  }

  async function openTagDialog() {
    setTagDraft(status?.displayTag || "")
    setTagError(null)
    setTagDialogOpen(true)
  }

  return (
    <Container className="overflow-x-hidden py-3">
      <div className="space-y-4">
        <Card className="border-border/40 bg-background/80">
          <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{status?.name || status?.hostname || "Cloud server"}</h1>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(currentState)} ${currentState === "provisioning" ? "animate-pulse" : ""}`}>
                  {stateLabel(currentState)}
                </span>
              </div>
              <div className="grid gap-x-5 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-5">
                <span>IP <CopyableIp ipAddress={status?.ipAddress} /></span>
                <span>Region India</span>
                <span>{status?.plan || "Cloud VPS"}</span>
                <span>{status?.resources?.cpuCores || status?.cpuCores || "-"} vCPU / {status?.resources?.ramGb || "-"} GB RAM</span>
                <span>Uptime {formatUptime(status?.uptime) || "-"}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton icon={Play} label="Start" onClick={() => performAction("start")} busy={loadingAction === "start"} disabled={!proxmoxActionsAvailable || !isStopped || isLocked} />
              <ActionButton icon={Power} label="Stop" onClick={() => performAction("stop")} busy={loadingAction === "stop"} disabled={!proxmoxActionsAvailable || !isRunning || isLocked} />
              <ActionButton icon={RotateCcw} label="Restart" onClick={() => performAction("reboot")} busy={loadingAction === "reboot"} disabled={!proxmoxActionsAvailable || !isRunning || isLocked} />
              {status?.console?.available !== false ? (
                <Button asChild size="sm" variant="outline" className={panelActionButtonClass} title="Open console">
                  <Link className="relative z-10 pointer-events-auto" href={`/client-area/vps/${id}/console`}><Monitor className="h-4 w-4" />Console</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled className={panelActionButtonClass} title="Console unavailable until this VM is assigned to a reachable node">
                  <Monitor className="h-4 w-4" />Console
                </Button>
              )}
              <Button asChild size="sm" variant="outline" className={panelActionButtonClass}><Link className="relative z-10 pointer-events-auto" href="/client-area/backups">Backups</Link></Button>
              <Button asChild size="sm" variant="outline" className={panelActionButtonClass}><Link className="relative z-10 pointer-events-auto" href="/client-area/snapshots">Snapshots</Link></Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <ResourceCard title="CPU" icon={Gauge} value={metricUnavailable(status?.metricsFreshness?.cpu) ? "Not collected yet" : formatPercent(status?.cpuPercent)} subvalue={`${status?.resources?.cpuCores || status?.cpuCores || "-"} cores`} freshness={status?.metricsFreshness?.cpu} metricKey="cpuPercent" data={metricSeries} paused={!isRunning} accent="#22c55e" />
              <ResourceCard title="RAM" icon={MemoryStick} value={metricUnavailable(status?.metricsFreshness?.memory) ? "Not collected yet" : `${formatBytesDecimal(status?.ramUsedBytes, { fallback: "0 MB" })} / ${formatBytesDecimal(status?.ramTotalBytes, { fallback: "0 MB" })}`} subvalue={!metricUnavailable(status?.metricsFreshness?.memory) ? formatPercent(status?.ramPercent) : ""} freshness={status?.metricsFreshness?.memory} metricKey="ramPercent" data={metricSeries} paused={!isRunning} accent="#38bdf8" progress={status?.ramPercent} />
              {(() => {
                const du = status?.diskUsage
                const diskLabel = diskFreshnessLabel(du, isRunning)
                const usedGb = du?.usedGb
                const totalGb = du?.totalGb
                const freeGb = du?.freeGb
                // Disk usage is guest truth. If the guest has never reported,
                // say so once. A stale sample still shows, labelled as last
                // recorded - never zeroed and never called "offline".
                const hasSample = usedGb !== null && usedGb !== undefined && !metricUnavailable(du)
                return (
                  <ResourceCard
                    title="Disk"
                    icon={HardDrive}
                    value={hasSample ? `${formatGbDecimal(usedGb)} used` : "Not collected yet"}
                    subvalue={hasSample
                      ? `${formatGbDecimal(freeGb, "0 GB")} free of ${formatGbDecimal(totalGb, "-")} · ${formatByteRateDecimal(diskReadRate)} read · ${formatByteRateDecimal(diskWriteRate)} write`
                      : ""}
                    freshness={{ ...diskLabel }}
                    metricKey="diskPercent"
                    data={metricSeries}
                    paused={!isRunning}
                    accent="#a78bfa"
                    progress={hasSample ? du?.percent : null}
                  />
                )
              })()}
              <ResourceCard title="Network" icon={BarChart3} value={metricUnavailable(status?.metricsFreshness?.network) ? "Not collected yet" : (!networkDownRate && !networkUpRate) ? `0 B down` : `${formatRateDecimal(networkDownRate)} down`} subvalue={!metricUnavailable(status?.metricsFreshness?.network) && (networkDownRate || networkUpRate) ? `${formatRateDecimal(networkUpRate)} up` : ""} freshness={status?.metricsFreshness?.network} metricKey="networkInBytesRate" data={metricSeries} paused={!isRunning} accent="#14b8a6" />
            </div>

            <div className="grid min-w-0 gap-4 md:grid-cols-3">
              <Card className="border-border/40 bg-background/80">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Monthly Bandwidth</CardTitle></CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{formatBytesDecimal(bandwidthTotal, { fallback: "0 B" })}</div>
                  <div className="mt-1 text-xs text-muted-foreground">of {formatBytesDecimal(bandwidthIncluded, { fallback: "0 B" })}</div>
                  <Progress value={bandwidthPercent} className="mt-3 h-2" />
                </CardContent>
              </Card>
              <Card className="border-border/40 bg-background/80">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Live Throughput</CardTitle></CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{formatRateDecimal(bandwidth?.rxRateBps || networkDownRate)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatRateDecimal(bandwidth?.txRateBps || networkUpRate)} upload</div>
                  <div className="mt-1 text-xs text-muted-foreground">{bandwidthFreshness.state} · {bandwidthFreshness.updated}</div>
                </CardContent>
              </Card>
              <Card className="border-border/40 bg-background/80">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Network Quality</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 text-2xl font-semibold">
                    <span className={`h-2.5 w-2.5 rounded-full ${networkQuality === "Good" ? "bg-emerald-400" : networkQuality === "Limited" ? "bg-amber-400" : "bg-muted-foreground"}`} />
                    {networkQuality}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{bandwidth?.throttled ? `Limited to ${bandwidth.throttleRateMbps || 0.5} Mbps` : liveState === "connected" ? "Streaming usage metrics" : "Waiting for metrics"}</div>
                </CardContent>
              </Card>
            </div>

            <VpsLiveUsageCharts metrics={metricSeries} range={range} onRangeChange={setRange} isRunning={isRunning} isProvisioning={isProvisioning} />

            <Card className="border-border/40 bg-background/80">
              <CardHeader><CardTitle>Storage</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                {storageDisks.map((disk) => (
                  <StorageCard key={disk.id} disk={disk} status={status} running={isRunning} />
                ))}
              </CardContent>
            </Card>

            <Card id="access" className="scroll-mt-24 border-border/40 bg-background/80">
              <CardHeader>
                <CardTitle>Access</CardTitle>
              </CardHeader>
              <CardContent className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <CredentialCard icon={Server} label="Hostname" value={credentials?.hostname || status?.hostname || null} onCopy={copySecret} />
                <CredentialCard
                  icon={Tag}
                  label="Server Tag"
                  value={status?.displayTag || null}
                  onCopy={copySecret}
                  action={<Button size="icon-sm" variant="ghost" type="button" onClick={() => void openTagDialog()} title="Edit Server Tag" className={iconActionButtonClass}><Wrench className="h-4 w-4" /></Button>}
                />
                <CredentialCard icon={Globe2} label="IP address" value={credentials?.ip || status?.ipAddress || null} onCopy={copySecret} />
                <CredentialCard icon={UserRound} label="Username" value={credentials?.username || status?.username || null} onCopy={copySecret} />
                <CredentialCard
                  icon={KeyRound}
                  label="Password"
                  value={showCredentialPassword ? credentials?.password || null : credentials?.passwordAvailable === false ? null : "************"}
                  onCopy={() => void copyPassword()}
                  action={<Button size="icon-sm" variant="ghost" type="button" onClick={revealCredentials} title={showCredentialPassword ? "Hide Password" : "Reveal Password"} aria-label={showCredentialPassword ? "Hide Password" : "Reveal Password"} className={iconActionButtonClass}>{showCredentialPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>}
                  secret
                  revealed={showCredentialPassword}
                />
                <CredentialCard icon={Monitor} label="Operating system" value={status?.os || null} onCopy={copySecret} />
                <div className="min-w-0 rounded-md border border-border/40 p-3">
                  <div className="text-xs font-medium uppercase text-muted-foreground">Quick connect</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {status?.access?.sshEnabled !== false ? <Button asChild size="sm" variant="outline" className={panelActionButtonClass}><a href={`ssh://${credentials?.username || status?.username || "root"}@${credentials?.ip || status?.ipAddress || ""}`}>SSH</a></Button> : null}
                    {status?.access?.rdpEnabled ? <Button asChild size="sm" variant="outline" className={panelActionButtonClass}><a href={`/api/client/vps/${id}/rdp`}>RDP</a></Button> : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="min-w-0 space-y-4">
            <Card className="border-border/40 bg-background/80">
              <CardHeader><CardTitle>Overview</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <InfoRow label="MAC address" value={status?.network?.macAddress || status?.macAddress || "Unavailable"} />
                <InfoRow label="Region" value="India" />
                <InfoRow label="Operating system" value={status?.os || "Unavailable"} />
                <InfoRow label="Uptime" value={formatUptime(status?.uptime) || "Offline"} />
                <InfoRow label="CPU" value={`${status?.resources?.cpuCores || status?.cpuCores || "-"} cores`} />
                <InfoRow label="RAM" value={`${status?.resources?.ramGb || "-"} GB`} />
                <InfoRow label="Disk" value={`${status?.resources?.diskGb || status?.storage?.diskGb || "-"} GB`} />
                <InfoRow label="Created" value={formatDate(status?.createdAt)} />
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-background/80">
              <CardHeader><CardTitle>Billing</CardTitle></CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Days to expire</div>
                  <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
                    {status?.expiry?.expired || expiryStateOf(status) === "expired"
                      ? <span className="text-red-300">Expired {formatDate(status?.expiresAt || status?.renewalDueAt, true)}</span>
                      : status?.expiry?.daysToExpire !== null && status?.expiry?.daysToExpire !== undefined
                        ? <><span className={expiryStateOf(status) === "expiring_soon" ? "text-amber-300" : ""}>{status.expiry.daysToExpire} days</span><span className="text-xs font-normal text-muted-foreground">until {formatDate(status?.expiresAt || status?.renewalDueAt, true)}</span></>
                        : status?.nextRenewalAt || status?.renewalDueAt
                          ? <><span className="text-amber-300">Renewal due</span><span className="text-xs font-normal text-muted-foreground">{formatDate(status?.renewalDueAt || status?.nextRenewalAt, true)}</span></>
                          : "-"}
                  </div>
                </div>
                <Progress value={billingProgress(status)} />
                <div className={`rounded-md border px-3 py-2 text-xs ${status?.expiry?.expired || expiryStateOf(status) === "expired" ? "border-red-400/30 bg-red-400/10 text-red-200" : expiryStateOf(status) === "expiring_soon" ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-border/40 text-muted-foreground"}`}>
                  {status?.expiry?.expired || expiryStateOf(status) === "expired"
                    ? "This server has expired. Renew it to keep service active; un-renewed servers are eventually suspended and deleted."
                    : expiryStateOf(status) === "expiring_soon"
                      ? "This server expires soon. Renew before the due date to avoid service interruption."
                      : "Server renewal is on schedule."}
                </div>
                <InfoRow label="Next due date" value={formatDate(status?.renewalDueAt || status?.nextRenewalAt, true)} />
                <InfoRow label="Suspension" value={formatDate(status?.suspendAt, true)} />
                <InfoRow label="Deletion" value={formatDate(status?.deletionAt, true)} />
                <InfoRow label="Outstanding" value={status?.dueInvoice ? formatCurrency(status.dueInvoice.totalAmount, status.dueInvoice.currency || "INR") : status?.renewalAmount ? formatCurrency(status.renewalAmount, "INR") : "-"} />
              {status?.dueInvoice ? <Button className={cn("w-full", panelActionButtonClass)} onClick={renewNow}><CreditCard className="h-4 w-4" />Renew now</Button> : null}
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-background/80">
              <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-xs text-muted-foreground">{formatLastUpdated(lastUpdatedAt)}</p>
                {logs.length ? logs.slice(0, 8).map((log) => (
                  <div key={log.id} className="rounded-md border border-border/40 p-3">
                    <div className="text-xs text-muted-foreground">{formatDate(log.createdAt, true)} · {log.title || log.level}</div>
                    <div className="mt-1">{log.message}</div>
                  </div>
                )) : (
                  <div className="rounded-md border border-border/40 p-3 text-muted-foreground">No recent activity.</div>
                )}
                <Button variant="outline" className={cn("w-full", panelActionButtonClass)} onClick={fetchLogs}><FileText className="h-4 w-4" />Refresh activity</Button>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-2">
              {!status?.resources || loadingAction !== null || isLocked ? (
                <Button variant="outline" disabled className={panelActionButtonClass}>Upgrade resources</Button>
              ) : (
                <Button asChild variant="outline" className={panelActionButtonClass}><Link href={`/client-area/vps/${id}/upgrade`}>Upgrade resources</Link></Button>
              )}
              <Button asChild variant="outline" className={panelActionButtonClass}><Link href={`/client-area/vps/${id}/upgrade/disk`}>Upgrade disk</Link></Button>
              <Button variant="outline" onClick={() => setPasswordOpen(true)} disabled={!isRunning} className={panelActionButtonClass}>Rotate access password</Button>
            </div>

            <Card className="border-red-400/30 bg-red-400/5">
              <CardHeader><CardTitle className="text-red-100">Danger Zone</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-red-100/80">Reinstalling erases the server disk and rebuilds the operating system.</p>
                <Button asChild variant="outline" className={cn("w-full border-red-400/40 text-red-100 hover:bg-red-400/10", panelActionButtonClass)}>
                  <Link href={`/client-area/vps/${id}/reinstall`}><Wrench className="mr-2 h-4 w-4" />Reinstall server</Link>
                </Button>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upgrade server</DialogTitle>
            <DialogDescription>Review resource changes, prorated amount, and renewal pricing before checkout.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid gap-2">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="upgrade-cpu">CPU cores</Label>
                  <Input id="upgrade-cpu" type="number" min={status?.resources?.cpuCores || 1} value={upgradeForm.cpuCores} onChange={(event) => setUpgradeForm((current) => ({ ...current, cpuCores: event.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upgrade-ram">RAM GB</Label>
                  <Input id="upgrade-ram" type="number" min={status?.resources?.ramGb || 1} value={upgradeForm.ramGb} onChange={(event) => setUpgradeForm((current) => ({ ...current, ramGb: event.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upgrade-disk">Disk GB</Label>
                  <Input id="upgrade-disk" type="number" min={status?.resources?.diskGb || status?.storage?.diskGb || 1} value={upgradeForm.diskGb} onChange={(event) => setUpgradeForm((current) => ({ ...current, diskGb: event.target.value }))} />
                </div>
              </div>
              <RadioGroup value={upgradeForm.termMonths} onValueChange={(value) => setUpgradeForm((current) => ({ ...current, termMonths: value }))} className="grid gap-2 sm:grid-cols-4">
                {[["1", "Monthly"], ["3", "Quarterly"], ["6", "Semi Annual"], ["12", "Annual"]].map(([value, label]) => (
                  <label key={value} className="flex cursor-pointer items-center gap-3 rounded-md border border-border/40 p-3 text-sm"><RadioGroupItem value={value} />{label}</label>
                ))}
              </RadioGroup>
              <RadioGroup value={upgradeForm.paymentMethod} onValueChange={(value) => setUpgradeForm((current) => ({ ...current, paymentMethod: value === "wallet" ? "wallet" : "gateway" }))} className="grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border/40 p-3 text-sm"><RadioGroupItem value="gateway" />Pay by UPI/Card</label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border/40 p-3 text-sm"><RadioGroupItem value="wallet" />Pay from wallet</label>
              </RadioGroup>
            </div>
            <div className="space-y-3 rounded-md border border-border/40 p-3 text-sm">
              <InfoRow label="Current resources" value={`${upgradeQuote.currentCpu} CPU / ${upgradeQuote.currentRam} GB / ${upgradeQuote.currentDisk} GB`} />
              <InfoRow label="New resources" value={`${upgradeQuote.nextCpu} CPU / ${upgradeQuote.nextRam} GB / ${upgradeQuote.nextDisk} GB`} />
              <InfoRow label="Current monthly" value={formatCurrency(upgradeQuote.currentMonthly, "INR")} />
              <InfoRow label="New monthly" value={formatCurrency(upgradeQuote.newMonthly, "INR")} />
              <InfoRow label="Difference" value={formatCurrency(upgradeQuote.difference, "INR")} />
              <InfoRow label="Prorated amount" value={formatCurrency(upgradeQuote.proratedAmount, "INR")} />
              <InfoRow label="Renewal amount" value={formatCurrency(upgradeQuote.renewalAmount, "INR")} />
              <InfoRow label="CPU increase" value={`${upgradeQuote.cpuIncrease}%`} />
              <InfoRow label="RAM increase" value={`${upgradeQuote.ramIncrease}%`} />
              <InfoRow label="Disk increase" value={`${upgradeQuote.diskIncrease}%`} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradeOpen(false)}>Cancel</Button>
            <Button onClick={requestUpgrade}>Create upgrade order</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Rotate access password</DialogTitle>
            <DialogDescription>Password must be at least 12 characters. The QEMU guest agent updates the password inside the running server and the stored credential is synced on success.</DialogDescription>
          </DialogHeader>
          {rotationStatus ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Password rotation:</span>
              <Badge variant={rotationStatus.state === "success" ? "default" : "outline"} className={rotationStatus.state === "failed" || rotationStatus.state === "guest_agent_unavailable" ? "border-red-400/30 bg-red-400/10 text-red-200" : rotationStatus.state === "running" ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : ""}>
                {String(rotationStatus.state).replace(/_/g, " ").toUpperCase()}
              </Badge>
              {rotationStatus.lastChangedAt ? <span className="text-muted-foreground">Last password change: {formatDate(rotationStatus.lastChangedAt, true)}</span> : null}
            </div>
          ) : null}
          <div className="grid gap-4 py-2">
            <div className="grid gap-2"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" value={passwordForm.password} onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))} /></div>
            <div className="grid gap-2"><Label htmlFor="confirm-password">Confirm password</Label><Input id="confirm-password" type="password" autoComplete="new-password" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Button onClick={() => void changePassword()} disabled={loadingAction === "password" || !passwordForm.password || passwordForm.password.length < 12}>
              {loadingAction === "password" ? "Rotating…" : "Rotate password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Server Tag</DialogTitle>
            <DialogDescription>Your own label for this server (letters, numbers, spaces, hyphens, underscores — up to 64 characters). The system hostname and IP are managed automatically and are not affected.</DialogDescription>
          </DialogHeader>
          {tagError ? <div className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">{tagError}</div> : null}
          <div className="grid gap-2 py-2">
            <Label htmlFor="server-tag">Server Tag (optional)</Label>
            <Input id="server-tag" value={tagDraft} maxLength={64} placeholder="e.g. Production Database" onChange={(event) => setTagDraft(event.target.value)} />
            <p className="text-xs text-muted-foreground">Shown in your server list and backup history. Leave blank to use the automatic IP hostname.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagDialogOpen(false)} disabled={tagSaving}>Cancel</Button>
            <Button onClick={() => void saveServerTag()} disabled={tagSaving}>{tagSaving ? "Saving…" : "Save tag"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Container>
  )
}

function ActionButton({ icon: Icon, label, onClick, busy, disabled }: { icon: any; label: string; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy || disabled} className={panelActionButtonClass}>
      {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {label}
    </Button>
  )
}

function ResourceCard({ title, icon: Icon, value, subvalue, freshness, data, metricKey, paused, accent = "#60a5fa", progress, note }: { title: string; icon: any; value: string; subvalue?: string; freshness?: any; data: MetricPoint[]; metricKey: string; paused?: boolean; accent?: string; progress?: number | null; note?: string }) {
  const fresh = freshness as { checked?: string; updated?: string; errorCode?: string | null; error?: string | null; neverMeasured?: boolean }
  const stamp = fresh?.checked || fresh?.updated || ""
  return (
    <Card className="overflow-hidden border-border/40 bg-background/80">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4" style={{ color: accent }} />{title}</div>
        <div>
          <div className="text-lg font-semibold">{value}</div>
          {subvalue ? <div className="text-xs text-muted-foreground">{subvalue}</div> : null}
          <div className="text-xs text-muted-foreground">
            {stamp}
            {fresh?.errorCode ? ` · ${fresh.errorCode}` : ""}
            {note ? ` · ${note}` : ""}
          </div>
        </div>
        {progress !== undefined && progress !== null ? <Progress value={Math.max(0, Math.min(100, Number(progress || 0)))} /> : null}
        <div className="h-20">
          <MiniChart data={data} metricKey={metricKey} paused={paused} color={accent} />
        </div>
      </CardContent>
    </Card>
  )
}

function MiniChart({ data, metricKey, paused, color }: { data: MetricPoint[]; metricKey: string; paused?: boolean; color: string }) {
  // The chart is decorative. When there is nothing to plot, say that, rather
  // than implying the server is offline.
  if (paused || !data.length) return <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/40 text-xs text-muted-foreground">{paused ? "Collecting after the server starts" : "No traffic sample yet"}</div>
  const values = data.slice(-42).map((point: any) => Number(point[metricKey] || 0))
  const clean = values.filter((value) => Number.isFinite(value))
  const max = Math.max(1, ...clean)
  const min = Math.min(0, ...clean)
  const spread = Math.max(1, max - min)
  const points = clean.map((value, index) => {
    const x = clean.length === 1 ? 0 : (index / (clean.length - 1)) * 100
    const y = 54 - ((value - min) / spread) * 46
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(" ")
  const area = `0,56 ${points} 100,56`
  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="h-full w-full rounded-md border border-border/30 bg-background/40" aria-hidden="true">
      <polygon points={area} fill={color} opacity="0.14" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function StorageCard({ disk, status, running }: { disk: any; status: VpsStatus | null; running: boolean }) {
  const used = status?.diskUsage?.usedGb
  const total = status?.diskUsage?.totalGb || disk.sizeGb
  const percent = status?.diskUsage?.reported ? Number(status?.diskUsage?.percent || 0) : 0
  return (
    <div className="rounded-md border border-border/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary"><HardDrive className="h-5 w-5" /></div>
          <div>
            <div className="font-medium">{disk.displayName || "disk1"}</div>
            <div className="text-sm text-muted-foreground">Enterprise NVMe</div>
          </div>
        </div>
        <Badge variant="outline">Healthy</Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <InfoBlock label="Size" value={formatGbDecimal(total, "-")} />
        <InfoBlock label="Interface" value={status?.storage?.enterprise?.technology || "VirtIO SCSI"} />
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Usage</span>
          <span>{status?.diskUsage?.reported && used !== null && used !== undefined ? `${formatGbDecimal(used, "-")} / ${formatGbDecimal(total, "-")}` : "Not collected yet"}</span>
        </div>
        <Progress value={status?.diskUsage?.reported && used !== null && used !== undefined ? Math.max(0, Math.min(100, percent)) : 0} />
      </div>
    </div>
  )
}

function CredentialCard({
  icon: Icon,
  label,
  value,
  copyValue,
  onCopy,
  action,
  secret,
  revealed,
}: {
  icon: any
  label: string
  value?: string | null
  copyValue?: string | null
  onCopy: (value?: string | null, label?: string) => void | Promise<void>
  action?: React.ReactNode
  secret?: boolean
  revealed?: boolean
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/40 p-3">
      <p className="flex min-w-0 items-center gap-2 text-xs font-medium uppercase text-muted-foreground"><Icon className="h-4 w-4 shrink-0" /><span className="truncate">{label}</span></p>
      <div className="mt-1 flex min-h-9 min-w-0 items-center justify-between gap-2">
        {secret ? (
          <Input readOnly type={revealed ? "text" : "password"} value={value || ""} placeholder="-" className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 font-mono text-sm shadow-none focus-visible:ring-0" />
        ) : (
          <span className="min-w-0 break-all font-mono text-sm">{value || "-"}</span>
        )}
        <div className="flex gap-1">
          {action}
          <Button size="icon-sm" variant="ghost" type="button" onClick={() => void onCopy(copyValue ?? value, `${label} copied`)} disabled={secret ? false : !(copyValue ?? value)} className={iconActionButtonClass} title={`Copy ${label}`} aria-label={`Copy ${label}`}><Clipboard className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>
}

function billingProgress(status: VpsStatus | null) {
  const due = status?.renewalDueAt || status?.nextRenewalAt
  if (!due) return 0
  const dueAt = new Date(due).getTime()
  if (!Number.isFinite(dueAt)) return 0
  const created = status?.createdAt ? new Date(status.createdAt).getTime() : Date.now() - 30 * 86400000
  const total = Math.max(1, dueAt - created)
  return Math.max(0, Math.min(100, ((Date.now() - created) / total) * 100))
}
