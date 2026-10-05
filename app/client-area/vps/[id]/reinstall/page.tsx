"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import Image from "next/image"
import { useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { AlertTriangle, ArrowLeft, Check, Eye, EyeOff, KeyRound, RefreshCw, Server } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Container } from "@/components/layout/container"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { getResolvedOsIcon, handleOsIconError } from "@/lib/os-icons"

type VpsStatus = {
  hostname?: string
  os?: string | null
  ipAddress?: string | null
  status?: string
  displayStatus?: string
  job?: { id: string; status: string; progress?: number; etaSeconds?: number; displayStatus?: string; liveLogCursor?: string | null } | null
  steps?: Array<{ id: string; step: string; status: string; label: string; message?: string; startedAt?: string; completedAt?: string }>
}

type Template = {
  id: string
  name: string
  slug: string
  iconUrl?: string | null
  osFamily?: string | null
  osVersion?: string | null
  category?: string | null
  proxmoxTemplateName?: string | null
  family?: string | null
  familyLabel?: string | null
  version?: string | null
  defaultUsername?: string | null
  architecture?: string | null
  metadata?: Record<string, unknown> | null
}

function familyForTemplate(template: Template) {
  if (template.familyLabel) return template.familyLabel
  if (template.family === "windows") return "Windows Server"
  const source = `${template.osFamily || ""} ${template.category || ""} ${template.name || ""} ${template.slug || ""} ${template.proxmoxTemplateName || ""}`.toLowerCase()
  if (source.includes("windows") || source.includes("winserver") || source.includes("win-server")) return "Windows Server"
  if (source.includes("ubuntu")) return "Ubuntu"
  if (source.includes("debian")) return "Debian"
  if (source.includes("alma")) return "AlmaLinux"
  if (source.includes("rocky")) return "Rocky Linux"
  if (source.includes("centos") || source.includes("cent os")) return "CentOS"
  return template.osFamily || "Other"
}

function osTitle(template: Template) {
  const family = familyForTemplate(template)
  const version = template.version || template.osVersion || ""
  if (version && template.name.toLowerCase().includes(version.toLowerCase())) return template.name
  if (version && template.name.toLowerCase().includes(family.toLowerCase())) return template.name
  if (version) return `${family} ${version}`.trim()
  return template.name || family
}

function osArchitecture(template: Template) {
  const raw = template.architecture || String(template.metadata?.architecture || template.metadata?.arch || "")
  if (/32|i386|x86\b/i.test(raw)) return "32-bit"
  if (/arm64|aarch64/i.test(raw)) return "ARM64"
  return "64-bit"
}

function passwordStrength(value: string) {
  let score = 0
  if (value.length >= 12) score += 1
  if (value.length >= 16) score += 1
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1
  if (/\d/.test(value)) score += 1
  if (/[^A-Za-z0-9]/.test(value)) score += 1
  const label = score >= 5 ? "Excellent" : score >= 4 ? "Strong" : score >= 3 ? "Good" : score >= 2 ? "Weak" : "Too weak"
  return { score, label }
}

export default function ReinstallVpsPage() {
  const { id } = useParams()
  const [status, setStatus] = useState<VpsStatus | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateId, setTemplateId] = useState("")
  const [hostname, setHostname] = useState("")
  const [adminUsername, setAdminUsername] = useState("root")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const [logs, setLogs] = useState<Array<{ id: string; createdAt: string; level: string; title?: string; message: string }>>([])
  const [submitting, setSubmitting] = useState(false)
  const [job, setJob] = useState<VpsStatus["job"]>(null)
  const [steps, setSteps] = useState<NonNullable<VpsStatus["steps"]>>([])
  const [allowance, setAllowance] = useState<{ allowed: boolean; reason: string | null; remaining: number; monthlyLimit: number; nextResetAt: string } | null>(null)
  // One operation id per submitted reinstall attempt: a retried submit (double
  // click, network retry, page reload) reuses it, so only one reinstall is
  // ever consumed from the monthly allowance.
  const [operationId, setOperationId] = useState("")

  useEffect(() => {
    async function load() {
      const statusRes = await fetch(`/api/client/vps/${id}/status`, { cache: "no-store" })
      const statusData = await readJsonResponse<any>(statusRes)
      if (statusRes.ok) {
        setStatus(statusData)
        setHostname(String(statusData.hostname || ""))
        if (statusData.job?.id && statusData.job?.status !== "completed") setJob(statusData.job)
        setSteps(Array.isArray(statusData.steps) ? statusData.steps : [])
      }
      const query = id ? `?vpsId=${encodeURIComponent(String(id))}` : ""
      const templatesRes = await fetch(`/api/os-templates${query}`, { cache: "no-store" })
      const templatesData = await readJsonResponse<any>(templatesRes)
      if (templatesRes.ok) setTemplates(Array.isArray(templatesData) ? templatesData : templatesData.templates || [])
      const logsRes = await fetch(`/api/client/vps/${id}/logs`, { cache: "no-store" })
      const logsData = await readJsonResponse<any>(logsRes)
      if (logsRes.ok) setLogs(Array.isArray(logsData.logs) ? logsData.logs.slice(0, 8) : [])
      const allowanceRes = await fetch(`/api/client/vps/${id}/reinstall`, { cache: "no-store" })
      const allowanceData = await readJsonResponse<any>(allowanceRes)
      if (allowanceRes.ok && allowanceData?.allowance) setAllowance(allowanceData.allowance)
    }
    if (id) void load().catch(() => toast.error("Unable to load reinstall options"))
  }, [id])

  useEffect(() => {
    if (!id || !job?.id || ["completed", "failed", "cancelled"].includes(String(job.status))) return
    let stopped = false
    const refresh = async () => {
      const [statusRes, logsRes] = await Promise.all([
        fetch(`/api/client/vps/${id}/status`, { cache: "no-store" }),
        fetch(`/api/client/vps/${id}/logs`, { cache: "no-store" }),
      ])
      const [statusData, logsData] = await Promise.all([readJsonResponse<any>(statusRes), readJsonResponse<any>(logsRes)])
      if (stopped) return
      if (statusRes.ok) {
        setStatus(statusData)
        setJob(statusData.job || null)
        setSteps(Array.isArray(statusData.steps) ? statusData.steps : [])
      }
      if (logsRes.ok) setLogs(Array.isArray(logsData.logs) ? logsData.logs.slice(0, 30) : [])
    }
    const timer = setInterval(() => void refresh().catch(() => null), 2_000)
    void refresh().catch(() => null)
    return () => { stopped = true; clearInterval(timer) }
  }, [id, job?.id, job?.status])

  const sortedTemplates = useMemo(() => {
    const preferred = ["Windows Server", "Ubuntu", "Debian", "AlmaLinux", "Rocky Linux", "CentOS"]
    return [...templates].sort((a, b) => {
      const familyA = familyForTemplate(a)
      const familyB = familyForTemplate(b)
      const indexA = preferred.includes(familyA) ? preferred.indexOf(familyA) : preferred.length
      const indexB = preferred.includes(familyB) ? preferred.indexOf(familyB) : preferred.length
      if (indexA !== indexB) return indexA - indexB
      return osTitle(a).localeCompare(osTitle(b))
    })
  }, [templates])
  const recommendedIds = useMemo(() => {
    const seen = new Set<string>()
    const ids = new Set<string>()
    for (const item of sortedTemplates) {
      const familyName = familyForTemplate(item)
      if (seen.has(familyName)) continue
      seen.add(familyName)
      ids.add(item.id)
    }
    return ids
  }, [sortedTemplates])
  const selectedTemplate = templates.find((item) => item.id === templateId) || null
  const strength = passwordStrength(password)
  const expectedHostname = String(status?.hostname || hostname || "").trim()
  const confirmationAccepted = confirmation.trim() === "REINSTALL" || (expectedHostname ? confirmation.trim() === expectedHostname : false)
  const canSubmit = Boolean(templateId && adminUsername.trim() && password.length >= 12 && strength.score >= 3 && confirmationAccepted && !submitting && allowance?.allowed !== false)

  async function generatePassword() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
    const bytes = new Uint32Array(22)
    if (typeof window !== "undefined" && window.crypto) window.crypto.getRandomValues(bytes)
    const next = Array.from({ length: 22 }, (_, index) => alphabet[(bytes[index] || Math.floor(Math.random() * alphabet.length)) % alphabet.length]).join("")
    setPassword(next)
    await navigator.clipboard?.writeText(next).catch(() => null)
    toast.success("Password generated and copied")
  }

  async function submit() {
    if (!canSubmit) {
      if (password.length < 12) toast.error("Password must be at least 12 characters")
      else if (strength.score < 3) toast.error("Use a stronger password")
      else if (!confirmationAccepted) toast.error("Type the hostname or REINSTALL to confirm")
      else toast.error("Complete all reinstall fields")
      return
    }
    setSubmitting(true)
    try {
      if (!operationId) setOperationId(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `reinstall-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
      const res = await fetch(`/api/client/vps/${id}/reinstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          adminUsername: adminUsername.trim(),
          loginMethod: "password",
          password,
          confirmation,
          preserveIp: true,
          operationId,
        }),
      })
      const data = await readJsonResponse<any>(res) || {}
      if (!res.ok) throw new Error(data.error || "Unable to queue reinstall")
      if (data?.reinstall?.nextResetAt) {
        setAllowance((current) => current ? { ...current, remaining: Number(data.reinstall.remaining ?? current.remaining), nextResetAt: String(data.reinstall.nextResetAt) } : current)
      }
      setOperationId("")
      setJob({ id: data.jobId, status: "queued", progress: 0, displayStatus: "Preparing reinstall" })
      toast.success("Reinstall requested. Live progress is now available below.")
    } catch (error: any) {
      toast.error(error.message || "Unable to request reinstall")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Container className="py-6">
      <div className="mb-5">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/client-area/vps/${id}`}><ArrowLeft className="mr-2 h-4 w-4" />Back to VPS</Link>
        </Button>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Server className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Reinstall Operating System</h1>
          <Badge variant="outline">{status?.displayStatus || status?.status || "Loading"}</Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Server</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <Detail label="VPS name" value={status?.hostname || "-"} />
              <Detail label="Current OS" value={status?.os || "-"} />
              <Detail label="IP address" value={status?.ipAddress || "-"} />
            </CardContent>
          </Card>

          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <div className="font-medium">Reinstall will erase existing data.</div>
                <p className="mt-1 text-destructive/90">All files, databases, and local changes inside this VPS will be permanently removed.</p>
              </div>
            </div>
          </div>

          <Card>
            <CardHeader><CardTitle>Monthly reinstall allowance</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <Detail label="Remaining" value={allowance ? `${allowance.remaining} / ${allowance.monthlyLimit} this month` : "-"} />
              <Detail label="Next reset" value={allowance?.nextResetAt ? new Date(allowance.nextResetAt).toLocaleDateString() : "-"} />
              <Detail label="Status" value={allowance ? (allowance.allowed ? "Available" : allowance.reason || "Unavailable") : "-"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Choose Operating System</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {sortedTemplates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setTemplateId(item.id)
                      setAdminUsername(item.defaultUsername || (familyForTemplate(item) === "Windows Server" ? "Administrator" : "root"))
                    }}
                    className={`group relative overflow-hidden rounded-lg border p-4 text-left transition duration-200 hover:border-primary/50 hover:bg-primary/[0.03] hover:shadow-[0_0_28px_rgba(59,130,246,0.14)] ${templateId === item.id ? "selected-item shadow-[0_0_34px_rgba(59,130,246,0.18)]" : "border-border/50"}`}
                  >
                    <div className="flex min-h-28 flex-col items-center justify-center gap-3 text-center">
                      <Image src={getResolvedOsIcon(item)} alt="" width={46} height={46} className="h-12 w-12 object-contain transition group-hover:scale-105" onError={handleOsIconError} unoptimized />
                      <div>
                        <div className="text-sm font-semibold">{osTitle(item)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{osArchitecture(item)}</div>
                      </div>
                    </div>
                    {recommendedIds.has(item.id) ? <Badge className="absolute right-3 top-3 border-emerald-400/30 bg-emerald-400/10 text-emerald-200" variant="outline">Recommended</Badge> : null}
                    {templateId === item.id ? <Check className="absolute bottom-3 right-3 h-4 w-4 text-primary" /> : null}
                  </button>
                ))}
                {!sortedTemplates.length ? <div className="rounded-md border border-border/40 p-4 text-sm text-muted-foreground">No reinstall templates are available for this node.</div> : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Access Details</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Admin username" value={adminUsername} onChange={setAdminUsername} placeholder="root" />
              <div className="space-y-2 sm:col-span-2">
                <Label>Password</Label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input type={showPassword ? "text" : "password"} value={password} placeholder="Minimum 12 characters" onChange={(event) => setPassword(event.target.value)} className="pr-10" />
                    <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 h-8 w-8" onClick={() => setShowPassword((value) => !value)}>
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <Button type="button" variant="outline" className="gap-2" onClick={generatePassword}>
                    <KeyRound className="h-4 w-4" />
                    Generate
                  </Button>
                </div>
                <PasswordStrength strength={strength} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Type hostname or REINSTALL to confirm</Label>
                <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={expectedHostname || "REINSTALL"} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Progress</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {submitting ? (
                <div className="rounded-md border border-sky-400/30 bg-sky-400/10 p-3 text-sky-100">
                  <RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />
                  Queueing reinstall task
                </div>
              ) : null}
              {job ? (
                <div className="space-y-3 rounded-md border border-border/40 p-4">
                  <div className="flex items-center justify-between gap-3"><span className="font-medium">{job.displayStatus || "Reinstall in progress"}</span><span>{Number(job.progress || 0)}%</span></div>
                  <Progress value={Number(job.progress || 0)} />
                  <div className="text-xs text-muted-foreground">{job.etaSeconds ? `Estimated ${Math.ceil(job.etaSeconds / 60)} minute${Math.ceil(job.etaSeconds / 60) === 1 ? "" : "s"} remaining` : job.status === "completed" ? "Ready to use" : "Estimating completion time"}</div>
                  <div className="space-y-2">
                    {steps.filter((step) => step.step.startsWith("REINSTALL_")).map((step) => (
                      <div key={step.id} className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2">
                        {step.status === "completed" ? <Check className="mt-0.5 h-4 w-4 text-emerald-400" /> : step.status === "failed" ? <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" /> : <RefreshCw className="mt-0.5 h-4 w-4 animate-spin text-sky-400" />}
                        <div><div className="font-medium">{step.label}</div>{step.message ? <div className="text-xs text-muted-foreground">{step.message}</div> : null}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {logs.length ? logs.map((log) => (
                <div key={log.id} className="rounded-md border border-border/40 p-3">
                  <div className="text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString()} · {log.title || log.level}</div>
                  <div className="mt-1">{log.message}</div>
                </div>
              )) : (
                <div className="rounded-md border border-border/40 p-3 text-muted-foreground">Recent activity will appear here after reinstall starts.</div>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Summary label="VPS name" value={status?.hostname || "-"} />
              <Summary label="Current OS" value={status?.os || "-"} />
              <Summary label="New OS" value={selectedTemplate ? osTitle(selectedTemplate) : "-"} />
              <Summary label="Architecture" value={selectedTemplate ? osArchitecture(selectedTemplate) : "-"} />
              <Summary label="Status" value={status?.displayStatus || status?.status || "-"} />
              <Button className="mt-3 w-full" onClick={submit} disabled={!canSubmit}>
                {submitting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                Reinstall
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </Container>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function PasswordStrength({ strength }: { strength: { score: number; label: string } }) {
  const width = Math.min(100, Math.max(8, (strength.score / 5) * 100))
  const color = strength.score >= 4 ? "bg-emerald-400" : strength.score >= 3 ? "bg-sky-400" : "bg-amber-400"
  return (
    <div className="space-y-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${width}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {strength.label} · use 16+ characters with upper/lowercase letters, numbers, and symbols.
      </p>
    </div>
  )
}
