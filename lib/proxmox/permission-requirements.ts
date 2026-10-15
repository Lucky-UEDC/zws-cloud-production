/**
 * What each Proxmox endpoint the panel calls actually requires.
 *
 * ## Why this file is data and not opinion
 *
 * Every entry below was read out of the running Proxmox API schema at
 * `/pve-docs/api-viewer/apidoc.js`, not guessed. Each operation in that schema
 * carries its own `permissions.check` expression, which is what Proxmox's ACL
 * layer evaluates before it runs the handler. Copying those expressions here is
 * what lets the panel say "this endpoint needs `VM.Console` on `/vms/100`" and
 * mean it.
 *
 * The schema is fetched at runtime by `refreshPermissionSchema()` and diffed
 * against this table by `scripts/verify-proxmox-permissions.ts`, so a Proxmox
 * upgrade that changes an ACL shows up as a failing check rather than as a
 * mysterious 403 in production.
 *
 * ## The shape of a Proxmox ACL denial
 *
 * Proxmox returns a bare `403` with `{"data":null}` for a rejected call. It does
 * not say which privilege was missing or on which path. Anything that wants to
 * explain a 403 has to map it back to the endpoint that produced it, which is
 * what this module does: `explainDenial()` turns an endpoint plus a 403 into the
 * exact privilege, the exact ACL scope, and the exact `pveacl` line an
 * administrator has to run.
 *
 * ## Privilege separation
 *
 * Proxmox API tokens carry a `privilege-separation` flag. When it is on (the
 * default, and the only setting used here) a token can never hold more privilege
 * than the user it belongs to, so the check that matters is always the user's
 * role. This module never proposes turning it off.
 */

/** The privilege families the panel groups its checks into. */
export type ProxmoxFeatureKey =
  | "discovery"
  | "cluster_inventory"
  | "vm_inspection"
  | "console"
  | "vm_power"
  | "vm_config"
  | "snapshot"
  | "backup"
  | "guest_agent"
  | "storage"

export type ProxmoxAclRequirement = {
  /** Absolute API path with Proxmox's own `{param}` placeholders. */
  path: string
  method: string
  feature: ProxmoxFeatureKey
  /** Human label for the capability this endpoint serves. */
  capability: string
  /**
   * `null` means Proxmox applies no ACL check to this endpoint beyond "is this
   * request authenticated" — Proxmox's schema spells that `{"user":"all"}`. Such
   * an endpoint is not permission-free; it is permission-filtered, and the
   * filtering happens inside the handler (for example `/nodes/{node}/qemu`
   * returns only the VMs the caller holds `VM.Audit` on).
   */
  privilege: string | null
  /** Any-of, when Proxmox accepts one privilege from a set. */
  alternatives?: string[]
  /** The ACL path the privilege is evaluated against, with Proxmox placeholders. */
  aclPath?: string
  /**
   * Further scopes Proxmox accepts for the same privilege, when it combines
   * checks with `or` — `/nodes/{node}/disks/list` takes `Sys.Audit` on either
   * `/` or the node path, and the node path is the least-privilege one.
   */
  alternativeAclPaths?: string[]
  /**
   * A second privilege Proxmox requires through a composite `and` check.
   * `clone` is the case that matters: `VM.Clone` on the source is not enough
   * without `VM.Allocate` on the new VMID.
   */
  alsoRequires?: Array<{ privilege: string; aclPath: string; note?: string }>
  /** The endpoint filters its own results; the list can be partial. */
  filtered?: boolean
  /** What this endpoint grants, for the setup guide. */
  note?: string
}

/**
 * The least-privilege grants the panel needs, grouped by the feature each one
 * unlocks. Separated on purpose: an administrator can enable VM inspection
 * without also handing over the ability to change VM configuration, and console
 * access is a distinct grant from power control.
 *
 * Deliberately absent: `Sys.Modify`, `Sys.Audit` on `/` (full cluster audit),
 * `VM.Allocate` on arbitrary VMIDs, and anything resembling the root password.
 * Every grant below is a read or a narrowly-scoped write on a named path.
 */
export const PROXMOX_FEATURE_PRIVILEGES: Record<ProxmoxFeatureKey, { label: string; description: string; privileges: Array<{ privilege: string; aclPath: string }> }> = {
  discovery: {
    label: "Node and cluster inventory",
    description:
      "Read which nodes exist in the cluster. `/nodes` needs no explicit privilege, so this is free; the node *status* telemetry is not, and is listed under cluster_inventory.",
    privileges: [],
  },
  cluster_inventory: {
    label: "Node status telemetry (CPU, RAM, uptime)",
    description:
      "Reads `/cluster/status` and `/nodes/{node}/status`. Both require `Sys.Audit` — on `/` for the former, on the node path for the latter. Without it the node still works for VM work; only fleet-level telemetry is missing.",
    privileges: [
      { privilege: "Sys.Audit", aclPath: "/" },
      { privilege: "Sys.Audit", aclPath: "/nodes/{node}" },
    ],
  },
  vm_inspection: {
    label: "VM inspection",
    description: "Read VM config, runtime status and inventory. Scoped per VMID on `/vms/{vmid}`.",
    privileges: [{ privilege: "VM.Audit", aclPath: "/vms/{vmid}" }],
  },
  console: {
    label: "VM console access (VNC and serial)",
    description:
      "Mint the vncproxy/termproxy ticket that the browser console connects with. `VM.Console` is a separate grant from `VM.PowerMgmt` and does not imply it.",
    privileges: [{ privilege: "VM.Console", aclPath: "/vms/{vmid}" }],
  },
  vm_power: {
    label: "VM power controls",
    description: "Start, stop, reboot, shutdown, reset.",
    privileges: [{ privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" }],
  },
  vm_config: {
    label: "VM configuration",
    description:
      "Change VM configuration and clone from templates. The finest-grained privilege set in Proxmox — `VM.Config.Disk`, `.CPU`, `.Memory`, `.Network`, `.Options` and `.Cloudinit` are granted separately and `any` of them satisfies the endpoint.",
    privileges: [
      { privilege: "VM.Config.Options", aclPath: "/vms/{vmid}" },
      { privilege: "VM.Config.Disk", aclPath: "/vms/{vmid}" },
      { privilege: "VM.Config.Network", aclPath: "/vms/{vmid}" },
      { privilege: "VM.Config.Memory", aclPath: "/vms/{vmid}" },
      { privilege: "VM.Config.CPU", aclPath: "/vms/{vmid}" },
    ],
  },
  snapshot: {
    label: "Snapshot operations",
    description: "Create, roll back and delete snapshots. Listing snapshots only needs `VM.Audit`; changing them needs `VM.Snapshot`.",
    privileges: [{ privilege: "VM.Snapshot", aclPath: "/vms/{vmid}" }],
  },
  backup: {
    label: "Backup and restore",
    description:
      "`vzdump` additionally needs free space on the backup target: `Datastore.AllocateSpace` on `/storage/{storage}`. A token can hold `VM.Backup` and still fail to write a backup if the storage grant is absent.",
    privileges: [
      { privilege: "VM.Backup", aclPath: "/vms/{vmid}" },
      { privilege: "Datastore.AllocateSpace", aclPath: "/storage/{storage}" },
    ],
  },
  guest_agent: {
    label: "Guest agent operations",
    description:
      "Read-only guest verbs (`get-osinfo`, `get-fsinfo`, `network-get-interfaces`, `get-users`, `ping`) need `VM.GuestAgent.Audit`. Running commands inside the guest (`agent/exec`) is the stronger `VM.GuestAgent.Unrestricted` and is granted separately.",
    privileges: [
      { privilege: "VM.GuestAgent.Audit", aclPath: "/vms/{vmid}" },
      { privilege: "VM.GuestAgent.Unrestricted", aclPath: "/vms/{vmid}" },
    ],
  },
  storage: {
    label: "Storage inspection and allocation",
    description:
      "Inspect storage configuration and content. `Datastore.Audit` reads a storage's configuration; allocating space on it is a separate grant.",
    privileges: [
      { privilege: "Datastore.Audit", aclPath: "/storage/{storage}" },
      { privilege: "Datastore.AllocateSpace", aclPath: "/storage/{storage}" },
    ],
  },
}

/**
 * The endpoints the panel calls, with the ACL Proxmox evaluates for each.
 *
 * `privilege: null` records Proxmox's own `{"user":"all"}` — the endpoint is
 * open to any authenticated user and filters its own output. Those entries
 * matter as much as the denied ones: they are the reason a token with no
 * `Sys.Audit` at all can still list nodes, storage and (a filtered) VM list.
 */
export const PROXMOX_ENDPOINT_PERMISSIONS: ProxmoxAclRequirement[] = [
  // -- discovery ------------------------------------------------------------
  { path: "/version", method: "GET", feature: "discovery", capability: "API reachability and version", privilege: null },
  { path: "/nodes", method: "GET", feature: "discovery", capability: "Node discovery", privilege: null, filtered: true },
  { path: "/cluster/nextid", method: "GET", feature: "discovery", capability: "Next free VMID", privilege: null },

  // -- cluster / node inventory ---------------------------------------------
  { path: "/cluster/status", method: "GET", feature: "cluster_inventory", capability: "Cluster membership and quorum", privilege: "Sys.Audit", aclPath: "/" },
  { path: "/cluster/resources", method: "GET", feature: "cluster_inventory", capability: "Cluster-wide resource inventory", privilege: null, filtered: true },
  { path: "/cluster/config/nodes", method: "GET", feature: "cluster_inventory", capability: "Node configuration", privilege: "Sys.Audit", aclPath: "/" },
  { path: "/nodes/{node}/status", method: "GET", feature: "cluster_inventory", capability: "Node CPU, memory and uptime", privilege: "Sys.Audit", aclPath: "/nodes/{node}" },
  { path: "/nodes/{node}/version", method: "GET", feature: "cluster_inventory", capability: "Node software version", privilege: null },
  { path: "/nodes/{node}/tasks", method: "GET", feature: "cluster_inventory", capability: "Task history", privilege: null, filtered: true },
  { path: "/nodes/{node}/netstat", method: "GET", feature: "cluster_inventory", capability: "Node network counters", privilege: "Sys.Audit", aclPath: "/nodes/{node}" },
  { path: "/nodes/{node}/disks/list", method: "GET", feature: "storage", capability: "Disk usage by device", privilege: "Sys.Audit", aclPath: "/nodes/{node}", alternativeAclPaths: ["/"], note: "Proxmox accepts Sys.Audit on the node path or on /; the node path is the narrower grant." },

  // -- VM inventory ---------------------------------------------------------
  { path: "/nodes/{node}/qemu", method: "GET", feature: "vm_inspection", capability: "QEMU VM inventory", privilege: null, filtered: true, note: "Returns only VMs the caller holds VM.Audit on." },
  { path: "/nodes/{node}/lxc", method: "GET", feature: "vm_inspection", capability: "LXC inventory", privilege: null, filtered: true },

  // -- VM inspection --------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/config", method: "GET", feature: "vm_inspection", capability: "VM configuration", privilege: "VM.Audit", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/status/current", method: "GET", feature: "vm_inspection", capability: "VM runtime status", privilege: "VM.Audit", aclPath: "/vms/{vmid}" },

  // -- console --------------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/vncproxy", method: "POST", feature: "console", capability: "VNC (graphical) console ticket", privilege: "VM.Console", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/termproxy", method: "POST", feature: "console", capability: "Serial console ticket", privilege: "VM.Console", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/sendkey", method: "PUT", feature: "console", capability: "Send keystrokes to the console", privilege: "VM.Console", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/lxc/{vmid}/vncproxy", method: "POST", feature: "console", capability: "LXC console ticket", privilege: "VM.Console", aclPath: "/vms/{vmid}" },

  // -- power ----------------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/status/start", method: "POST", feature: "vm_power", capability: "Start a VM", privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/status/stop", method: "POST", feature: "vm_power", capability: "Stop a VM", privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/status/reboot", method: "POST", feature: "vm_power", capability: "Reboot a VM", privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/status/shutdown", method: "POST", feature: "vm_power", capability: "Shut down a VM", privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/status/reset", method: "POST", feature: "vm_power", capability: "Reset a VM", privilege: "VM.PowerMgmt", aclPath: "/vms/{vmid}" },

  // -- configuration --------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/config", method: "PUT", feature: "vm_config", capability: "Change VM configuration", privilege: null, alternatives: ["VM.Config.Disk", "VM.Config.CDROM", "VM.Config.CPU", "VM.Config.Memory", "VM.Config.Network", "VM.Config.HWType", "VM.Config.Options", "VM.Config.Cloudinit"], aclPath: "/vms/{vmid}", note: "Any one of the VM.Config.* privileges satisfies this endpoint." },
  { path: "/nodes/{node}/qemu/{vmid}/clone", method: "POST", feature: "vm_config", capability: "Clone from a template", privilege: "VM.Clone", aclPath: "/vms/{vmid}", alsoRequires: [{ privilege: "VM.Allocate", aclPath: "/vms/{newid}", note: "Or VM.Allocate on the target pool." }], note: "Both halves are required: VM.Clone on the source alone will be rejected." },
  { path: "/nodes/{node}/qemu/{vmid}", method: "DELETE", feature: "vm_config", capability: "Delete a VM", privilege: "VM.Allocate", aclPath: "/vms/{vmid}" },

  // -- snapshots ------------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/snapshot", method: "GET", feature: "snapshot", capability: "List snapshots", privilege: "VM.Audit", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/snapshot", method: "POST", feature: "snapshot", capability: "Create a snapshot", privilege: "VM.Snapshot", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/snapshot/{snapname}", method: "DELETE", feature: "snapshot", capability: "Delete a snapshot", privilege: "VM.Snapshot", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback", method: "POST", feature: "snapshot", capability: "Roll back a snapshot", privilege: null, alternatives: ["VM.Snapshot", "VM.Snapshot.Rollback"], aclPath: "/vms/{vmid}" },

  // -- backup ---------------------------------------------------------------
  { path: "/nodes/{node}/vzdump", method: "POST", feature: "backup", capability: "Create a vzdump backup", privilege: null, filtered: true, note: "Endpoint is user:all, but the handler requires VM.Backup on the guest and Datastore.AllocateSpace on the backup storage." },

  // -- guest agent ----------------------------------------------------------
  { path: "/nodes/{node}/qemu/{vmid}/agent", method: "GET", feature: "guest_agent", capability: "Guest agent status flag", privilege: null },
  { path: "/nodes/{node}/qemu/{vmid}/agent/get-osinfo", method: "GET", feature: "guest_agent", capability: "Guest OS information", privilege: null, alternatives: ["VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted"], aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/get-fsinfo", method: "GET", feature: "guest_agent", capability: "Guest filesystem information", privilege: null, alternatives: ["VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted"], aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces", method: "GET", feature: "guest_agent", capability: "Guest network interfaces", privilege: null, alternatives: ["VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted"], aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/get-users", method: "GET", feature: "guest_agent", capability: "Guest user list", privilege: null, alternatives: ["VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted"], aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/ping", method: "POST", feature: "guest_agent", capability: "Guest agent liveness ping", privilege: null, alternatives: ["VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted"], aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/exec", method: "POST", feature: "guest_agent", capability: "Run a command inside the guest", privilege: "VM.GuestAgent.Unrestricted", aclPath: "/vms/{vmid}" },
  { path: "/nodes/{node}/qemu/{vmid}/agent/exec-status", method: "GET", feature: "guest_agent", capability: "Poll a guest command result", privilege: "VM.GuestAgent.Unrestricted", aclPath: "/vms/{vmid}" },

  // -- storage --------------------------------------------------------------
  { path: "/nodes/{node}/storage", method: "GET", feature: "storage", capability: "Storage inventory on a node", privilege: null, filtered: true, note: "Returns only storages the caller holds Datastore.Audit or Datastore.AllocateSpace on." },
  { path: "/nodes/{node}/storage/{storage}", method: "GET", feature: "storage", capability: "Storage configuration", privilege: null, alternatives: ["Datastore.Audit", "Datastore.AllocateSpace"], aclPath: "/storage/{storage}" },
  { path: "/nodes/{node}/storage/{storage}/content", method: "GET", feature: "storage", capability: "Storage volume listing", privilege: null, alternatives: ["Datastore.Audit", "Datastore.AllocateSpace"], aclPath: "/storage/{storage}" },
]

/** Endpoints whose result set is filtered by the caller's own privileges. */
export function filteredEndpoints(feature?: ProxmoxFeatureKey) {
  return PROXMOX_ENDPOINT_PERMISSIONS.filter((entry) => entry.filtered && (!feature || entry.feature === feature))
}

/**
 * Fill `{node}` and `{vmid}` in a schema path with real values.
 *
 * The matrix is written in Proxmox's own placeholder form so it can be diffed
 * against the live schema, which means matching a real request URL against it
 * requires resolving the placeholders first.
 */
export function normaliseEndpointPath(path: string, params: { node?: string | null; vmid?: number | string | null; snapname?: string | null } = {}) {
  let out = String(path || "").replace(/^\/api2\/json/, "")
  out = out.replace(/\{node\}/g, encodeURIComponent(String(params.node ?? "{node}")))
  out = out.replace(/\{vmid\}/g, encodeURIComponent(String(params.vmid ?? "{vmid}")))
  out = out.replace(/\{snapname\}/g, String(params.snapname ?? "{snapname}"))
  return out.replace(/\/+$/, "") || "/"
}

/**
 * Resolve a concrete API path back to its schema entry.
 *
 * Matches most-specific-first: `/nodes/pve/qemu/100/snapshot` has to be able to
 * match the snapshot row rather than the `/nodes/{node}/qemu/{vmid}` row, or
 * every snapshot call would be reported as a plain VM call.
 */
export function findEndpointRequirement(path: string, method = "GET", params: { node?: string | null; vmid?: number | string | null } = {}) {
  const normalised = normaliseEndpointPath(path, params)
  const upper = String(method || "GET").toUpperCase()

  // Build a matcher per schema path by replacing whole `{param}` segments with a
  // single-segment wildcard, then match most-specific-first.
  //
  // Sorting by path length is what keeps `/nodes/pve/qemu/100/snapshot` matching
  // the snapshot row rather than the `/nodes/{node}/qemu/{vmid}` row.
  const candidates = PROXMOX_ENDPOINT_PERMISSIONS
    .filter((entry) => entry.method === upper)
    .map((entry) => ({
      entry,
      regex: new RegExp(`^${entry.path.split("/").map(escapePathSegment).join("/")}$`),
    }))
    .sort((a, b) => b.entry.path.length - a.entry.path.length)

  for (const { entry, regex } of candidates) {
    if (regex.test(normalised)) return entry
  }
  return null
}

/** One path segment: a `{placeholder}` matches any single segment, else literal. */
function escapePathSegment(segment: string): string {
  if (/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(segment)) return "[^/]+"
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type PermissionDenial = {
  /** The endpoint that was denied, in Proxmox schema form. */
  endpoint: string
  /** The endpoint as it was actually requested. */
  requestedPath: string
  method: string
  httpStatus: number
  /** The capability this endpoint was being called for. */
  capability: string
  feature: ProxmoxFeatureKey
  featureLabel: string
  /** The privilege Proxmox wanted, or null when the endpoint has no explicit check. */
  requiredPrivilege: string | null
  /** Valid alternatives, when Proxmox accepts any one of a set. */
  alternatives: string[]
  /** The ACL path the privilege is evaluated against. */
  aclPath: string | null
  /** Proxmox returns 403 with `{"data":null}` and never says which privilege. */
  proxmoxMessage: string
  /** An administrator-facing instruction. Never executed automatically. */
  remediation: string
}

/**
 * Strip anything credential-shaped out of text before it reaches an operator.
 *
 * Proxmox echoes the offending token in some error bodies, and that body ends up
 * in a diagnostic message, a JSON API response and eventually a screenshot in a
 * support ticket. Redaction happens here so every consumer of `explainDenial` is
 * covered without each of them remembering to do it.
 */
export function redactProxmoxSecrets(value: unknown): string {
  return String(value ?? "")
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
    .replace(/PVEVNC:[^\s"'<>]+/gi, "PVEVNC:[redacted]")
    .replace(/([?&](?:ticket|password|token|secret)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b(CSRFPreventionToken:)\s*\S+/gi, "$1 [redacted]")
}

/**
 * Explain a Proxmox permission denial.
 *
 * Proxmox's 403 carries no detail whatsoever — the body is `{"data":null}` — so
 * the only way to tell an administrator what to grant is to know which endpoint
 * failed. This resolves that endpoint against the verified matrix and returns
 * the privilege, its ACL scope, and the `pveacl` line that would grant it.
 *
 * The remediation is a *printed instruction*. Nothing in the panel runs it:
 * changing a Proxmox ACL is an administrator decision made in the Proxmox shell.
 */
export function explainDenial(input: {
  path: string
  method?: string
  httpStatus: number
  proxmoxMessage?: string | null
  params?: { node?: string | null; vmid?: number | string | null }
}): PermissionDenial | null {
  const method = String(input.method || "GET").toUpperCase()
  const requestedPath = normaliseEndpointPath(input.path, input.params)
  const requirement = findEndpointRequirement(requestedPath, method, input.params)
  const feature = requirement?.feature ?? "discovery"
  const featureLabel = PROXMOX_FEATURE_PRIVILEGES[feature].label

  const alternatives = requirement?.alternatives ?? []
  const requiredPrivilege = requirement?.privilege ?? null
  const aclPath = requirement?.aclPath ?? null

  let remediation: string
  if (input.httpStatus === 401) {
    remediation =
      "Proxmox rejected the token itself. Check the token ID matches the user it was created for, that the secret is correct, and that the token has not been revoked."
  } else if (!requirement) {
    remediation =
      `No ACL expectation is recorded for ${method} ${requestedPath}. Re-run permission verification against this Proxmox's API schema; the panel may be calling an endpoint that changed in a Proxmox upgrade.`
  } else if (requiredPrivilege) {
    remediation = `Grant ${requiredPrivilege} on ${aclPath} for the API token's user, on the Proxmox host. This is a change to the Proxmox ACL and must be applied by an administrator; the panel does not modify ACLs.`
  } else if (alternatives.length > 1) {
    remediation = `Grant any one of ${alternatives.join(", ")} on ${aclPath} for the API token's user, on the Proxmox host.`
  } else {
    remediation = requirement.note
      ? `${requirement.note} Apply any ACL change on the Proxmox host as an administrator; the panel does not modify ACLs.`
      : `Proxmox applies no explicit privilege check to ${method} ${requestedPath}. A denial here usually means the request never reached the handler — check the reverse proxy and authentication in front of Proxmox.`
  }

  return {
    endpoint: requirement?.path ?? requestedPath,
    requestedPath,
    method,
    httpStatus: input.httpStatus,
    capability: requirement?.capability ?? "Unknown capability",
    feature,
    featureLabel,
    requiredPrivilege,
    alternatives,
    aclPath,
    proxmoxMessage: (() => {
      const text = redactProxmoxSecrets(input.proxmoxMessage).trim()
      return text && !/^PVE(APIToken|AuthCookie)=\[redacted\]$/.test(text)
        ? text
        : "Proxmox returned 403 with an empty body and did not name the missing privilege."
    })(),
    remediation,
  }
}

/**
 * The least-privilege `pveacl` setup for one feature.
 *
 * Returned as text for an administrator to run in the Proxmox shell. `{node}`,
 * `{vmid}` and `{storage}` are left as placeholders on purpose — the panel shows
 * the shape of the grant and the administrator fills in the real names. Nothing
 * here is executed by the application.
 */
export function aclSetupGuide(feature: ProxmoxFeatureKey, substitutions: { node?: string; vmid?: number | string; storage?: string } = {}) {
  const spec = PROXMOX_FEATURE_PRIVILEGES[feature]
  const substitute = (value: string) =>
    String(value)
      .replace(/\{node\}/g, substitutions.node ?? "<node>")
      .replace(/\{vmid\}/g, String(substitutions.vmid ?? "<vmid>"))
      .replace(/\{storage\}/g, substitutions.storage ?? "<storage>")

  if (!spec.privileges.length) {
    return {
      feature,
      label: spec.label,
      description: spec.description,
      /** No ACL change is required for this feature. */
      commands: [] as string[],
      note: "This feature needs no Proxmox ACL change: every endpoint involved is open to any authenticated user.",
    }
  }

  const commands = spec.privileges.map(({ privilege, aclPath }) => {
    const path = substitute(aclPath)
    return path.includes("<")
      ? `pveacl modify acl -add -users <user>@<realm> -roles <role> -privs ${privilege} ${aclPath}`
      : `pveacl modify acl -add -users <user>@<realm> -roles <role> -privs ${privilege} ${path}`
  })

  return {
    feature,
    label: spec.label,
    description: spec.description,
    commands,
    note:
      "Run these in the Proxmox shell as an administrator, substituting <user>, <realm> and <role>. Tokens inherit the privileges of the user they belong to when privilege separation is on, which is the default and must stay on.",
  }
}

/** Every feature, with its least-privilege grant, for the admin setup guide. */
export function fullAclSetupGuide() {
  return (Object.keys(PROXMOX_FEATURE_PRIVILEGES) as ProxmoxFeatureKey[]).map((feature) => aclSetupGuide(feature))
}