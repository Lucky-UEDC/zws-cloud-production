"use client"

/**
 * The compute-node addition wizard.
 *
 * Ten steps, and the ordering is the point. Identity and credentials first,
 * then a real connection test, then the guest-agent requirement, then the
 * capability report, and only then the node is created and declared Ready.
 *
 * The step that did not exist before is step 7. A node whose API answers used to
 * be saved as "connected" and immediately became schedulable, so the first thing
 * that went wrong was discovered during a customer's provisioning job. Here the
 * admin is told, before the node exists, that guest automation runs through the
 * QEMU Guest Agent and shown the exact commands for each OS.
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { Activity, CheckCircle2, CircleAlert, Loader2, Server, ShieldAlert, XCircle } from "lucide-react"
import { readJsonResponse } from "@/lib/client/safe-json"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type WizardForm = {
  name: string
  host: string
  nodeName: string
  tokenId: string
  tokenSecret: string
  location: string
  allowInsecureTls: boolean
}

export type WizardDiagnosticStep = {
  name: string
  ok: boolean
  code: string
  message: string
  durationMs?: number | null
  endpoint?: string | null
}

type ConnectionState = {
  status: "idle" | "testing" | "success" | "failed"
  message: string
  code?: string
  nodes: string[]
  host: string
  steps: WizardDiagnosticStep[]
  /** Endpoints this token is valid but not permitted to read. */
  permissionDeniedEndpoints?: string[]
  /** Endpoints that failed for a reason other than permissions. */
  failedEndpoints?: string[]
  /** Connected and authenticated, but some checks were refused. */
  degraded?: boolean
}

export type CapabilityCheck = {
  key: string
  label: string
  state: "pass" | "warn" | "fail" | "skip" | "unknown"
  detail: string
  durationMs: number | null
  measured: boolean
}

export type CapabilityReport = {
  status: "ready" | "degraded" | "failed" | "pending"
  checks: CapabilityCheck[]
  summary: { pass: number; warn: number; fail: number; skip: number; total: number }
  blockers: string[]
  lastCheckedAt: string | null
  headline?: string
}

const STEPS = [
  { key: "identity", title: "Identity", description: "What this node is called and where it is." },
  { key: "host", title: "Host", description: "How to reach the Proxmox API." },
  { key: "node", title: "Proxmox node", description: "Which node inside that host to manage." },
  { key: "credentials", title: "API token", description: "The token the panel authenticates with." },
  { key: "connection", title: "Test connection", description: "Prove the API answers before anything is saved." },
  { key: "confirm-node", title: "Confirm the node", description: "Check the detected node is the one you mean." },
  { key: "guest-agent", title: "Guest agent in your images", description: "Servers are configured through the QEMU Guest Agent. Every image must carry one." },
  { key: "capabilities", title: "Measure capabilities", description: "What this node can actually do, measured rather than assumed." },
  { key: "review", title: "Review", description: "What was verified, and what is still unverified." },
  { key: "finish", title: "Add node", description: "Save the node and sync its templates." },
] as const

/**
 * Per-OS guest agent install commands.
 *
 * Kept in step 7 rather than in a help page because this is the moment an admin
 * needs it: adding a node whose images have no agent is what makes a node
 * unusable, and the fix belongs inside the images.
 */
const AGENT_COMMANDS: Array<{ os: string; commands: string[] }> = [
  { os: "Debian / Ubuntu / Kali", commands: ["apt-get update", "apt-get install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"] },
  { os: "RHEL / Alma / Rocky / Oracle / Fedora", commands: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"] },
  { os: "CentOS 7", commands: ["yum install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"] },
  { os: "openSUSE / SLES", commands: ["zypper -n in qemu-guest-agent", "systemctl enable --now qemu-guest-agent"] },
  { os: "Arch", commands: ["pacman -S --noconfirm qemu-guest-agent", "systemctl enable --now qemu-guest-agent"] },
  { os: "Alpine", commands: ["apk add qemu-guest-agent", "rc-update add qemu-guest-agent", "rc-service qemu-guest-agent start"] },
  { os: "Windows", commands: ["Mount the VirtIO tools ISO and run virtio-win-guest-tools.exe", "Enable the QEMU Guest Agent service and set it to start automatically"] },
]

export function NodeWizardSteps({ current }: { current: number }) {
  return (
    <ol className="grid gap-1 text-xs" aria-label="Node addition progress">
      {STEPS.map((step, index) => {
        const state = index < current ? "done" : index === current ? "active" : "todo"
        return (
          <li key={step.key} className="flex items-center gap-2">
            <span
              className={[
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                state === "done" ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                  : state === "active" ? "border-sky-500/70 bg-sky-500/15 text-sky-200"
                    : "border-border/60 text-muted-foreground",
              ].join(" ")}
            >
              {index + 1}
            </span>
            <span className={state === "active" ? "font-medium text-foreground" : "text-muted-foreground"}>{step.title}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function NodeWizardStepBody(props: {
  step: number
  form: WizardForm
  updateForm: (key: keyof WizardForm, value: string | boolean) => void
  connection: ConnectionState
  capabilities: CapabilityReport | null
  onTestConnection: () => void
  onMeasure: () => void
  measuring: boolean
}) {
  const { step, form, updateForm, connection, capabilities, onTestConnection, onMeasure, measuring } = props
  switch (step) {
    case 0:
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="wizard-name">Display name</Label>
            <Input id="wizard-name" value={form.name} onChange={(e) => updateForm("name", e.target.value)} placeholder="Mumbai DC1" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-location">Location</Label>
            <Input id="wizard-location" value={form.location} onChange={(e) => updateForm("location", e.target.value)} placeholder="Mumbai, India" />
          </div>
        </div>
      )
    case 1:
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wizard-host">Host URL</Label>
            <Input id="wizard-host" value={form.host} onChange={(e) => updateForm("host", e.target.value)} placeholder="node.example.com" />
            <p className="text-xs text-muted-foreground">Hostname or IP. Do not include the scheme — it is added for you.</p>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Checkbox checked={form.allowInsecureTls} onCheckedChange={(checked) => updateForm("allowInsecureTls", checked === true)} />
            Allow insecure TLS
          </label>
        </div>
      )
    case 2:
      return (
        <div className="space-y-2">
          <Label htmlFor="wizard-node">Proxmox node name</Label>
          {connection.nodes.length > 0 ? (
            <Select value={form.nodeName} onValueChange={(value) => updateForm("nodeName", value)}>
              <SelectTrigger id="wizard-node"><SelectValue placeholder="Select the detected node" /></SelectTrigger>
              <SelectContent>{connection.nodes.map((node) => <SelectItem key={node} value={node}>{node}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input id="wizard-node" value={form.nodeName} onChange={(e) => updateForm("nodeName", e.target.value)} placeholder="pve" />
          )}
          <p className="text-xs text-muted-foreground">The name as Proxmox reports it. This is what appears in VM paths, not the host URL.</p>
        </div>
      )
    case 3:
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="wizard-token-id">Token ID</Label>
            <Input id="wizard-token-id" value={form.tokenId} onChange={(e) => updateForm("tokenId", e.target.value)} placeholder="root@pam!zws" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-token-secret">Token secret</Label>
            <Input id="wizard-token-secret" type="password" value={form.tokenSecret} onChange={(e) => updateForm("tokenSecret", e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">
            The token needs read access to the node and VM config, and write access to guest commands. It is stored encrypted and never returned by any endpoint.
          </p>
        </div>
      )
    case 4:
      return (
        <div className="space-y-3">
          <Button type="button" variant="outline" onClick={onTestConnection} disabled={connection.status === "testing"} className="gap-2">
            {connection.status === "testing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            {connection.status === "testing" ? "Testing..." : "Test connection"}
          </Button>
          {connection.steps.length > 0 ? <DiagnosticSteps steps={connection.steps} /> : null}
          {/*
            A permission denial is reported as its own state, not as a failed
            connection. The token worked; it is scoped more narrowly than the
            panel's full feature set, and that is a legitimate configuration the
            administrator should be able to save and then widen.
          */}
          {connection.status === "success" && connection.degraded ? (
            <PermissionNotice denied={connection.permissionDeniedEndpoints || []} failed={connection.failedEndpoints || []} />
          ) : null}
        </div>
      )
    case 5:
      return (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Nodes detected on <span className="font-mono text-foreground">{connection.host || form.host}</span>:
          </p>
          <ul className="space-y-1">
            {connection.nodes.map((node) => (
              <li key={node} className={node === form.nodeName ? "font-medium text-foreground" : "text-muted-foreground"}>
                {node}{node === form.nodeName ? " — selected" : ""}
              </li>
            ))}
          </ul>
        </div>
      )
    case 6:
      return (
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This platform configures a server from inside the server, through the QEMU Guest Agent. Nothing is injected from the host
            any more, so an image without a working agent cannot be delivered to a customer — it can be created but never configured.
          </p>
          <p className="text-muted-foreground">
            Install the agent in each template image, then use <span className="font-mono text-foreground">Verify guest agent</span> on the
            template to open the host-side channel.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {AGENT_COMMANDS.map((entry) => (
              <div key={entry.os} className="rounded-md border border-border/40 p-3">
                <div className="text-xs font-medium">{entry.os}</div>
                <pre className="mt-2 overflow-x-auto text-[11px] leading-5 text-muted-foreground">{entry.commands.join("\n")}</pre>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            The exact command set per seeded OS template is managed under{" "}
            <Link href="/admin/os-templates" className="underline underline-offset-2">Templates → OS Guest Automation</Link>.
          </p>
        </div>
      )
    case 7:
      return (
        <div className="space-y-3">
          <Button type="button" variant="outline" onClick={onMeasure} disabled={measuring} className="gap-2">
            {measuring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            {measuring ? "Measuring..." : capabilities ? "Re-measure" : "Measure capabilities"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Guest capabilities are measured against a running guest. A node with no running guest reports them as unmeasured rather than
            as working, and stays out of scheduling until they are proven.
          </p>
          {capabilities ? <CapabilityTable report={capabilities} /> : null}
        </div>
      )
    case 8:
      return capabilities ? <CapabilityTable report={capabilities} showHeadline /> : (
        <p className="text-sm text-muted-foreground">Measure the capabilities first.</p>
      )
    case 9:
      return capabilities ? (
        <div className="space-y-3">
          <CapabilityTable report={capabilities} showHeadline />
          {capabilities.status === "ready" ? (
            <p className="text-sm text-muted-foreground">The node will be added and made schedulable immediately.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              The node will be added but left out of scheduling, with the reason recorded against it. Fix the guest images, then re-run
              diagnostics to bring it in.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Measure the capabilities first.</p>
      )
    default:
      return null
  }
}

/**
 * What the token may not read, and what that costs.
 *
 * Each endpoint is mapped to the Proxmox privilege it needs, so the instruction is
 * a grant rather than a shrug. Nothing here changes a Proxmox ACL: it prints the
 * line for an administrator to run on the Proxmox host.
 */
export function PermissionNotice({ denied, failed }: { denied: string[]; failed: string[] }) {
  if (!denied.length && !failed.length) return null
  return (
    <div className="space-y-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-sky-200">
        <ShieldAlert className="h-3.5 w-3.5" />
        Connected — some checks were refused
      </div>
      <p className="text-sky-200/90">
        The API token is valid and the node is reachable. These endpoints refused the request for want of permission. The node can
        still be added; the features below stay unavailable until the grants are applied on the Proxmox host.
      </p>
      {denied.length ? (
        <div>
          <div className="font-medium text-sky-200">Refused for permission</div>
          <ul className="mt-0.5 list-inside list-disc space-y-0.5 font-mono text-[11px] text-sky-200/80">
            {denied.map((endpoint) => (
              <li key={endpoint}>
                {endpoint} — needs {privilegeForEndpoint(endpoint)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {failed.length ? (
        <div>
          <div className="font-medium text-amber-200">Failed for another reason</div>
          <ul className="mt-0.5 list-inside list-disc space-y-0.5 font-mono text-[11px] text-amber-200/80">
            {failed.map((endpoint) => (
              <li key={endpoint}>{endpoint}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-sky-200/80">
        The panel does not modify Proxmox ACLs. Apply the grant in the Proxmox shell as an administrator, then re-run this test.
      </p>
    </div>
  )
}

/** The privilege a denied endpoint needs, or a pointer to the capability map. */
function privilegeForEndpoint(endpoint: string): string {
  const path = endpoint.replace(/^\/api2\/json/, "")
  if (path === "/cluster/status" || path === "/cluster/config/nodes") return "Sys.Audit on /"
  if (/^\/nodes\/[^/]+\/status$/.test(path)) return "Sys.Audit on /nodes/{node}"
  if (/^\/nodes\/[^/]+\/disks\//.test(path)) return "Sys.Audit on /nodes/{node}"
  if (/\/netstat$/.test(path)) return "Sys.Audit on /nodes/{node}"
  if (/\/qemu\/\d+\/vncproxy|\/termproxy|\/sendkey/.test(path)) return "VM.Console on /vms/{vmid}"
  if (/\/snapshot/.test(path)) return "VM.Snapshot on /vms/{vmid}"
  if (/\/agent\/exec/.test(path)) return "VM.GuestAgent.Unrestricted on /vms/{vmid}"
  if (/\/agent\//.test(path)) return "VM.GuestAgent.Audit on /vms/{vmid}"
  if (/\/storage\//.test(path)) return "Datastore.Audit on /storage/{storage}"
  return "a Proxmox privilege this panel does not record for it"
}

export function DiagnosticSteps({ steps }: { steps: WizardDiagnosticStep[] }) {
  return (
    <ul className="space-y-1 rounded-md border border-border/40 p-3 text-xs">
      {steps.map((step, index) => (
        <li key={`${step.name}-${index}`} className="flex items-start gap-2">
          {step.ok
            ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />}
          <span className={step.ok ? "text-foreground" : "text-red-300"}>{step.name}</span>
          <span className="text-muted-foreground">{step.message}</span>
        </li>
      ))}
    </ul>
  )
}

const STATE_BADGE: Record<CapabilityCheck["state"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pass: { label: "Verified", variant: "default" },
  warn: { label: "Warning", variant: "outline" },
  fail: { label: "Failed", variant: "destructive" },
  skip: { label: "Not measured", variant: "secondary" },
  unknown: { label: "Unknown", variant: "secondary" },
}

export function CapabilityTable({ report, showHeadline }: { report: CapabilityReport; showHeadline?: boolean }) {
  return (
    <div className="space-y-2 rounded-md border border-border/40 p-3">
      {showHeadline ? (
        <div className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4" />
          <span className="font-medium">
            {report.headline || (
              report.status === "ready" ? "Ready"
                : report.status === "degraded" ? "Degraded"
                  : report.status === "failed" ? "Not ready"
                    : "Pending"
            )}
          </span>
        </div>
      ) : null}
      <Progress value={report.summary.total ? Math.round((report.summary.pass / report.summary.total) * 100) : 0} className="h-1" />
      <ul className="space-y-1.5 text-xs">
        {report.checks.map((entry) => (
          <li key={entry.key} className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="text-foreground">{entry.label}</span>
              {entry.detail ? <span className="block text-muted-foreground">{entry.detail}</span> : null}
            </span>
            <Badge variant={STATE_BADGE[entry.state]?.variant || "secondary"} className="shrink-0">
              {STATE_BADGE[entry.state]?.label || entry.state}
            </Badge>
          </li>
        ))}
      </ul>
      {report.blockers.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200">
          <div className="flex items-center gap-1.5 font-medium"><CircleAlert className="h-3.5 w-3.5" />Not schedulable</div>
          <ul className="mt-1 list-inside list-disc">{report.blockers.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
    </div>
  )
}

/** Which steps an admin may reach, given what has actually been proven. */
export function canAdvanceFromWizard(input: {
  step: number
  form: WizardForm
  connection: ConnectionState
  capabilities: CapabilityReport | null
}) {
  const { step, form, connection } = input
  switch (step) {
    case 0:
      return form.name.trim().length > 0
    case 1:
      return form.host.trim().length > 0
    case 2:
      return form.nodeName.trim().length > 0
    case 3:
      return form.tokenId.trim().length > 0 && form.tokenSecret.trim().length > 0
    case 4:
      // The connection must be proven before the wizard claims anything about
      // the node. An untested host is the case that used to fail silently.
      return connection.status === "success"
    case 5:
    case 6:
      return true
    case 7:
    case 8:
      return input.capabilities !== null
    default:
      return true
  }
}

export function useWizardStep(initial = 0) {
  const [step, setStep] = useState(initial)
  return useMemo(() => ({
    step,
    setStep,
    next: () => setStep((current) => Math.min(STEPS.length - 1, current + 1)),
    back: () => setStep((current) => Math.max(0, current - 1)),
  }), [step])
}

export { STEPS as NODE_WIZARD_STEPS }
