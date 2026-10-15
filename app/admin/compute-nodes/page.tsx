"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { Activity, CheckCircle2, ChevronDown, Database, Edit, ExternalLink, Eye, MapPin, MoreHorizontal, Network, Plus, RefreshCw, Server, Trash2, TriangleAlert, Upload, Wifi, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  NODE_WIZARD_STEPS,
  NodeWizardStepBody,
  NodeWizardSteps,
  canAdvanceFromWizard,
  type CapabilityReport,
  type WizardDiagnosticStep,
  type WizardForm,
} from "./NodeWizard"
import NodeHealthDashboard from "./NodeHealthDashboard"

type NodeHealthState = "healthy" | "warning" | "critical" | "full" | "offline" | "overloaded" | "failed"

type ComputeNode = {
  node: {
    id: string
    name: string
    host: string
    nodeName: string
    isActive: boolean
    schedulingEnabled: boolean
    drainReason?: string | null
    drainedAt?: string | null
    location: string | null
    status: string
    lastCheckedAt: string | null
    allowInsecureTls: boolean
    resolvedIp?: string | null
    hasTokenId?: boolean
    hasTokenSecret: boolean
    guestCapabilities?: {
      status: "ready" | "degraded" | "failed" | "pending"
      pass: number
      fail: number
      skip: number
      total: number
      lastCheckedAt: string | null
      lastSuccessAt: string | null
      stale: boolean
      lastError: string | null
    }
  }
  status: NodeHealthState
  checkedAt: string
  error?: string
  health: { status: NodeHealthState; critical: boolean; provisionAllowed?: boolean; provisionPriority?: "normal" | "low" | "blocked" }
  cpu: { usagePercent: number; totalCores: number; loadAverage: string }
  memory: { used: string; total: string; usagePercent: number }
  disk: { used: string; total: string; usagePercent: number }
  uptime: { readable: string }
  loadAverage: string
  storage: Array<{ usagePercent: number }>
  vmSummary: { running: number; stopped: number; templates: number; failedUnknown: number; total: number }
  provisionCapacity?: { allowed: boolean; priority: "normal" | "low" | "blocked"; state: NodeHealthState; vmCount: number; maxVmCapacity: number | null; remainingVmCapacity: number | null }
}

type NodeEdit = {
  id: string
  name: string
  host: string
  nodeName: string
  isActive: boolean
  location: string | null
  status: string
  lastCheckedAt: string | null
  allowInsecureTls: boolean
  resolvedIp?: string | null
  hasTokenId?: boolean
  hasTokenSecret: boolean
}

type FormState = {
  name: string
  host: string
  nodeName: string
  tokenId: string
  tokenSecret: string
  location: string
  allowInsecureTls: boolean
  sshUsername: string
  sshPassword: string
}

type TestState = {
  status: "idle" | "testing" | "success" | "failed"
  message: string
  code?: string
  nodes: string[]
  host: string
  steps: DiagnosticStep[]
  /** Connected and authenticated, but at least one check was refused. */
  degraded?: boolean
  /** Endpoints this token is valid but not permitted to read. */
  permissionDeniedEndpoints?: string[]
  /** Endpoints that failed for a reason other than permissions. */
  failedEndpoints?: string[]
}

type DiagnosticStep = {
  name: string
  ok: boolean
  code: string
  message: string
  durationMs: number
  endpoint?: string | null
  status?: number | null
  address?: string | null
  addresses?: string[]
}

const emptyForm: FormState = {
  name: "",
  host: "",
  nodeName: "",
  tokenId: "",
  tokenSecret: "",
  location: "",
  allowInsecureTls: false,
  sshUsername: "",
  sshPassword: "",
}

const emptyTest: TestState = {
  status: "idle",
  message: "",
  code: undefined,
  nodes: [],
  host: "",
  steps: [],
  degraded: false,
  permissionDeniedEndpoints: [],
  failedEndpoints: [],
}

const connectionFields = new Set<keyof FormState>(["host", "nodeName", "tokenId", "tokenSecret", "allowInsecureTls"])

function isConnectedNodeStatus(status: unknown) {
  return !["offline", "failed"].includes(String(status || "").toLowerCase())
}

export default function ComputeNodesPage() {
  const [nodes, setNodes] = useState<ComputeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<NodeEdit | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [testState, setTestState] = useState<TestState>(emptyTest)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [wizardStep, setWizardStep] = useState(0)
  const [wizardCapabilities, setWizardCapabilities] = useState<CapabilityReport | null>(null)
  const [wizardMeasuring, setWizardMeasuring] = useState(false)
  const [wizardWarning, setWizardWarning] = useState<string | null>(null)
  const loadInFlightRef = useRef(false)
  const nodeFailuresRef = useRef<Record<string, number>>({})

  useEffect(() => {
    let stopped = false
    let timer: number | null = null

    const clearTimer = () => {
      if (timer) window.clearTimeout(timer)
      timer = null
    }

    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return
      clearTimer()
      timer = window.setTimeout(() => void refresh(false), 30000)
    }

    const refresh = async (initial: boolean) => {
      if (stopped || (!initial && document.visibilityState === "hidden")) return
      await loadNodes({ silent: !initial })
      schedule()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimer()
        void refresh(false)
      } else {
        clearTimer()
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    void refresh(true)

    return () => {
      stopped = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      clearTimer()
    }
  }, [])

  const stats = useMemo(() => {
    return {
      total: nodes.length,
      connected: nodes.filter((entry) => isConnectedNodeStatus(entry.status)).length,
      warning: nodes.filter((entry) => entry.status === "warning").length,
      failed: nodes.filter((entry) => entry.status === "offline").length,
      running: nodes.reduce((total, entry) => total + Number(entry.vmSummary?.running || 0), 0),
      templates: nodes.reduce((total, entry) => total + Number(entry.vmSummary?.templates || 0), 0),
    }
  }, [nodes])

  const tokenIdValid = !form.tokenId.trim() || !/PVEAPIToken=/i.test(form.tokenId)
  const canTest = Boolean(
    form.host.trim() &&
    form.nodeName.trim() &&
    (form.tokenId.trim() || editingNode?.hasTokenId) &&
    (form.tokenSecret.trim() || editingNode?.hasTokenSecret) &&
    tokenIdValid
  )
  const canSave = Boolean(form.name.trim()) && canTest && testState.status === "success" && !saving

  function openAddWizard() {
    setEditingNode(null)
    setForm(emptyForm)
    setTestState(emptyTest)
    setWizardStep(0)
    setWizardCapabilities(null)
    setWizardWarning(null)
    setIsDialogOpen(true)
  }

  function wizardForm(): WizardForm {
    return {
      name: form.name,
      host: form.host,
      nodeName: form.nodeName,
      tokenId: form.tokenId,
      tokenSecret: form.tokenSecret,
      location: form.location,
      allowInsecureTls: form.allowInsecureTls,
    }
  }

  const wizardCanAdvance = canAdvanceFromWizard({
    step: wizardStep,
    form: wizardForm(),
    connection: { status: testState.status, message: testState.message, code: testState.code, nodes: testState.nodes, host: testState.host, steps: testState.steps as WizardDiagnosticStep[] },
    capabilities: wizardCapabilities,
  })

  /**
   * Pre-flight the capabilities before the node exists.
   *
   * This cannot write the cached row — there is no node id yet — so it asks the
   * test endpoint, which runs the same probes. The authoritative measurement is
   * still taken on create; this step exists so an admin sees the verdict before
   * committing, not after.
   */
  async function measureWizardCapabilities() {
    setWizardMeasuring(true)
    try {
      const res = await fetch("/api/admin/proxmox-nodes/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...wizardForm(), capabilitiesOnly: true }),
      })
      const data = await readJsonResponse<any>(res)
      const report = data?.capabilities as CapabilityReport | undefined
      if (!res.ok || !report) throw new Error(data?.error || "Capability measurement failed")
      setWizardCapabilities(report)
    } catch (err: any) {
      toast.error(err?.message || "Capability measurement failed")
    } finally {
      setWizardMeasuring(false)
    }
  }

  async function loadNodes(options: { silent?: boolean } = {}) {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    if (!options.silent) setLoading(true)
    try {
      const res = await fetch("/api/admin/compute-nodes", { cache: "no-store" })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data?.error || "Failed to load nodes")
      const incoming = Array.isArray(data.nodes) ? data.nodes : []
      setNodes((current) => mergeNodeSnapshots(current, incoming, nodeFailuresRef.current))
      setLastRefreshedAt(new Date())
    } catch (err: any) {
      if (!options.silent) toast.error(err?.message || "Failed to load nodes")
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }

  async function refreshAll() {
    setRefreshing(true)
    try {
      await loadNodes()
      toast.success("Compute nodes refreshed")
    } finally {
      setRefreshing(false)
    }
  }

  async function openEditDialog(node: ComputeNode) {
    try {
      const res = await fetch(`/api/admin/proxmox-nodes/${node.node.id}`)
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data?.error || "Failed to load node")
      const editable = data as NodeEdit
      setEditingNode(editable)
      setForm({
        name: editable.name,
        host: editable.host,
        nodeName: editable.nodeName,
        tokenId: "",
        tokenSecret: "",
        location: editable.location || "",
        allowInsecureTls: editable.allowInsecureTls,
        sshUsername: (editable as any).sshUsername || "",
        sshPassword: "",
      })
      setTestState(emptyTest)
      setIsDialogOpen(true)
    } catch (err: any) {
      toast.error(err?.message || "Failed to load node")
    }
  }

  function updateForm<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }))
    if (connectionFields.has(field) && testState.status === "success") setTestState(emptyTest)
  }

  async function testFormConnection() {
    if (!canTest || testState.status === "testing") return
    setTestState({ ...emptyTest, status: "testing", message: "Testing..." })
    try {
      const res = await fetch("/api/admin/proxmox/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingNode?.id, ...form }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || !data.ok) {
        setTestState({
          status: "failed",
          message: data?.message || data?.error || "Connection failed",
          code: data?.code || "UNKNOWN_ERROR",
          nodes: data?.nodes || [],
          host: data?.host || form.host,
          steps: data?.steps || [],
        })
        throw new Error(`${data?.code || "UNKNOWN_ERROR"}: ${data?.message || data?.error || "Connection failed"}`)
      }
      const matchedNodeName = data?.matchedNode?.node || form.nodeName
      setForm((current) => ({ ...current, host: data.host || current.host, nodeName: matchedNodeName || current.nodeName }))
      setTestState({
        status: "success",
        message: data?.message || "Connection successful",
        code: data?.code || "OK",
        nodes: data.nodes || [],
        host: data.host || form.host,
        steps: data.steps || [],
        // A refused check is not a failed connection. The node is connected; it
        // is just scoped more narrowly than the full feature set, and the
        // administrator is told which grants are missing rather than being
        // blocked from saving.
        degraded: data?.degraded === true,
        permissionDeniedEndpoints: data?.permissionDeniedEndpoints || [],
        failedEndpoints: data?.failedEndpoints || [],
      })
      if (data?.degraded) {
        toast.warning("Connected, but some checks were refused for want of permission")
      } else {
        toast.success("Connection successful")
      }
    } catch (err: any) {
      const message = err?.message || testState.message || "Connection failed"
      setTestState((current) => current.status === "failed" ? current : { ...emptyTest, status: "failed", message, code: "UNKNOWN_ERROR" })
      toast.error(message)
    }
  }

  async function saveNode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const url = editingNode ? `/api/admin/proxmox-nodes/${editingNode.id}` : "/api/admin/proxmox-nodes"
      const res = await fetch(url, {
        method: editingNode ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || data?.success === false || data?.ok === false) {
        const message = data?.message || data?.error || "Save failed"
        setTestState({
          status: "failed",
          message,
          code: data?.code || "SAVE_FAILED",
          nodes: data?.nodes || [],
          host: data?.host || form.host,
          steps: data?.steps || [],
        })
        throw new Error(`${data?.code || "SAVE_FAILED"}: ${message}`)
      }
      const savedNode = data?.node
      if (savedNode?.host) setForm((current) => ({ ...current, host: savedNode.host }))
      if (!editingNode && savedNode?.id) {
        await Promise.allSettled([
          fetch(`/api/admin/compute-nodes/${savedNode.id}/refresh`, { method: "POST", cache: "no-store" }),
          fetch(`/api/admin/compute-nodes/${savedNode.id}/storage-pools`, { method: "POST", cache: "no-store" }),
          fetch(`/api/admin/proxmox-nodes/${savedNode.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "syncTemplates" }),
          }),
        ])
      }
      if (editingNode) {
        toast.success("Server updated")
        setIsDialogOpen(false)
      } else {
        setWizardWarning(data?.warning || null)
        if (data?.warning) toast.warning(data.warning)
        else toast.success("Node added")
      }
      setEditingNode(null)
      setForm(emptyForm)
      setTestState(emptyTest)
      setWizardCapabilities(null)
      setWizardStep(0)
      if (!editingNode && !data?.warning) setIsDialogOpen(false)
      await loadNodes()
    } catch (err: any) {
      toast.error(err?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this node?")) return
    try {
      const res = await fetch(`/api/admin/proxmox-nodes/${id}`, { method: "DELETE" })
      const data = await readJsonResponse<any>(res)
      if (!res.ok) throw new Error(data?.error || "Delete failed")
      toast.success("Node deleted")
      await loadNodes()
    } catch (err: any) {
      toast.error(err?.message || "Delete failed")
    }
  }

  async function handleTableTest(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/admin/proxmox-nodes/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || !data.success) throw new Error(`${data?.code || "UNKNOWN_ERROR"}: ${data?.message || data?.error || "Connection failed"}`)
      toast.success("Connection successful")
    } catch (err: any) {
      toast.error(err?.message || "Connection failed")
    } finally {
      setTestingId(null)
      await loadNodes()
    }
  }

  async function handleSyncTemplates(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/admin/proxmox-nodes/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "syncTemplates" }),
      })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || !data.success) throw new Error(data?.error || "Template sync failed")
      const sync = data?.sync
      toast.success(`Template sync: ${sync.templatesFound} found, ${sync.imported} imported, ${sync.updated} updated.`)
    } catch (err: any) {
      toast.error(err?.message || "Template sync failed")
    } finally {
      setTestingId(null)
      await loadNodes()
    }
  }

  /**
   * Re-measure a node's guest capabilities.
   *
   * A cached verdict goes stale, and a stale "Ready" is a claim nobody verified
   * in this session — so the badge marks it and this is the way to renew it.
   */
  async function handleRecheckCapabilities(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/admin/proxmox-nodes/${id}/capabilities`, { method: "POST", cache: "no-store" })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || !data?.success) throw new Error(data?.error || "Capability check failed")
      if (data.status === "ready") toast.success(data.headline || "Guest capabilities verified")
      else toast.warning(data.headline || "Guest automation is not available on this node")
      await loadNodes({ silent: true })
    } catch (err: any) {
      toast.error(err?.message || "Capability check failed")
    } finally {
      setTestingId(null)
    }
  }

  async function handleRefreshNode(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/admin/compute-nodes/${id}/refresh`, { method: "POST", cache: "no-store" })
      const data = await readJsonResponse<any>(res)
      if (!res.ok || data?.success === false) throw new Error(data?.error || "Node refresh failed")
      toast.success("Node refreshed")
    } catch (err: any) {
      toast.error(err?.message || "Node refresh failed")
    } finally {
      setTestingId(null)
      await loadNodes({ silent: true })
    }
  }

  return (
      <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Compute Nodes</h1>
          <p className="mt-1 text-sm text-muted-foreground">Live Proxmox resource health and instance inventory.</p>
          <p className="mt-1 text-xs text-muted-foreground">Last refreshed {lastRefreshedAt ? "just now" : "-"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={refreshAll} disabled={refreshing} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={openAddWizard} className="gap-2">
            <Plus className="h-4 w-4" />
            Add compute node
          </Button>
        </div>
      </div>

      {/*
        Node health & capability dashboard.

        Discovery runs server-side against the stored token and reports every
        node the token can see, so this is the place that says which capabilities
        are actually verified rather than merely reachable. It polls on its own
        interval and pauses when the tab is hidden.
      */}
      <NodeHealthDashboard
        nodeId={nodes[0]?.node?.id ?? null}
        host={nodes[0]?.node?.host ?? null}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total Nodes" value={stats.total} icon={Server} color="text-blue-400" bgColor="bg-blue-400/10" />
        <StatCard label="Connected Nodes" value={stats.connected} icon={CheckCircle2} color="text-emerald-400" bgColor="bg-emerald-400/10" />
        <StatCard label="Warnings" value={stats.warning} icon={TriangleAlert} color="text-amber-400" bgColor="bg-amber-400/10" />
        <StatCard label="Running Instances" value={stats.running} icon={Activity} color="text-[var(--accent-primary)]" bgColor="bg-[var(--accent-subtle)]" />
        <StatCard label="Templates" value={stats.templates} icon={MapPin} color="text-violet-400" bgColor="bg-violet-400/10" />
      </div>

      <Card className="glass border-border/40">
        <CardHeader className="px-4 py-3">
          <CardTitle>Node Fleet</CardTitle>
          <CardDescription>CPU, memory, load, templates, health, and provision capacity refresh automatically every 30 seconds.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="hidden overflow-x-auto 2xl:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Guest automation</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>RAM</TableHead>
                <TableHead>Uptime</TableHead>
                <TableHead>Load</TableHead>
                <TableHead>VMs</TableHead>
                <TableHead>Templates</TableHead>
                <TableHead>Provision</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={13}><Skeleton className="h-10 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : nodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">No compute nodes configured.</TableCell>
                </TableRow>
              ) : nodes.map((entry) => (
                <TableRow key={entry.node.id} className="align-middle">
                  <TableCell>
                    <div className="font-medium">{entry.node.name}</div>
                    <div className="text-xs text-muted-foreground">{entry.node.nodeName} · {entry.node.location || "No location"}</div>
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-xs text-muted-foreground">{entry.node.host}</TableCell>
                  <TableCell><div className="space-y-1"><StatusBadge status={entry.status} critical={entry.health?.critical} />{entry.node.schedulingEnabled === false ? <Badge variant="outline" className="border-amber-500/40 text-amber-300" title={entry.node.drainReason || "New placement disabled"}>Drained</Badge> : null}</div></TableCell>
                  <TableCell>
                    <GuestAutomationBadge nodeId={entry.node.id} capabilities={entry.node.guestCapabilities} onRecheck={handleRecheckCapabilities} busy={testingId === entry.node.id} />
                  </TableCell>
                  <TableCell><Usage value={entry.cpu.usagePercent} label={`${entry.cpu.totalCores || 0} cores`} available={entry.status !== "offline"} /></TableCell>
                  <TableCell><Usage value={entry.memory.usagePercent} label={`${entry.memory.used} / ${entry.memory.total}`} available={entry.status !== "offline"} /></TableCell>
                  <TableCell className="whitespace-nowrap">{entry.uptime.readable}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{entry.loadAverage}</TableCell>
                  <TableCell>{entry.status === "offline" ? "Unavailable" : `${entry.vmSummary.running}/${entry.vmSummary.total}`}</TableCell>
                  <TableCell>{entry.status === "offline" ? "Unavailable" : entry.vmSummary.templates}</TableCell>
                  <TableCell>{entry.node.schedulingEnabled === false ? <span className="text-xs text-amber-300" title={entry.node.drainReason || undefined}>Drained</span> : <ProvisionCapacity value={entry.provisionCapacity} />}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(entry.node.lastCheckedAt || entry.checkedAt)}</TableCell>
                  <TableCell>
                    <NodeActions
                      nodeId={entry.node.id}
                      host={entry.node.host}
                      busy={testingId === entry.node.id}
                      onRefresh={handleRefreshNode}
                      onSync={handleSyncTemplates}
                      onTest={handleTableTest}
                      onEdit={() => openEditDialog(entry)}
                      onDelete={handleDelete}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
          <div className="grid gap-4 2xl:hidden">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-32 w-full" />)
            ) : nodes.length === 0 ? (
              <div className="rounded-lg border border-border/40 p-8 text-center text-muted-foreground">No compute nodes configured.</div>
            ) : nodes.map((entry) => (
              <article key={entry.node.id} className="rounded-md border border-border/40 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{entry.node.name}</h3>
                    <p className="truncate text-xs text-muted-foreground">{entry.node.nodeName} · {entry.node.location || "No location"}</p>
                    <p className="truncate text-xs text-muted-foreground">{entry.node.host}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1"><StatusBadge status={entry.status} critical={entry.health?.critical} />{entry.node.schedulingEnabled === false ? <Badge variant="outline" className="border-amber-500/40 text-amber-300">Drained</Badge> : null}</div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Usage value={entry.cpu.usagePercent} label={`${entry.cpu.totalCores || 0} cores`} available={entry.status !== "offline"} />
                  <Usage value={entry.memory.usagePercent} label={`${entry.memory.used} / ${entry.memory.total}`} available={entry.status !== "offline"} />
                </div>
                <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-5">
                  <span>Uptime: {entry.uptime.readable}</span>
                  <span>Load: {entry.loadAverage}</span>
                  <span>VMs: {entry.vmSummary.running}/{entry.vmSummary.total}</span>
                  <span>Templates: {entry.vmSummary.templates}</span>
                  <span><ProvisionCapacity value={entry.provisionCapacity} compact /></span>
                </div>
                <div className="mt-4 flex justify-end">
                  <NodeActions
                    nodeId={entry.node.id}
                    host={entry.node.host}
                    busy={testingId === entry.node.id}
                    onRefresh={handleRefreshNode}
                    onSync={handleSyncTemplates}
                    onTest={handleTableTest}
                    onEdit={() => openEditDialog(entry)}
                    onDelete={handleDelete}
                  />
                </div>
              </article>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Adding a node is a ten-step wizard; editing one is a single form. The
          difference is deliberate: an edit cannot change whether the node can
          configure a guest, while an addition decides it up front. */}
      {editingNode ? (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="flex max-h-[min(92dvh,760px)] max-w-2xl flex-col overflow-hidden p-0">
            <DialogHeader className="shrink-0 px-6 pt-6">
              <DialogTitle>Edit Server / Node</DialogTitle>
              <DialogDescription>Test connection before saving. Existing token values can be kept without exposing them.</DialogDescription>
            </DialogHeader>
            <form onSubmit={saveNode} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-6 py-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Display Name" value={form.name} onChange={(value) => updateForm("name", value)} placeholder="Mumbai DC1" />
                  <Field label="Node Name" value={form.nodeName} onChange={(value) => updateForm("nodeName", value)} placeholder="pve" />
                </div>
                <Field label="Host URL" value={form.host} onChange={(value) => updateForm("host", value)} placeholder="node.example.com" />
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Token ID" value={form.tokenId} onChange={(value) => updateForm("tokenId", value)} placeholder={editingNode?.hasTokenId ? "Leave blank to keep existing token ID" : "root@pam!token"} />
                  <Field label="Token Secret" value={form.tokenSecret} onChange={(value) => updateForm("tokenSecret", value)} placeholder={editingNode?.hasTokenSecret ? "Leave blank to keep existing secret" : ""} type="password" />
                </div>
                <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                  <Field label="Location" value={form.location} onChange={(value) => updateForm("location", value)} placeholder="Mumbai, India" />
                  <label className="flex h-10 items-center gap-3 rounded-md border border-border/40 px-3 text-sm">
                    <Checkbox checked={form.allowInsecureTls} onCheckedChange={(checked) => updateForm("allowInsecureTls", checked === true)} />
                    Allow insecure TLS
                  </label>
                </div>
                <div className="rounded-md border border-border/40 p-4 space-y-3">
                  <div>
                    <p className="text-sm font-medium">SSH Credentials — QEMU Kill Fallback (optional)</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Used as a last resort to kill stuck QEMU processes when the Proxmox API force-stop fails. Leave blank to skip tier-3 stop.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="SSH Username" value={form.sshUsername} onChange={(value) => updateForm("sshUsername", value)} placeholder="root" />
                    <Field label="SSH Password" value={form.sshPassword} onChange={(value) => updateForm("sshPassword", value)} placeholder={editingNode ? "Leave blank to keep existing" : ""} type="password" />
                  </div>
                </div>
                {testState.nodes.length > 0 ? (
                  <div className="space-y-2">
                    <Label>Available Nodes</Label>
                    <Select value={form.nodeName} onValueChange={(value) => updateForm("nodeName", value)}>
                      <SelectTrigger><SelectValue placeholder="Select detected node" /></SelectTrigger>
                      <SelectContent>{testState.nodes.map((node) => <SelectItem key={node} value={node}>{node}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                ) : null}
                <ConnectionStatus state={testState} />
              </div>
              <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/40 bg-background/95 px-6 py-4 backdrop-blur sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button type="button" variant="outline" onClick={testFormConnection} disabled={!canTest || testState.status === "testing"} className="gap-2"><Activity className="h-4 w-4" />{testState.status === "testing" ? "Testing..." : "Test Connection"}</Button>
                <Button type="submit" disabled={!canSave}>{saving ? "Saving..." : "Save Node"}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      ) : (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="flex max-h-[min(92dvh,860px)] max-w-3xl flex-col overflow-hidden p-0">
            <DialogHeader className="shrink-0 px-6 pt-6">
              <DialogTitle>Add a compute node</DialogTitle>
              <DialogDescription>
                Step {wizardStep + 1} of {NODE_WIZARD_STEPS.length} — {NODE_WIZARD_STEPS[wizardStep]?.description}
              </DialogDescription>
              <Progress value={((wizardStep + 1) / NODE_WIZARD_STEPS.length) * 100} className="mt-1 h-1" />
            </DialogHeader>
            <form
              onSubmit={(event) => { event.preventDefault(); void saveNode(event) }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[220px_1fr]">
                <div className="hidden overflow-y-auto border-r border-border/40 bg-muted/20 p-4 md:block">
                  <NodeWizardSteps current={wizardStep} />
                </div>
                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <NodeWizardStepBody
                    step={wizardStep}
                    form={wizardForm()}
                    updateForm={updateForm}
                    connection={{ status: testState.status, message: testState.message, code: testState.code, nodes: testState.nodes, host: testState.host, steps: testState.steps as WizardDiagnosticStep[] }}
                    capabilities={wizardCapabilities}
                    onTestConnection={() => void testFormConnection()}
                    onMeasure={() => void measureWizardCapabilities()}
                    measuring={wizardMeasuring}
                  />
                  {wizardWarning ? (
                    <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">{wizardWarning}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/40 bg-background/95 px-6 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <Button type="button" variant="ghost" onClick={() => setWizardStep((current) => Math.max(0, current - 1))} disabled={wizardStep === 0 || saving}>
                  Back
                </Button>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)} disabled={saving}>Cancel</Button>
                  {wizardStep < NODE_WIZARD_STEPS.length - 1 ? (
                    <Button
                      type="button"
                      onClick={() => setWizardStep((current) => Math.min(NODE_WIZARD_STEPS.length - 1, current + 1))}
                      disabled={!wizardCanAdvance}
                    >
                      Next
                    </Button>
                  ) : (
                    <Button type="submit" disabled={saving || !wizardCanAdvance}>
                      {saving ? "Adding..." : "Add node"}
                    </Button>
                  )}
                </div>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function NodeActions({
  nodeId,
  host,
  busy,
  onRefresh,
  onSync,
  onTest,
  onEdit,
  onDelete,
}: {
  nodeId: string
  host: string
  busy: boolean
  onRefresh: (id: string) => void
  onSync: (id: string) => void
  onTest: (id: string) => void
  onEdit: () => void
  onDelete: (id: string) => void
}) {
  const href = `/admin/compute-nodes/${nodeId}`
  const links: Array<{ label: string; hash: string; icon?: any }> = [
    { label: "Templates", hash: "templates", icon: Database },
    { label: "ISOs", hash: "isos" },
    { label: "Enable Template", hash: "templates" },
    { label: "Disable Template", hash: "templates" },
    { label: "Upload ISO", hash: "isos", icon: Upload },
    { label: "Network Usage", hash: "network-usage", icon: Network },
    { label: "Refresh Metrics", hash: "live-metrics", icon: Wifi },
    { label: "Restart Node Services", hash: "logs", icon: Activity },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-2">
          <MoreHorizontal className="h-4 w-4" />
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Node actions</DropdownMenuLabel>
        <DropdownMenuItem asChild><Link href={href}><Eye className="mr-2 h-4 w-4" />View node</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><a href={host} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 h-4 w-4" />Open Proxmox</a></DropdownMenuItem>
        <DropdownMenuSeparator />
        {links.map((item) => {
          const Icon = item.icon
          return (
            <DropdownMenuItem key={`${item.label}-${item.hash}`} asChild>
              <Link href={`${href}#${item.hash}`}>{Icon ? <Icon className="mr-2 h-4 w-4" /> : null}{item.label}</Link>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={() => onSync(nodeId)}><RefreshCw className="mr-2 h-4 w-4" />Sync templates</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => onRefresh(nodeId)}><RefreshCw className="mr-2 h-4 w-4" />Refresh metrics</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => onTest(nodeId)}><Activity className="mr-2 h-4 w-4" />Test connection</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onEdit}><Edit className="mr-2 h-4 w-4" />Edit node</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(nodeId)}><Trash2 className="mr-2 h-4 w-4" />Delete node</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Usage({ value, label, available = true }: { value: number; label: string; available?: boolean }) {
  if (!available) return <span className="text-xs text-muted-foreground">Telemetry unavailable</span>
  return (
    <div className="min-w-28 space-y-1">
      <div className="flex justify-between gap-2 text-xs"><span>{Number(value || 0).toFixed(1)}%</span><span className="truncate text-muted-foreground">{label}</span></div>
      <Progress value={value || 0} className={`h-1.5 ${value >= 95 ? "bg-destructive/20 [&_[data-slot=progress-indicator]]:bg-destructive" : value >= 85 ? "bg-amber-500/20 [&_[data-slot=progress-indicator]]:bg-amber-500" : ""}`} />
    </div>
  )
}

function mergeNodeSnapshots(current: ComputeNode[], incoming: ComputeNode[], failures: Record<string, number>) {
  const previousById = new Map(current.map((entry) => [entry.node.id, entry]))
  return incoming.map((entry) => {
    const previous = previousById.get(entry.node.id)
    if (entry.status !== "offline") {
      failures[entry.node.id] = 0
      return entry
    }

    failures[entry.node.id] = (failures[entry.node.id] || 0) + 1
    if (!previous || failures[entry.node.id] >= 3) return entry

    return {
      ...previous,
      status: "warning" as const,
      health: { status: "warning" as const, critical: false, provisionAllowed: true, provisionPriority: "normal" as const },
      checkedAt: entry.checkedAt,
      error: entry.error || "Latest refresh failed; showing last known metrics.",
      node: {
        ...previous.node,
        lastCheckedAt: entry.node.lastCheckedAt || previous.node.lastCheckedAt,
      },
    }
  })
}

function StatCard({ label, value, icon: Icon, color, bgColor }: { label: string; value: number; icon: any; color: string; bgColor: string }) {
  return (
    <div className="glass rounded-md p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className={`rounded-lg p-2 ${bgColor}`}><Icon className={`h-4 w-4 ${color}`} /></div>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} />
    </div>
  )
}

/**
 * The one thing an admin needs to know about a node at a glance: can it
 * configure a guest?
 *
 * "Connected" and "can configure a guest" are different claims. This badge
 * answers the second one, and a stale verdict says so rather than pretending to
 * be current.
 */
function GuestAutomationBadge({
  nodeId,
  capabilities,
  onRecheck,
  busy,
}: {
  nodeId: string
  capabilities?: {
    status: "ready" | "degraded" | "failed" | "pending"
    pass: number
    fail: number
    skip: number
    total: number
    lastCheckedAt: string | null
    lastSuccessAt: string | null
    stale: boolean
    lastError: string | null
  }
  onRecheck: (id: string) => void
  busy: boolean
}) {
  const status = capabilities?.status || "pending"
  const label = status === "ready" ? "Ready" : status === "degraded" ? "Degraded" : status === "failed" ? "Unavailable" : "Not measured"
  const variant = status === "ready" ? "default" : status === "degraded" ? "outline" : "destructive"
  const title = capabilities?.lastError
    || (status === "pending"
      ? "Guest capabilities have not been measured. A node we cannot measure is not known to be usable."
      : capabilities?.stale
        ? "This verdict is older than 30 minutes. Re-check to renew it."
        : `${capabilities?.pass ?? 0} of ${capabilities?.total ?? 0} checks passed`)
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={variant} title={title}>{label}</Badge>
      {capabilities?.stale ? <span className="text-[10px] text-muted-foreground">stale</span> : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="Re-measure guest capabilities"
        disabled={busy}
        onClick={() => onRecheck(nodeId)}
      >
        <RefreshCw className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
      </Button>
    </span>
  )
}

function StatusBadge({ status, critical }: { status: string; critical?: boolean }) {
  if (status === "healthy") return <Badge>Healthy</Badge>
  if (status === "warning") return <Badge variant="secondary">Warning</Badge>
  if (status === "critical") return <Badge variant="secondary">Critical</Badge>
  if (status === "full") return <Badge variant="destructive">Full</Badge>
  if (status === "offline") return <Badge variant="destructive">Offline</Badge>
  if (status === "overloaded") return <Badge variant="destructive">Overloaded</Badge>
  if (critical) return <Badge variant="secondary">Critical</Badge>
  return <Badge variant="secondary">Unknown</Badge>
}

function ProvisionCapacity({ value, compact = false }: { value?: ComputeNode["provisionCapacity"]; compact?: boolean }) {
  const priority = value?.priority || "blocked"
  const label = priority === "normal" ? "Allowed" : priority === "low" ? "Low priority" : "Blocked"
  const capacity = value?.remainingVmCapacity === null || value?.remainingVmCapacity === undefined ? "Capacity: auto" : `Capacity: ${value.remainingVmCapacity} left`
  if (compact) return <>{label} · {capacity}</>
  return <div className="whitespace-nowrap text-xs"><Badge variant={priority === "blocked" ? "destructive" : "secondary"}>{label}</Badge><div className="mt-1 text-muted-foreground">{capacity}</div></div>
}

function ConnectionStatus({ state }: { state: TestState }) {
  if (state.status === "idle") return null
  const className = state.status === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : state.status === "failed"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-border/40 bg-background/40 text-muted-foreground"
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        {state.code ? <Badge variant={state.status === "failed" ? "destructive" : "secondary"}>{state.code}</Badge> : null}
        <span>{connectionMessage(state)}</span>
      </div>
      {state.steps.length ? (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="flex items-center gap-1 text-xs underline-offset-4 hover:underline">
            Show diagnostic details
            <ChevronDown className="h-3 w-3" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 max-h-[280px] max-w-full overflow-auto rounded-md border border-border/30 bg-background/50 p-2">
            <div className="min-w-[720px] space-y-1 font-mono text-xs text-foreground">
              {state.steps.map((step, index) => (
                <div key={`${step.name}-${index}`} className="grid grid-cols-[52px_150px_180px_120px_1fr] gap-2">
                  <span className={step.ok ? "text-emerald-400" : "text-destructive"}>{step.ok ? "PASS" : "FAIL"}</span>
                  <span>{step.code}</span>
                  <span className="truncate">{step.name}</span>
                  <span>{step.status ? `HTTP ${step.status}` : `${step.durationMs}ms`}</span>
                  <span className="truncate">{step.endpoint ? `${step.endpoint} - ` : ""}{step.message}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

function connectionMessage(state: TestState) {
  if (state.code === "TCP_TIMEOUT") {
    return "The app server cannot reach Proxmox on TCP port 8006. DNS resolved, but the connection timed out before TLS/auth."
  }
  return state.message
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}
