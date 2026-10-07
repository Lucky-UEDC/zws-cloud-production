"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy, Eye, EyeOff, KeyRound, Link2, Minus, Plus, RefreshCw, Search, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { customerHostnameSlug, generateVmHostnames, planHostnameSlug } from "@/lib/order-bulk"

type Customer = { id: string; email: string; name?: string | null; phone?: string | null; phoneNumber?: string | null }
type Product = { id: string; name: string; cpuCores?: number; ramGb?: number; storageGb?: number; bandwidthTb?: number; price1m: number; price3m?: number; price6m?: number; price12m?: number; price24m?: number; price36m?: number; backupEnabled?: boolean; backupPrice?: number; backupStorageGb?: number; snapshotEnabled?: boolean; snapshotPrice?: number; snapshotIncludedCount?: number; extraIpv4Price?: number }
type Offer = { id: string; name: string; offerMonthlyPrice: number; baseMonthlyPrice: number; vcpu: number; ramGb: number; storageGb: number; bandwidthTb?: number; billingTermsAllowed: number[] }
type OsTemplate = { id: string; name: string; osType?: string | null; category?: string | null; osFamily?: string | null; osVersion?: string | null; family?: string | null; version?: string | null; proxmoxNode?: { id?: string; name?: string; nodeName?: string } | null }
type ProxmoxNode = { id: string; name: string; nodeName: string; status?: string | null; isActive?: boolean }
type Credential = { orderId: string; orderNumber: string; hostname: string; ip: string | null; username: string; password: string; os?: string | null }
type IpPoolOption = { id: string; name: string; poolMode?: string | null; poolType?: string | null; nodeAssignments?: any[]; availableIps?: Array<{ id: string; ipAddress: string; status: string }> }

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function futureIso(days: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function formatInr(value: number) {
  return `INR ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function generatePassword() {
  const requiredGroups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*"]
  const chars = requiredGroups.join("")
  const bytes = new Uint8Array(18)
  globalThis.crypto?.getRandomValues(bytes)
  const required = requiredGroups.map((group, index) => group[bytes[index] % group.length])
  const rest = Array.from(bytes.slice(required.length), (byte) => chars[byte % chars.length])
  return [...required, ...rest].sort(() => Math.random() - 0.5).join("")
}

function templateSearch(template?: OsTemplate | null) {
  return [template?.name, template?.osType, template?.category, template?.osFamily, template?.family].filter(Boolean).join(" ").toLowerCase()
}

function templateKind(template?: OsTemplate | null) {
  const text = templateSearch(template)
  if (/\b(windows|winserver|win\s*server|server\s*20\d{2})/.test(text)) return "windows"
  if (text) return "linux"
  return "unknown"
}

function nodeAllowsTemplate(node: ProxmoxNode, template?: OsTemplate | null) {
  return true
}

function sameTemplateTarget(left?: OsTemplate | null, right?: OsTemplate | null) {
  if (!left || !right) return false
  const leftFamily = String(left.osFamily || left.family || templateKind(left)).toLowerCase()
  const rightFamily = String(right.osFamily || right.family || templateKind(right)).toLowerCase()
  const leftVersion = String(left.osVersion || left.version || left.name).toLowerCase()
  const rightVersion = String(right.osVersion || right.version || right.name).toLowerCase()
  return leftFamily === rightFamily && leftVersion === rightVersion
}

function templateCompatibleWithNode(template: OsTemplate, nodeId: string, nodes: ProxmoxNode[]) {
  if (!nodeId || nodeId === "auto" || nodeId === "product_default") return true
  const node = nodes.find((item) => item.id === nodeId)
  return Boolean(node && template.proxmoxNode?.id === node.id && nodeAllowsTemplate(node, template))
}

function nodeCompatibleWithTemplate(node: ProxmoxNode, template: OsTemplate | null | undefined, templates: OsTemplate[]) {
  if (!template) return true
  if (!nodeAllowsTemplate(node, template)) return false
  return templates.some((candidate) => candidate.proxmoxNode?.id === node.id && sameTemplateTarget(candidate, template))
}

export default function AdminNewOrderPage() {
  const router = useRouter()
  const [selectedCustomerRecord, setSelectedCustomerRecord] = useState<Customer | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [offers, setOffers] = useState<Offer[]>([])
  const [templates, setTemplates] = useState<OsTemplate[]>([])
  const [nodes, setNodes] = useState<ProxmoxNode[]>([])
  const [ipPools, setIpPools] = useState<IpPoolOption[]>([])
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [vmPreview, setVmPreview] = useState<any>(null)
  const [orderPreview, setOrderPreview] = useState<any>(null)
  const [loadingVm, setLoadingVm] = useState(false)
  const [form, setForm] = useState({
    provisioningMode: "auto_provision",
    customerId: "",
    sourceType: "product",
    productId: "",
    offerId: "",
    operatingSystemId: "",
    nodeId: "product_default",
    ipAssignmentMode: "automatic",
    poolId: "",
    requestedIp: "",
    forceIpOverride: false,
    termMonths: "1",
    quantity: "1",
    password: "",
    orderAction: "request_payment",
    discountAmount: "0",
    backupEnabled: false,
    snapshotCount: "0",
    ipv4Count: "1",
    adminNotes: "",
    customerNotes: "",
    linkedVmid: "",
    linkedServiceCreatedAt: todayIso(),
    linkedServiceDueAt: futureIso(30),
    serviceCreatedAt: todayIso(),
    serviceDueAt: futureIso(30),
    provider: "",
    externalVmId: "",
    hostname: "",
    ipAddress: "",
    username: "",
    port: "22",
    operatingSystem: "",
    cpu: "",
    ramGb: "",
    diskGb: "",
    bandwidthTb: "",
    location: "",
  })

  useEffect(() => {
    ;(async () => {
      const [productsRes, offersRes, osRes, nodesRes, ipPoolsRes] = await Promise.all([
        fetch("/api/admin/products"),
        fetch("/api/admin/offers"),
        fetch("/api/admin/os-templates"),
        fetch("/api/admin/proxmox-nodes"),
        fetch("/api/admin/ip-pools?purpose=provisioning"),
      ])
      const [productsBody, offersBody, osBody, nodesBody, poolsBody] = await Promise.all([readJsonResponse<any>(productsRes), readJsonResponse<any>(offersRes), readJsonResponse<any>(osRes), readJsonResponse<any>(nodesRes), readJsonResponse<any>(ipPoolsRes)])
      // A failed catalog API must never look like an empty catalog. This is the
      // exact bug that produced "Product: Select product" with INR 0 pricing:
      // a 401 from /api/admin/products was swallowed and the select rendered
      // empty. Every failure is surfaced instead.
      if (productsRes.ok) {
        setProducts(Array.isArray(productsBody?.products) ? productsBody.products : [])
      } else {
        const reason = productsBody?.error || productsBody?.message || `HTTP ${productsRes.status}`
        setLoadError((current) => current || `Products could not be loaded: ${reason}`)
        toast.error(`Products could not be loaded: ${reason}`)
      }
      if (offersRes.ok) setOffers(Array.isArray(offersBody?.offers) ? offersBody.offers : [])
      else toast.error(`Offers could not be loaded (HTTP ${offersRes.status})`)
      if (osRes.ok) setTemplates(Array.isArray(osBody?.items) ? osBody.items : [])
      else toast.error(`Operating systems could not be loaded (HTTP ${osRes.status})`)
      if (nodesRes.ok) {
        const rawNodes = Array.isArray(nodesBody) ? nodesBody : Array.isArray(nodesBody?.nodes) ? nodesBody.nodes : []
        setNodes(rawNodes.map((node: any) => ({
          id: String(node.id || ""),
          name: String(node.name || node.nodeName || "Node"),
          nodeName: String(node.nodeName || node.name || "node"),
          status: node.status || null,
          isActive: node.isActive !== false,
        })).filter((node: ProxmoxNode) => node.id && node.isActive))
      } else {
        toast.error(`Nodes could not be loaded (HTTP ${nodesRes.status})`)
      }
      if (ipPoolsRes.ok) setIpPools((poolsBody?.pools || []).filter((pool: any) => pool.isActive !== false && String(pool.poolType || "NORMAL").toUpperCase() !== "ADDON_ONLY"))
      else toast.error(`IP pools could not be loaded (HTTP ${ipPoolsRes.status})`)
    })().catch((error) => {
      const message = error?.message || "Failed to load order form data"
      setLoadError(message)
      toast.error(message)
    })
  }, [])

  const selectedCustomer = selectedCustomerRecord?.id === form.customerId ? selectedCustomerRecord : null
  const selectedProduct = products.find((product) => product.id === form.productId)
  const selectedOffer = offers.find((offer) => offer.id === form.offerId)
  const selectedTemplate = templates.find((template) => template.id === form.operatingSystemId)
  const filteredTemplates = templates.filter((template) => templateCompatibleWithNode(template, form.nodeId, nodes))
  const filteredNodes = nodes.filter((node) => nodeCompatibleWithTemplate(node, selectedTemplate, templates))
  const manualNodeId = !form.nodeId || ["auto", "product_default"].includes(form.nodeId) ? "" : form.nodeId
  const filteredIpPools = ipPools.filter((pool) => {
    if (String(pool.poolType || "NORMAL").toUpperCase() === "ADDON_ONLY") return false
    if (!manualNodeId) return true
    if (String(pool.poolMode || "").toUpperCase() === "GLOBAL") return true
    return (pool.nodeAssignments || []).some((row: any) => row.nodeId === manualNodeId && row.active !== false)
  })
  const selectedIpPool = filteredIpPools.find((pool) => pool.id === form.poolId)
  const availableIps = selectedIpPool?.availableIps || []
  const linkingExisting = form.provisioningMode === "link_existing_vm"
  const directService = form.provisioningMode === "external_vm_attachment" || form.provisioningMode === "manual_provision_complete"
  const externalService = form.provisioningMode === "external_vm_attachment"
  const manualComplete = form.provisioningMode === "manual_provision_complete"
  const quantity = linkingExisting || directService ? 1 : Math.max(1, Math.min(100, Math.floor(Number(form.quantity || 1))))
  const fallbackUnitPrice = form.sourceType === "offer"
    ? Number(selectedOffer?.offerMonthlyPrice || 0) * Number(form.termMonths || 1)
    : selectedProduct ? Number((selectedProduct as any)[`price${form.termMonths}m`] || selectedProduct.price1m || 0) : 0
  const previewPricing = orderPreview?.pricing || null
  const unitPrice = Number(previewPricing?.unitPrice ?? fallbackUnitPrice)
  const subtotal = Number(previewPricing?.subtotal ?? (unitPrice * quantity).toFixed(2))
  const bulkDiscount = Number(previewPricing?.automaticBulkDiscount || 0)
  const bulkDiscountApplied = bulkDiscount > 0
  const manualDiscount = Math.max(0, Number(form.discountAmount || 0))
  const taxable = Number(previewPricing?.taxableAmount ?? Math.max(0, subtotal - manualDiscount - bulkDiscount))
  const tax = Number(previewPricing?.taxAmount || 0)
  const total = Number(previewPricing?.totalAmount ?? (taxable + tax))
  const planName = selectedOffer?.name || selectedProduct?.name || "plan"
  const customerName = selectedCustomer?.name || selectedCustomer?.email || "client"
  const generatedHostnames = directService && form.hostname ? [form.hostname] : generateVmHostnames({ planName: planHostnameSlug(planName), customerName: customerHostnameSlug(customerName), quantity })
  const passwordStrength = form.password.length >= 14 ? "Strong" : form.password.length >= 8 ? "Usable" : "Too short"
  const termOptions = form.sourceType === "offer" && selectedOffer?.billingTermsAllowed?.length
    ? selectedOffer.billingTermsAllowed.map((term) => [String(term), `${term} month${term === 1 ? "" : "s"}`])
    : [["1", "1 month"], ["3", "3 months"], ["6", "6 months"], ["12", "12 months"], ["24", "24 months"], ["36", "36 months"]]
  const previewMatchesSelection = Boolean(
    linkingExisting &&
    vmPreview &&
    String(vmPreview.nodeId || "") === String(form.nodeId || "") &&
    Number(vmPreview.vmid || 0) === Number(form.linkedVmid || 0)
  )
  const linkedVmReady = Boolean(previewMatchesSelection && vmPreview?.validation?.ok === true)

  useEffect(() => {
    if (form.operatingSystemId && !filteredTemplates.some((template) => template.id === form.operatingSystemId)) {
      setForm((current) => ({ ...current, operatingSystemId: "" }))
    }
  }, [filteredTemplates, form.operatingSystemId])

  useEffect(() => {
    if (!form.nodeId || ["auto", "product_default"].includes(form.nodeId)) return
    if (!filteredNodes.some((node) => node.id === form.nodeId)) {
      setForm((current) => ({ ...current, nodeId: "auto" }))
    }
  }, [filteredNodes, form.nodeId])

  useEffect(() => {
    const productId = form.sourceType === "product" ? form.productId : ""
    const offerId = form.sourceType === "offer" ? form.offerId : ""
    if (!productId && !offerId) {
      setOrderPreview(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetch("/api/admin/orders/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...form,
          productId,
          offerId,
          termMonths: Number(form.termMonths),
          quantity,
          discountAmount: manualDiscount,
          backupEnabled: form.backupEnabled,
          snapshotCount: Number(form.snapshotCount || 0),
          ipv4Count: Number(form.ipv4Count || 1),
        }),
      })
        .then((res) => readJsonResponse<any>(res).then((body) => ({ res, body })))
        .then(({ res, body }) => {
          if (!res.ok) throw new Error(body?.error || "Unable to calculate preview")
          setOrderPreview(body.preview || null)
        })
        .catch((error) => {
          if (error?.name !== "AbortError") setOrderPreview(null)
        })
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [form, quantity, manualDiscount])

  async function copy(value: string, label = "Copied") {
    await navigator.clipboard.writeText(value)
    toast.success(label)
  }

  async function submit() {
    if (linkingExisting && (!form.nodeId || ["auto", "product_default"].includes(form.nodeId) || !form.linkedVmid)) return toast.error("Choose a node and VMID to link")
    if (linkingExisting && !linkedVmReady) return toast.error(vmPreview?.validation?.error || "Load and validate the VM before creating the order")
    if (directService) {
      const missing = [
        !form.provider ? "provider" : null,
        externalService && !form.externalVmId ? "external VM ID" : null,
        !form.hostname ? "hostname" : null,
        !form.ipAddress ? "IP address" : null,
        !form.username ? "username" : null,
        !form.password ? "password" : null,
        !form.operatingSystem ? "operating system" : null,
        !form.cpu ? "CPU" : null,
        !form.ramGb ? "RAM" : null,
        !form.diskGb ? "disk" : null,
        !form.bandwidthTb ? "bandwidth" : null,
      ].filter(Boolean)
      if (missing.length) return toast.error(`${missing.join(", ")} required`)
    }
    if (form.password && form.password.length < 8) return toast.error("Password must be at least 8 characters")
    if (!directService && form.ipAssignmentMode === "manual") {
      if (!form.poolId || !form.requestedIp) return toast.error("Choose an IP pool and available IP")
      if (quantity > 1) return toast.error("Manual IP selection is available for one VM at a time")
    }
    setSaving(true)
    setCredentials([])
    try {
      const res = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...form,
          nodeId: form.nodeId,
          ipAssignmentMode: form.ipAssignmentMode,
          poolId: form.poolId || null,
          requestedIp: form.requestedIp || null,
          forceIpOverride: form.forceIpOverride,
          accessMethod: "PASSWORD",
          sshPublicKey: "",
          productId: form.sourceType === "product" ? form.productId : "",
          offerId: form.sourceType === "offer" ? form.offerId : "",
          termMonths: Number(form.termMonths),
          quantity: linkingExisting || directService ? 1 : quantity,
          discountAmount: manualDiscount,
          provisioningMode: form.provisioningMode,
          linkedNodeId: linkingExisting ? form.nodeId : null,
          linkedVmid: linkingExisting ? Number(form.linkedVmid) : null,
          linkedServiceCreatedAt: linkingExisting ? form.linkedServiceCreatedAt : null,
          linkedServiceDueAt: linkingExisting ? form.linkedServiceDueAt : null,
        }),
      })
      const body = await readJsonResponse<any>(res) || {}
      if (!res.ok) throw new Error(body.error || "Failed to create order")
      setCredentials(body.credentials || [])
      toast.success(quantity > 1 ? `${quantity} orders created` : "Order created")
      if (body.redirectTo) router.push(String(body.redirectTo))
    } catch (error: any) {
      toast.error(error?.message || "Failed to create order")
    } finally {
      setSaving(false)
    }
  }

  async function loadVmPreview() {
    if (!form.nodeId || ["auto", "product_default"].includes(form.nodeId) || !form.linkedVmid) return toast.error("Choose a node and VMID first")
    setLoadingVm(true)
    setVmPreview(null)
    try {
      const res = await fetch("/api/admin/vms/existing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: form.nodeId, vmid: Number(form.linkedVmid) }),
      })
      const body = await readJsonResponse<any>(res)
      if (!res.ok || !body?.success) throw new Error(body?.error || "Unable to load VM")
      setVmPreview(body.preview)
      if (!body.preview?.validation?.ok) toast.error(body.preview?.validation?.error || "VM validation failed")
      else if (body.preview?.assigned) toast.error(`Already assigned to ${body.preview.assigned.customer}`)
      else toast.success("VM details loaded")
    } catch (error: any) {
      toast.error(error?.message || "Unable to load VM")
    } finally {
      setLoadingVm(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Create Order</h1>
          <p className="mt-1 text-sm text-muted-foreground">Create one or many VM orders with generated hostnames and shared access credentials.</p>
        </div>
        <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3.5 w-3.5" />Bulk discount auto-applies at 10+ VMs</Badge>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="glass border-border/40">
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
            <CardDescription>Hostnames are generated automatically from plan and customer name.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <CustomerSearch
              value={form.customerId}
              selected={selectedCustomerRecord}
              onSelect={(customer) => {
                setSelectedCustomerRecord(customer)
                setForm({ ...form, customerId: customer.id })
              }}
            />
            <SelectField
              label="Provisioning Mode"
              value={form.provisioningMode}
              onChange={(provisioningMode) => {
                const single = ["link_existing_vm", "external_vm_attachment", "manual_provision_complete"].includes(provisioningMode)
                setVmPreview(null)
                setForm({
                  ...form,
                  provisioningMode,
                  orderAction: single ? "paid_activate" : form.orderAction,
                  quantity: single ? "1" : form.quantity,
                  nodeId: provisioningMode === "link_existing_vm" && ["auto", "product_default"].includes(form.nodeId) ? "" : form.nodeId,
                })
              }}
              options={[
                ["auto_provision", "Auto Provision"],
                ["link_existing_vm", "Link Existing VM"],
                ["external_vm_attachment", "External VM Attachment"],
                ["manual_provision_complete", "Manual Provision Complete"],
              ]}
            />
            <SelectField label="Order source" value={form.sourceType} onChange={(sourceType) => setForm({ ...form, sourceType, productId: "", offerId: "" })} options={[["product", "Product"], ["offer", "Offer"]]} />
            {loadError ? (
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <div className="font-medium">Order form data is incomplete</div>
                <div>{loadError}</div>
                <div className="text-xs">An empty product list means the catalog could not be read, not that there are no products. Pricing below is not trustworthy until this is resolved.</div>
              </div>
            ) : null}
            {form.sourceType === "product" ? (
              <SelectField
                label="Product"
                value={form.productId}
                onChange={(productId) => setForm({ ...form, productId })}
                options={products.map((product) => [product.id, `${product.name} — ₹${Number(product.price1m || 0).toLocaleString("en-IN")}/mo`])}
                emptyMessage={loadError ? "Products could not be loaded" : "No active products in the catalog"}
              />
            ) : null}
            {form.sourceType === "offer" ? <SelectField label="Offer" value={form.offerId} onChange={(offerId) => setForm({ ...form, offerId })} options={offers.map((offer) => [offer.id, `${offer.name} - ${offer.vcpu} vCPU / ${offer.ramGb}GB`])} /> : null}
            {!directService ? <SelectField label="OS / Template" value={form.operatingSystemId} onChange={(operatingSystemId) => setForm({ ...form, operatingSystemId })} options={filteredTemplates.map((template) => [template.id, `${template.name}${template.proxmoxNode?.name ? ` - ${template.proxmoxNode.name}` : ""}`])} /> : null}
            {!directService ? (
              <SelectField
                label={linkingExisting ? "Node" : "Provision Node"}
                value={form.nodeId}
                onChange={(nodeId) => { setVmPreview(null); setForm({ ...form, nodeId }) }}
                options={[
                  ...(linkingExisting ? [] : [["product_default", "Product Default"], ["auto", "Auto Select"]] as string[][]),
                  ...filteredNodes.map((node) => [node.id, `${node.name} (${node.nodeName})${node.status ? ` - ${node.status}` : ""}`] as [string, string]),
                ]}
              />
            ) : null}
            {linkingExisting ? (
              <div className="space-y-2">
                <Label>VMID</Label>
                <div className="flex gap-2">
                  <Input inputMode="numeric" value={form.linkedVmid} onChange={(event) => { setVmPreview(null); setForm({ ...form, linkedVmid: event.target.value }) }} />
                  <Button type="button" variant="outline" disabled={loadingVm} onClick={() => void loadVmPreview()} className="shrink-0 gap-2">
                    {loadingVm ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Load VM
                  </Button>
                </div>
              </div>
            ) : null}
            {linkingExisting && vmPreview ? (
              <div className={`rounded-md border p-3 text-sm md:col-span-2 ${vmPreview.validation?.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-destructive/50 bg-destructive/10"}`}>
                <div className="mb-2 flex items-center gap-2 font-medium"><Link2 className="h-4 w-4" />VM Preview</div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Summary label="Name" value={String(vmPreview.name || "-")} />
                  <Summary label="VMID" value={String(vmPreview.vmid || "-")} />
                  <Summary label="Node" value={String(vmPreview.nodeLabel ? `${vmPreview.nodeLabel} (${vmPreview.nodeName || vmPreview.node})` : vmPreview.nodeName || vmPreview.node || "-")} />
                  <Summary label="CPU" value={vmPreview.cpu ? `${vmPreview.cpu}` : "-"} />
                  <Summary label="RAM" value={vmPreview.ramGb ? `${vmPreview.ramGb} GB` : "-"} />
                  <Summary label="Disk" value={vmPreview.diskGb ? `${vmPreview.diskGb} GB` : "-"} />
                  <Summary label="IP" value={vmPreview.ip || "-"} />
                  <Summary label="OS" value={vmPreview.os || "-"} />
                  <Summary label="Status" value={vmPreview.status || "-"} />
                  <Summary label="Uptime" value={formatDuration(Number(vmPreview.uptimeSeconds || 0))} />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  {(vmPreview.validation?.checks || []).map((check: any) => (
                    <div key={check.key} className={`rounded-md border px-2 py-1 text-xs ${check.ok ? "border-emerald-500/30 text-emerald-300" : "border-destructive/40 text-destructive"}`}>
                      {check.label}: {check.ok ? "OK" : check.error || "Failed"}
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  <div className="text-xs text-muted-foreground">Current Notes</div>
                  <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-background/70 p-2 text-xs">{vmPreview.currentNotes || vmPreview.notes || "-"}</pre>
                </div>
                {vmPreview.assigned ? <p className="mt-3 text-xs text-destructive">Already assigned to {vmPreview.assigned.customer} ({vmPreview.assigned.order}).</p> : null}
                {!previewMatchesSelection ? <p className="mt-3 text-xs text-destructive">Preview is stale. Load the VM again for the selected node and VMID.</p> : null}
              </div>
            ) : null}
            {directService ? (
              <div className="grid gap-4 rounded-md border border-border/40 bg-background/40 p-3 md:col-span-2 md:grid-cols-2">
                <Field label={externalService ? "External Provider" : "Provider"} value={form.provider} onChange={(provider) => setForm({ ...form, provider })} />
                {externalService ? <Field label="External VM ID" value={form.externalVmId} onChange={(externalVmId) => setForm({ ...form, externalVmId })} /> : <Field label="Port" value={form.port} onChange={(port) => setForm({ ...form, port })} />}
                <Field label="Hostname" value={form.hostname} onChange={(hostname) => setForm({ ...form, hostname })} />
                <Field label="IP Address" value={form.ipAddress} onChange={(ipAddress) => setForm({ ...form, ipAddress })} />
                <Field label="Username" value={form.username} onChange={(username) => setForm({ ...form, username })} />
                <Field label="Operating System" value={form.operatingSystem} onChange={(operatingSystem) => setForm({ ...form, operatingSystem })} />
                <Field label="CPU" type="number" value={form.cpu} onChange={(cpu) => setForm({ ...form, cpu })} />
                <Field label="RAM GB" type="number" value={form.ramGb} onChange={(ramGb) => setForm({ ...form, ramGb })} />
                <Field label="Disk GB" type="number" value={form.diskGb} onChange={(diskGb) => setForm({ ...form, diskGb })} />
                <Field label="Bandwidth TB" type="number" value={form.bandwidthTb} onChange={(bandwidthTb) => setForm({ ...form, bandwidthTb })} />
                <Field label="Location" value={form.location} onChange={(location) => setForm({ ...form, location })} />
                <Field label="Service Created Date" type="date" value={form.serviceCreatedAt} onChange={(serviceCreatedAt) => setForm({ ...form, serviceCreatedAt })} />
                <Field label="Service Due Date" type="date" value={form.serviceDueAt} onChange={(serviceDueAt) => setForm({ ...form, serviceDueAt })} />
              </div>
            ) : null}
            {!directService ? <SelectField label="IP Assignment Mode" value={form.ipAssignmentMode} onChange={(ipAssignmentMode) => setForm({ ...form, ipAssignmentMode, poolId: ipAssignmentMode === "automatic" ? "" : form.poolId, requestedIp: ipAssignmentMode === "automatic" ? "" : form.requestedIp })} options={[["automatic", "Automatic"], ["manual", "Manual"]]} /> : null}
            {!directService && form.ipAssignmentMode === "manual" ? (
              <>
                <SelectField label="IP Pool" value={form.poolId} onChange={(poolId) => setForm({ ...form, poolId, requestedIp: "" })} options={filteredIpPools.map((pool) => [pool.id, `${pool.name} (${pool.availableIps?.length || 0} available)`])} />
                <SelectField label="Available IP" value={form.requestedIp} onChange={(requestedIp) => setForm({ ...form, requestedIp })} options={availableIps.map((ip) => [ip.ipAddress, ip.ipAddress])} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.forceIpOverride} onChange={(event) => setForm({ ...form, forceIpOverride: event.target.checked })} />
                  Admin IP override
                </label>
              </>
            ) : null}
            {selectedProduct ? (
              <div className="grid gap-4 rounded-md border border-border/40 bg-background/40 p-3 md:col-span-2 md:grid-cols-3">
                {selectedProduct.backupEnabled ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.backupEnabled} onChange={(event) => setForm({ ...form, backupEnabled: event.target.checked })} />
                    Backup {selectedProduct.backupPrice ? `(${formatInr(Number(selectedProduct.backupPrice))}/mo)` : ""}
                  </label>
                ) : null}
                {selectedProduct.snapshotEnabled ? <Field label="Snapshots" type="number" value={form.snapshotCount} onChange={(snapshotCount) => setForm({ ...form, snapshotCount })} min={0} /> : null}
                {Number(selectedProduct.extraIpv4Price || 0) > 0 ? <Field label="IPv4 Addresses" type="number" value={form.ipv4Count} onChange={(ipv4Count) => setForm({ ...form, ipv4Count })} min={1} /> : null}
              </div>
            ) : null}
            <SelectField label="Billing Term" value={form.termMonths} onChange={(termMonths) => setForm({ ...form, termMonths })} options={termOptions} />
            <QuantityStepper label="Quantity" value={linkingExisting || directService ? 1 : quantity} onChange={(nextQuantity) => setForm({ ...form, quantity: String(nextQuantity) })} disabled={linkingExisting || directService} />
            {linkingExisting ? (
              <>
                <Field label="Service Created Date" type="date" value={form.linkedServiceCreatedAt} onChange={(linkedServiceCreatedAt) => setForm({ ...form, linkedServiceCreatedAt })} />
                <Field label="Service Due Date" type="date" value={form.linkedServiceDueAt} onChange={(linkedServiceDueAt) => setForm({ ...form, linkedServiceDueAt })} />
              </>
            ) : null}
            <SelectField label="Order Status" value={form.orderAction} onChange={(orderAction) => setForm({ ...form, orderAction })} options={directService ? [["paid_activate", "Create active service"]] : linkingExisting ? [["paid_activate", "Paid / link immediately"], ["request_payment", "Unpaid / link immediately"]] : [["request_payment", "Request payment from user"], ["paid_activate", "Paid / provision immediately"], ["draft_invoice", "Draft invoice only"]]} />
            <div className="rounded-md border border-border/40 bg-background/40 p-3 md:col-span-2">
              <div className="text-xs text-muted-foreground">Generated hostnames</div>
              <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
                {generatedHostnames.map((hostname) => (
                  <div key={hostname} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2">
                    <span className="min-w-0 truncate font-mono text-sm">{hostname}</span>
                    <Button size="sm" variant="outline" onClick={() => copy(hostname, "Hostname copied")}><Copy className="mr-2 h-4 w-4" />Copy</Button>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Password</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input type={showPassword ? "text" : "password"} value={form.password} placeholder="Blank generates a secure shared password" onChange={(event) => setForm({ ...form, password: event.target.value })} className="pr-10" />
                  <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0" onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
                </div>
                <Button type="button" variant="outline" onClick={() => setForm({ ...form, password: generatePassword() })}><KeyRound className="mr-2 h-4 w-4" />Generate</Button>
                <Button type="button" variant="outline" size="icon" onClick={() => copy(form.password, "Password copied")} disabled={!form.password}><Copy className="h-4 w-4" /></Button>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Strength: {passwordStrength}</span>{quantity > 1 ? <span className="text-amber-300">Password will apply to all selected VMs.</span> : null}</div>
              <div className="h-1.5 rounded-full bg-muted">
                <div className={`h-1.5 rounded-full transition-all ${form.password.length >= 14 ? "w-full bg-emerald-500" : form.password.length >= 8 ? "w-2/3 bg-amber-500" : "w-1/3 bg-destructive"}`} />
              </div>
            </div>
            <Field label="Manual Discount Amount" value={form.discountAmount} onChange={(discountAmount) => setForm({ ...form, discountAmount })} />
            <div className="space-y-2 md:col-span-2"><Label>Admin Notes</Label><Textarea value={form.adminNotes} onChange={(event) => setForm({ ...form, adminNotes: event.target.value })} /></div>
            <div className="space-y-2 md:col-span-2"><Label>Customer Notes</Label><Textarea value={form.customerNotes} onChange={(event) => setForm({ ...form, customerNotes: event.target.value })} /></div>
            <div className="md:col-span-2"><Button onClick={submit} disabled={saving || !form.customerId || (!form.productId && !form.offerId) || (linkingExisting && !linkedVmReady)} className="gap-2">{saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : linkingExisting ? <Link2 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{saving ? "Creating..." : linkingExisting ? "Create And Link VM" : directService ? "Create Active Service" : "Create Order"}</Button></div>
          </CardContent>
        </Card>

        <Card className="h-fit border-border/40">
          <CardHeader><CardTitle>Pricing</CardTitle><CardDescription>Live quantity and discount calculation.</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Summary label="Unit price" value={formatInr(unitPrice)} />
            <Summary label="Quantity" value={String(quantity)} />
            <Summary label="Subtotal" value={formatInr(subtotal)} />
            {bulkDiscountApplied ? <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">Bulk discount applied (10% OFF)</div> : null}
            <Summary label="Bulk discount" value={`-${formatInr(bulkDiscount)}`} />
            <Summary label="Manual discount" value={`-${formatInr(manualDiscount)}`} />
            <Summary label="GST" value={formatInr(tax)} />
            <div className="flex justify-between border-t border-border/40 pt-3 text-base font-semibold"><span>Final total</span><span>{formatInr(total)}</span></div>
            <div className="border-t border-border/40 pt-3">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Configuration</div>
              <div className="space-y-2">
                <Summary label="CPU" value={`${orderPreview?.resourceSummary?.cpu ?? selectedOffer?.vcpu ?? selectedProduct?.cpuCores ?? "-"} vCPU`} />
                <Summary label="RAM" value={`${orderPreview?.resourceSummary?.ramGb ?? selectedOffer?.ramGb ?? selectedProduct?.ramGb ?? "-"} GB`} />
                <Summary label="Disk" value={`${orderPreview?.resourceSummary?.diskGb ?? selectedOffer?.storageGb ?? selectedProduct?.storageGb ?? "-"} GB`} />
                <Summary label="Bandwidth" value={`${orderPreview?.resourceSummary?.bandwidthTb ?? selectedOffer?.bandwidthTb ?? (selectedProduct as any)?.bandwidthTb ?? "-"} TB`} />
                <Summary label="Backups" value={String(orderPreview?.resourceSummary?.backups ?? (form.backupEnabled ? "Enabled" : "Disabled"))} />
                <Summary label="Snapshots" value={String(orderPreview?.resourceSummary?.snapshots ?? form.snapshotCount)} />
                <Summary label="IPs" value={String(Number(form.ipv4Count || 1))} />
                <Summary label="OS" value={String(orderPreview?.configSummary?.os || selectedTemplate?.name || form.operatingSystem || "-")} />
                <Summary label="Node" value={directService ? "No Proxmox required" : String(orderPreview?.configSummary?.node || (form.nodeId === "product_default" ? "Product default" : form.nodeId === "auto" ? "Auto select" : nodes.find((node) => node.id === form.nodeId)?.name || "-"))} />
                <Summary label="Billing Term" value={`${form.termMonths} month${form.termMonths === "1" ? "" : "s"}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {credentials.length ? (
        <Card className="border-border/40">
          <CardHeader><CardTitle>VM Credentials</CardTitle><CardDescription>Copyable credentials generated for this order batch.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-2">
            {credentials.map((item) => {
              const block = `IP: ${item.ip || "Pending assignment"}\nUSER: ${item.username}\nPASSWORD: ${item.password}`
              return (
                <div key={item.orderId} className="rounded-lg border border-border/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div><div className="font-medium">{item.hostname}</div><div className="text-xs text-muted-foreground">{item.orderNumber} · {item.os || selectedTemplate?.name || "OS"}</div></div>
                    <Button size="sm" variant="outline" onClick={() => copy(block, "Credential block copied")}><Copy className="mr-2 h-4 w-4" />Copy block</Button>
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">{block}</pre>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="font-medium">{value}</span></div>
}

function Field({ label, value, onChange, type = "text", min, max }: { label: string; value: string; onChange: (value: string) => void; type?: string; min?: number; max?: number }) {
  return <div className="space-y-2"><Label>{label}</Label><Input type={type} min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} /></div>
}

function QuantityStepper({ label, value, onChange, disabled = false }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean }) {
  const set = (next: number) => onChange(Math.max(1, Math.min(100, Math.floor(Number(next) || 1))))
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex h-11 items-center rounded-xl border border-border/50 bg-background/60 p-1 transition focus-within:border-accent">
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={() => set(value - 1)} disabled={disabled || value <= 1} aria-label="Decrease quantity">
          <Minus className="h-4 w-4" />
        </Button>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={String(value)}
          onChange={(event) => set(Number(event.target.value || 1))}
          disabled={disabled}
          className="h-9 min-w-0 flex-1 bg-transparent px-2 text-center font-mono text-base font-semibold outline-none"
          aria-label="Quantity"
        />
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={() => set(value + 1)} disabled={disabled || value >= 100} aria-label="Increase quantity">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function CustomerSearch({ value, selected, onSelect }: { value: string; selected: Customer | null; onSelect: (customer: Customer) => void }) {
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<Customer[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const debounced = useMemo(() => query.trim(), [query])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: "50" })
        if (debounced) params.set("search", debounced)
        const response = await fetch(`/api/admin/customers?${params}`, { signal: controller.signal, cache: "no-store" })
        const body = await readJsonResponse<any>(response)
        if (!response.ok) throw new Error(body?.error || "Customer search failed")
        const next = Array.isArray(body.customers) ? body.customers : []
        setRows((current) => page === 1 ? next : [...current, ...next.filter((item: Customer) => !current.some((row) => row.id === item.id))])
        setPages(Math.max(1, Number(body.pagination?.pages || 1)))
      } catch (error: any) {
        if (error?.name !== "AbortError") toast.error(error?.message || "Customer search failed")
      } finally {
        setLoading(false)
      }
    }, page === 1 ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [debounced, page])

  const rowHeight = 56
  const viewportHeight = 280
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const end = Math.min(rows.length, start + Math.ceil(viewportHeight / rowHeight) + 4)
  const visible = rows.slice(start, end)
  const label = selected && selected.id === value ? `${selected.name || selected.email} (${selected.email})` : ""

  function choose(customer: Customer) {
    onSelect(customer)
    setQuery("")
    setOpen(false)
  }

  return (
    <div className="relative space-y-2">
      <Label>Customer</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          value={open ? query : label}
          placeholder="Search name, email, or phone"
          className="pl-9"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(event) => { setQuery(event.target.value); setPage(1); setHighlighted(0); setScrollTop(0); setOpen(true) }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setHighlighted((index) => Math.min(rows.length - 1, index + 1)) }
            if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted((index) => Math.max(0, index - 1)) }
            if (event.key === "Enter" && rows[highlighted]) { event.preventDefault(); choose(rows[highlighted]) }
            if (event.key === "Escape") setOpen(false)
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls="customer-search-results"
        />
      </div>
      {open ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-xl" id="customer-search-results">
          <div
            className="overflow-y-auto"
            style={{ height: viewportHeight }}
            onScroll={(event) => {
              const element = event.currentTarget
              setScrollTop(element.scrollTop)
              if (!loading && page < pages && element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 2) setPage((current) => current + 1)
            }}
          >
            <div className="relative" style={{ height: Math.max(viewportHeight, rows.length * rowHeight) }}>
              {visible.map((customer, offset) => {
                const index = start + offset
                const phone = customer.phoneNumber || customer.phone
                return (
                  <button
                    type="button"
                    key={customer.id}
                    className={`absolute left-0 flex w-full items-center justify-between gap-3 px-3 text-left text-sm ${index === highlighted ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    style={{ top: index * rowHeight, height: rowHeight }}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => choose(customer)}
                  >
                    <span className="min-w-0"><span className="block truncate font-medium">{customer.name || "Unnamed customer"}</span><span className="block truncate text-xs text-muted-foreground">{customer.email}</span></span>
                    {phone ? <span className="shrink-0 text-xs text-muted-foreground">{phone}</span> : null}
                  </button>
                )
              })}
              {!loading && !rows.length ? <div className="p-4 text-sm text-muted-foreground">No customers found.</div> : null}
            </div>
          </div>
          {loading ? <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground"><RefreshCw className="mr-2 inline h-3 w-3 animate-spin" />Searching customers</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function SelectField({ label, value, onChange, options, emptyMessage }: { label: string; value: string; onChange: (value: string) => void; options: string[][]; emptyMessage?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder={`Select ${label.toLowerCase()}`} /></SelectTrigger>
        <SelectContent>
          {options.length ? options.map(([optionValue, optionLabel]) => <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>) : (
            // An empty dropdown with only a placeholder is indistinguishable
            // from a loading state. Say what actually happened.
            <SelectItem value="__empty" disabled>{emptyMessage || `No ${label.toLowerCase()} available`}</SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}
