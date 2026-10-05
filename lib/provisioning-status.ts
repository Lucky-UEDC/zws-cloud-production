import { clientActivityMessage } from "@/lib/log-format"

export type ProvisioningStep =
  | "QUEUED"
  | "SELECTING_NODE"
  | "WAITING_FOR_CAPACITY"
  | "WAITING_FOR_ADMIN"
  | "CLONING_TEMPLATE"
  | "CLONE_COMPLETE"
  | "APPLYING_CLOUD_INIT"
  | "CONFIGURING_VM"
  | "RESIZING_DISK"
  | "ASSIGNING_IP"
  | "STARTING_VM"
  // The guest-automation pipeline. The server configures itself here, through
  // the QEMU guest agent and the OS profile that matches the OS it reports.
  | "WAITING_GUEST_AGENT"
  | "DETECTING_OS"
  | "LOADING_OS_TEMPLATE"
  | "CONFIGURING_NETWORK"
  | "CONFIGURING_ACCESS"
  | "CONFIGURING_GUEST"
  | "VERIFYING_NETWORK"
  | "COLLECTING_METRICS"
  | "VERIFYING_GUEST"
  | "SERVICE_ACTIVE"
  | "SERVICE_FAILED"
  | "VERIFYING_VM"
  | "ACTIVE"
  | "STOPPED"
  | "START_FAILED"
  | "REPAIR_NEEDED"
  | "FAILED"
  | "UPGRADE"
  | "UPGRADE_QUEUED"
  | "UPDATING_CONFIG"
  | "UPGRADE_COMPLETE"
  | "UPGRADE_FAILED"

export const STEP_LABELS: Record<ProvisioningStep, string> = {
  QUEUED: "Preparing your cloud server",
  SELECTING_NODE: "Selecting deployment location",
  WAITING_FOR_CAPACITY: "Waiting for capacity",
  WAITING_FOR_ADMIN: "Waiting for manual review",
  CLONING_TEMPLATE: "Installing operating system",
  CLONE_COMPLETE: "Cloud server prepared",
  APPLYING_CLOUD_INIT: "Configuring server settings",
  CONFIGURING_VM: "Applying security protection",
  RESIZING_DISK: "Configuring storage",
  ASSIGNING_IP: "Allocating IP & network",
  STARTING_VM: "Starting server services",
  WAITING_GUEST_AGENT: "Waiting for your server to respond",
  DETECTING_OS: "Checking your server's operating system",
  LOADING_OS_TEMPLATE: "Loading OS profile",
  CONFIGURING_NETWORK: "Configuring network",
  CONFIGURING_ACCESS: "Configuring access",
  CONFIGURING_GUEST: "Configuring your server",
  VERIFYING_NETWORK: "Verifying network",
  COLLECTING_METRICS: "Collecting resource usage",
  VERIFYING_GUEST: "Confirming your server is configured",
  SERVICE_ACTIVE: "Your cloud server is ready",
  SERVICE_FAILED: "Your server needs attention",
  VERIFYING_VM: "Final server optimization",
  ACTIVE: "Your cloud server is ready",
  STOPPED: "Stopped",
  START_FAILED: "Provisioning needs attention",
  REPAIR_NEEDED: "Provisioning needs attention",
  FAILED: "Provisioning needs attention",
  UPGRADE: "Upgrading server",
  UPGRADE_QUEUED: "Preparing upgrade",
  UPDATING_CONFIG: "Allocating compute resources",
  UPGRADE_COMPLETE: "Server ready",
  UPGRADE_FAILED: "Provisioning needs attention",
}

const LEGACY_PROVISIONING_TEXT: Record<string, string> = {
  "Template cloning": "Installing Ubuntu 22.04",
  "Cloud-init configuring": "Configuring server settings",
  "Cloud init configuring": "Configuring server settings",
  "Cloud-init": "Configuring server settings",
  "Network attaching": "Allocating IP & network",
  "Boot validation": "Starting server services",
  "Security hardening": "Applying security protection",
  "Finalizing deployment": "Final server optimization",
  "Service ready": "Your cloud server is ready",
  "Applying hostname, password, IP, gateway and DNS": "Configuring server settings",
  "Starting VM": "Starting server services",
  "Starting server": "Starting server services",
  "Verifying VM status": "Final server optimization",
  "VPS is running": "Your cloud server is ready",
}

const NOISY_CUSTOMER_LOG_PATTERN = /server state is updating|refreshing automatically|refresh automatically|state updating|polling attempt|heartbeat/i

export function professionalizeProvisioningText(input: unknown) {
  let value = String(input || "").replace(/\s+/g, " ").trim()
  if (!value) return value
  for (const [legacy, replacement] of Object.entries(LEGACY_PROVISIONING_TEXT)) {
    value = value.replace(new RegExp(legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replacement)
  }
  return value
    .replace(/Starting server services services/gi, "Starting server services")
    .replace(/Configuring server settings settings/gi, "Configuring server settings")
    .replace(/Your cloud server is ready ready/gi, "Your cloud server is ready")
}

export function isNoisyCustomerProvisioningLog(input: unknown) {
  return NOISY_CUSTOMER_LOG_PATTERN.test(String(input || ""))
}

export type CustomerProvisioningStep = {
  title: string
  message: string
}

const CUSTOMER_STEP_MESSAGES: Record<ProvisioningStep, CustomerProvisioningStep> = {
  QUEUED: {
    title: "Preparing your cloud server",
    message: "Your cloud instance is being prepared automatically. This usually completes shortly after payment confirmation.",
  },
  SELECTING_NODE: {
    title: "Selecting deployment location",
    message: "We are selecting an eligible deployment location for your selected operating system.",
  },
  WAITING_FOR_CAPACITY: {
    title: "Waiting for manual review",
    message: "Provisioning is pending because capacity is not currently available.",
  },
  WAITING_FOR_ADMIN: {
    title: "Waiting for manual review",
    message: "Your order is paid and waiting for provisioning review.",
  },
  CLONING_TEMPLATE: {
    title: "Installing operating system",
    message: "Your operating system is being installed.",
  },
  CLONE_COMPLETE: {
    title: "Cloud server prepared",
    message: "Your cloud server has been prepared.",
  },
  APPLYING_CLOUD_INIT: {
    title: "Configuring server settings",
    message: "Your server settings are being configured.",
  },
  CONFIGURING_VM: {
    title: "Applying security protection",
    message: "Security protection is being applied.",
  },
  RESIZING_DISK: {
    title: "Configuring storage",
    message: "Storage configuration is in progress.",
  },
  ASSIGNING_IP: {
    title: "Allocating IP & network",
    message: "Your IP address and network are being allocated.",
  },
  STARTING_VM: {
    title: "Starting server services",
    message: "Your server services are starting.",
  },
  WAITING_GUEST_AGENT: {
    title: "Waiting for your server to respond",
    // The single most common honest wait in the whole pipeline: the guest agent
    // boots after the operating system, and until it answers nothing can be
    // configured. Saying so beats a spinner with no explanation.
    message: "Your server is starting up. We wait for it to report in before configuring it — this usually takes under a minute.",
  },
  DETECTING_OS: {
    title: "Checking your server's operating system",
    message: "We are confirming which operating system your server is running, so we configure it the right way.",
  },
  CONFIGURING_GUEST: {
    title: "Configuring your server",
    message: "Your network, access and system settings are being applied from inside your server.",
  },
  VERIFYING_GUEST: {
    title: "Confirming your server is configured",
    message: "We are reading your server back to confirm the settings took effect.",
  },
  LOADING_OS_TEMPLATE: {
    title: "Loading OS profile",
    message: "We are loading the operating system profile for your server.",
  },
  CONFIGURING_NETWORK: {
    title: "Configuring network",
    message: "Your network settings are being applied from inside the server.",
  },
  CONFIGURING_ACCESS: {
    title: "Configuring access",
    message: "Your credentials are being configured inside the server.",
  },
  VERIFYING_NETWORK: {
    title: "Verifying network",
    message: "We are confirming your network settings took effect.",
  },
  COLLECTING_METRICS: {
    title: "Collecting resource usage",
    message: "We are collecting initial resource usage from your server.",
  },
  SERVICE_ACTIVE: {
    title: "Your cloud server is ready",
    message: "Your cloud server is running and configured. You can sign in now.",
  },
  SERVICE_FAILED: {
    title: "Your server needs attention",
    message: "We could not finish configuring your server. Our team has been notified and will take it from here.",
  },
  VERIFYING_VM: {
    title: "Final server optimization",
    message: "Final checks are running.",
  },
  ACTIVE: {
    title: "Your cloud server is ready",
    message: "Deployment completed successfully.",
  },
  STOPPED: {
    title: "Server stopped",
    message: "Your VPS is currently stopped.",
  },
  START_FAILED: {
    title: "Provisioning needs attention",
    message: "Provisioning needs attention. Our team has been notified.",
  },
  REPAIR_NEEDED: {
    title: "Provisioning needs attention",
    message: "Provisioning needs attention. Our team has been notified.",
  },
  FAILED: {
    title: "Provisioning needs attention",
    message: "Provisioning needs attention. Our team has been notified.",
  },
  UPGRADE: {
    title: "Applying resources",
    message: "CPU, memory, and storage are being configured.",
  },
  UPGRADE_QUEUED: {
    title: "Preparing server",
    message: "We are preparing your VPS upgrade.",
  },
  UPDATING_CONFIG: {
    title: "Applying resources",
    message: "CPU, memory, and storage are being configured.",
  },
  UPGRADE_COMPLETE: {
    title: "Ready",
    message: "Your VPS is online and ready to use.",
  },
  UPGRADE_FAILED: {
    title: "Upgrade issue",
    message: "We could not complete the upgrade. Please contact support for help.",
  },
}

export type ProxmoxTaskState = {
  status?: string | null
  exitstatus?: string | null
  [key: string]: unknown
}

export function normalizeStep(step: string | null | undefined): ProvisioningStep {
  const value = String(step || "").toUpperCase()
  if (value in STEP_LABELS) return value as ProvisioningStep
  const oldMap: Record<string, ProvisioningStep> = {
    clone: "CLONING_TEMPLATE",
    selecting_node: "SELECTING_NODE",
    waiting_for_capacity: "WAITING_FOR_CAPACITY",
    waiting_for_admin: "WAITING_FOR_ADMIN",
    clone_complete: "CLONE_COMPLETE",
    cloud_init: "APPLYING_CLOUD_INIT",
    configure: "APPLYING_CLOUD_INIT",
    resize: "RESIZING_DISK",
    assign_ip: "ASSIGNING_IP",
    start: "STARTING_VM",
    validate: "VERIFYING_VM",
    upgrade: "UPGRADE",
    upgrade_queued: "UPGRADE_QUEUED",
    updating_config: "UPDATING_CONFIG",
    upgrade_complete: "UPGRADE_COMPLETE",
    upgrade_failed: "UPGRADE_FAILED",
    stopped: "STOPPED",
    start_failed: "START_FAILED",
    repair_needed: "REPAIR_NEEDED",
  }
  return oldMap[String(step || "").toLowerCase()] || "QUEUED"
}

export function displayStatusForStep(step: ProvisioningStep, task?: ProxmoxTaskState | null): string {
  if (!task || task.status === "running") return STEP_LABELS[step]
  if (task.status === "stopped" && task.exitstatus === "OK") return step === "VERIFYING_VM" ? STEP_LABELS.ACTIVE : STEP_LABELS[step]
  if (task.status === "stopped") return STEP_LABELS.FAILED
  return STEP_LABELS[step]
}

export function isTaskComplete(task: ProxmoxTaskState | null | undefined): boolean {
  return task?.status === "stopped" && task.exitstatus === "OK"
}

export function isTaskFailed(task: ProxmoxTaskState | null | undefined): boolean {
  return task?.status === "stopped" && String(task.exitstatus || "").toLowerCase() !== "ok"
}

export function sanitizeProvisioningError(error: unknown): string {
  const rawCode = String((error as any)?.code || "")
  const proxmoxMessage = String((error as any)?.proxmoxMessage || "")
  const baseMessage = error instanceof Error ? error.message : String(error || "Provisioning failed")
  const message = proxmoxMessage && baseMessage === "Proxmox API error" ? proxmoxMessage : baseMessage
  const friendlyByCode: Record<string, string> = {
    AUTH_FAILED_401: "Infrastructure authentication failed. Verify access credentials and permissions.",
    PERMISSION_DENIED_403: "Infrastructure permission denied. Verify access permissions for the selected zone.",
    TEMPLATE_MISSING: "Selected operating system image is unavailable in the selected zone.",
    VM_NOT_FOUND: "Cloud server was not found in the selected zone.",
    VMID_CONFLICT: "Instance ID conflict detected. A safe unused instance ID is required before retrying.",
    STORAGE_UNAVAILABLE: "Storage is unavailable, inactive, missing, or not writable.",
    INSUFFICIENT_RESOURCES: "Selected infrastructure zone has insufficient resources for this cloud server.",
    NETWORK_BRIDGE_MISSING: "Network configuration is unavailable in the selected zone.",
    NETWORK_CONFIG_INVALID: proxmoxMessage || "Network configuration was rejected by the node.",
    CLONE_FAILED: proxmoxMessage || "Image preparation failed.",
    TLS_CERT_ERROR: "Infrastructure TLS/certificate issue.",
    TLS_HANDSHAKE_ERROR: "Infrastructure TLS handshake failed.",
    HTTP_TIMEOUT: "Infrastructure request timed out.",
    DNS_FAILED: "Infrastructure DNS lookup failed.",
    TCP_REFUSED: "Infrastructure connection was refused.",
    TCP_TIMEOUT: "Infrastructure connection timed out.",
  }
  const selected = friendlyByCode[rawCode] || message
  return selected
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
    .replace(/(tokenSecret|secret)["':=\s]+[^"',\s}]+/gi, "$1=[redacted]")
    .slice(0, 1000)
}

export function customerStepContent(step: string | null | undefined): CustomerProvisioningStep {
  return CUSTOMER_STEP_MESSAGES[normalizeStep(step)]
}

const REINSTALL_STEP_MESSAGES: Partial<Record<ProvisioningStep, CustomerProvisioningStep>> = {
  QUEUED: { title: "Preparing reinstall", message: "Preparing reinstall" },
  STOPPED: { title: "Stopping server", message: "Stopping server" },
  CLONING_TEMPLATE: { title: "Installing operating system", message: "Installing operating system" },
  APPLYING_CLOUD_INIT: { title: "Applying access settings", message: "Applying access settings" },
  RESIZING_DISK: { title: "Applying access settings", message: "Applying access settings" },
  ASSIGNING_IP: { title: "Configuring network", message: "Configuring network" },
  STARTING_VM: { title: "Starting server", message: "Starting server" },
  VERIFYING_VM: { title: "Verifying server", message: "Verifying server" },
  ACTIVE: { title: "Reinstall complete", message: "Reinstall complete" },
  FAILED: { title: "Reinstall needs attention", message: "Reinstall needs attention. Our team has been notified." },
}

export function customerStepContentForJob(step: string | null | undefined, jobType?: string | null): CustomerProvisioningStep {
  const normalized = normalizeStep(step)
  if (jobType === "reinstall") return REINSTALL_STEP_MESSAGES[normalized] || CUSTOMER_STEP_MESSAGES[normalized]
  return CUSTOMER_STEP_MESSAGES[normalized]
}

export function sanitizeCustomerProvisioningMessage(message: unknown): string {
  const value = professionalizeProvisioningText(message)
  if (!value.trim()) return "We are updating your VPS status."

  const linuxCloudInitMatch = value.match(/LINUX_CLOUD_INIT_VERIFY_FAILED:([^:]+):\s*(.+)$/i)
  if (linuxCloudInitMatch) {
    const code = String(linuxCloudInitMatch[1] || "").toLowerCase()
    const detail = String(linuxCloudInitMatch[2] || "").trim()
    if (code || detail) return "Provisioning is waiting for manual review. Our team has been notified."
  }

  // Raw internal step tokens (e.g. "CLONING_TEMPLATE task running") map to the
  // customer-facing label so nothing technical ever reaches the client.
  const rawStepToken = value.toUpperCase().match(/\b(CLONING_TEMPLATE|CLONE_COMPLETE|APPLYING_CLOUD_INIT|CONFIGURING_VM|RESIZING_DISK|ASSIGNING_IP|STARTING_VM|VERIFYING_VM|SELECTING_NODE|WAITING_FOR_CAPACITY|WAITING_FOR_ADMIN|UPGRADE_QUEUED|UPDATING_CONFIG|UPGRADE_COMPLETE|START_FAILED|REPAIR_NEEDED|UPGRADE_FAILED)\b/)
  if (rawStepToken) return STEP_LABELS[rawStepToken[1] as ProvisioningStep] || "Updating your cloud server status"

  const blocked = /(upid|proxmox|qmclone|qmstart|qemu|lxc|vmid|root@pam|api2\/json|pveapitoken|vncproxy|vncwebsocket|\/nodes\/|node|cluster|queue|job|automation|storage pool|template clone|token|realm|cloud-init|cloudinit|clone|cloning|template_?os|task (running|queued|started|stopped)|worker|scheduler|janitor|resize command|stack|password|secret|cookie|\.env)/i
  if (blocked.test(value)) return "Final server optimization"

  return clientActivityMessage(value)
}

export function extractUpid(result: any): string | null {
  if (!result) return null
  if (typeof result === "string") return result
  if (typeof result.upid === "string") return result.upid
  if (typeof result.data === "string") return result.data
  if (typeof result.data?.upid === "string") return result.data.upid
  return null
}
