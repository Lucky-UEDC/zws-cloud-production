/**
 * In-memory Proxmox test double.
 *
 * Provisioning, retry, clone-queue and recovery logic is the part of this
 * platform most likely to touch something it must not: a real clone, a real
 * delete, a real reboot on a customer's VM. Exercising it against live
 * infrastructure is not acceptable, and stubbing individual call sites leaves
 * the retry and queue paths untested.
 *
 * This double replaces the transport rather than the call sites. Every
 * `ProxmoxClient` method funnels through `requestWithStatus`, so substituting
 * that one method gives the real client the real response shapes while making
 * a network call structurally impossible.
 *
 * Nothing here imports from `lib/proxmox.ts`, which keeps the dependency
 * one-way and avoids a cycle when the client factory selects this transport.
 */

export type ProxmoxFakeResponse<T> = { data: T; statusCode: number }

export type ProxmoxFakeRequest = {
  endpoint: string
  method: string
  body?: any
}

export type ProxmoxFakeVm = {
  vmid: number
  name: string
  node: string
  status: "running" | "stopped"
  template: boolean
  memory: number
  cores: number
  diskGb: number
  net: Record<string, string>
  agentOnline: boolean
}

export type ProxmoxFakeOptions = {
  /** Total capacity, mirroring Proxmox's `/status` payload. */
  cpuCores?: number
  memoryTotalGb?: number
  memoryUsedGb?: number
  diskTotalGb?: number
  diskUsedGb?: number
  /** Tasks the node reports as already queued. Drives queue saturation. */
  queuedTasks?: number
  /** Tasks currently running. */
  activeTasks?: number
  /** Pre-existing VMs, so capacity and inventory assertions have a baseline. */
  vms?: Array<Partial<ProxmoxFakeVm> & { vmid: number }>
  /** Report the API token as rejected, reproducing the MUB-1 failure. */
  authFailure?: boolean
  /** Report the host as unreachable. */
  networkFailure?: boolean
  /** Guest agent does not answer, so readiness checks fail. */
  guestAgentOnline?: boolean
}

/** A mutating call recorded for assertion and for safety assertions. */
export type RecordedCall = ProxmoxFakeRequest & { sequence: number }

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE"])

/**
 * True when a request would change real infrastructure. Anything that creates,
 * reconfigures, restarts or destroys a guest, or resizes storage.
 */
export function isMutatingProxmoxRequest(request: ProxmoxFakeRequest) {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return false
  return true
}

function normalizeEndpoint(endpoint: string) {
  const withoutQuery = String(endpoint || "").split("?")[0]
  return withoutQuery.replace(/\/+$/, "") || "/"
}

export class ProxmoxTestCluster {
  readonly node: string
  readonly options: ProxmoxFakeOptions
  readonly calls: RecordedCall[] = []
  vms = new Map<number, ProxmoxFakeVm>()
  private sequence = 0
  private nextVmid = 100
  /** Set to make the next N requests fail with a chosen status. */
  private transientFailures: Array<{ remaining: number; statusCode: number; body?: unknown }> = []

  constructor(options: ProxmoxFakeOptions = {}, node = "mocknode") {
    this.node = node
    this.options = options
    for (const seed of options.vms || []) {
      const vmid = Number(seed.vmid)
      this.vms.set(vmid, {
        vmid,
        name: String(seed.name || `vm-${vmid}`),
        node,
        status: seed.status || "stopped",
        template: Boolean(seed.template),
        memory: Number(seed.memory ?? 1024),
        cores: Number(seed.cores ?? 1),
        diskGb: Number(seed.diskGb ?? 10),
        net: seed.net || {},
        agentOnline: seed.agentOnline ?? true,
      })
      if (vmid >= this.nextVmid) this.nextVmid = vmid + 1
    }
  }

  /** Queue the next `count` requests to fail, to exercise retry and backoff. */
  failNext(count: number, statusCode = 500, body?: unknown) {
    this.transientFailures.push({ remaining: count, statusCode, body })
    return this
  }

  /** Every mutating call made, for assertions about safety. */
  mutatingCalls() {
    return this.calls.filter((call) => isMutatingProxmoxRequest(call))
  }

  reset() {
    this.calls.length = 0
    this.sequence = 0
  }

  private nextId() {
    const id = this.nextVmid
    this.nextVmid += 1
    return id
  }

  /** Total RAM currently promised to guests, in GB. */
  allocatedRamGb() {
    let total = 0
    for (const vm of this.vms.values()) total += vm.memory / 1024
    return Number(total.toFixed(2))
  }

  handle(request: ProxmoxFakeRequest): ProxmoxFakeResponse<any> {
    const sequence = ++this.sequence
    const endpoint = normalizeEndpoint(request.endpoint)
    const method = request.method.toUpperCase()
    this.calls.push({ endpoint: request.endpoint, method, body: request.body, sequence })

    const failure = this.transientFailures.find((entry) => entry.remaining > 0)
    if (failure) {
      failure.remaining -= 1
      return { statusCode: failure.statusCode, data: { data: null, message: failure.body ?? "injected failure" } }
    }

    if (this.options.networkFailure) {
      const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8006"), { code: "ECONNREFUSED" })
      throw error
    }
    // A rejected token answers 401 with an empty body, exactly as Proxmox does.
    if (this.options.authFailure) {
      return { statusCode: 401, data: null }
    }

    return this.route(endpoint, method, request.body)
  }

  private notFound(endpoint: string) {
    return { statusCode: 404, data: { data: null, message: `no such endpoint ${endpoint}` } }
  }

  private route(endpoint: string, method: string, body: any): ProxmoxFakeResponse<any> {
    const node = this.node

    if (endpoint === "/cluster/status") {
      return {
        statusCode: 200,
        data: [{ type: "cluster", name: "zws-test", status: "online", quorum: 1, nodes: 1 }],
      }
    }
    if (endpoint === "/nodes") {
      return {
        statusCode: 200,
        data: [{ node, status: "online", cpu: 0.1, maxcpu: this.options.cpuCores ?? 8, mem: this.options.memoryUsedGb ?? 2, maxmem: this.options.memoryTotalGb ?? 32, uptime: 1000 }],
      }
    }
    if (endpoint === `/nodes/${node}/status`) {
      const memoryTotalGb = this.options.memoryTotalGb ?? 32
      const memoryUsedGb = this.options.memoryUsedGb ?? 2
      const diskTotalGb = this.options.diskTotalGb ?? 400
      const diskUsedGb = this.options.diskUsedGb ?? 100
      return {
        statusCode: 200,
        data: {
          cpu: 0.12,
          cpuinfo: { cpus: this.options.cpuCores ?? 8 },
          memory: { total: memoryTotalGb * 1024 ** 3, used: memoryUsedGb * 1024 ** 3, free: (memoryTotalGb - memoryUsedGb) * 1024 ** 3 },
          rootfs: { total: diskTotalGb * 1024 ** 3, used: diskUsedGb * 1024 ** 3, free: (diskTotalGb - diskUsedGb) * 1024 ** 3 },
          uptime: 1000,
          loadavg: ["0.1", "0.2", "0.3"],
          ksm: { shared: 0 },
        },
      }
    }
    if (endpoint === `/nodes/${node}/storage`) {
      return {
        statusCode: 200,
        data: [
          {
            storage: "local-lvm",
            type: "lvmthin",
            total: (this.options.diskTotalGb ?? 400) * 1024 ** 3,
            used: (this.options.diskUsedGb ?? 100) * 1024 ** 3,
            avail: ((this.options.diskTotalGb ?? 400) - (this.options.diskUsedGb ?? 100)) * 1024 ** 3,
            content: "images,rootdir",
            active: 1,
            enabled: 1,
            shared: 0,
          },
          {
            storage: "local",
            type: "dir",
            total: (this.options.diskTotalGb ?? 400) * 1024 ** 3,
            used: (this.options.diskUsedGb ?? 100) * 1024 ** 3,
            avail: ((this.options.diskTotalGb ?? 400) - (this.options.diskUsedGb ?? 100)) * 1024 ** 3,
            content: "iso,vztmpl,backup",
            active: 1,
            enabled: 1,
            shared: 0,
          },
        ],
      }
    }
    if (endpoint === `/nodes/${node}/tasks`) {
      const queued = this.options.queuedTasks ?? 0
      const active = this.options.activeTasks ?? 0
      return {
        statusCode: 200,
        data: [
          ...Array.from({ length: queued }, (_, index) => ({ upid: `UPID:${node}:mock:${index}`, type: "qmclone", status: "queued", node, id: String(9000 + index) })),
          ...Array.from({ length: active }, (_, index) => ({ upid: `UPID:${node}:run:${index}`, type: "qmclone", status: "running", node, id: String(9500 + index) })),
        ],
      }
    }
    if (endpoint === `/nodes/${node}/nextid`) {
      return { statusCode: 200, data: String(this.nextVmid) }
    }
    if (endpoint === `/nodes/${node}/qemu`) {
      if (method === "GET") {
        return { statusCode: 200, data: [...this.vms.values()].filter((vm) => vm.node === node && !vm.template) }
      }
    }

    let match = endpoint.match(new RegExp(`^/nodes/${node}/qemu/(\\d+)(?:/(.+))?$`))
    if (match) {
      const vmid = Number(match[1])
      const action = match[2] || ""
      const vm = this.vms.get(vmid)

      if (action === "clone" && method === "POST") {
        if (!vm) return this.notFound(endpoint)
        const newVmid = this.nextId()
        const clone: ProxmoxFakeVm = {
          ...vm,
          vmid: newVmid,
          name: String(body?.name || `${vm.name}-clone`),
          status: "stopped",
          template: false,
          net: vm.net,
        }
        this.vms.set(newVmid, clone)
        return { statusCode: 200, data: { data: `UPID:${node}:clone:${newVmid}` } }
      }
      if (action === "status" && method === "POST") {
        if (!vm) return this.notFound(endpoint)
        const wanted = String(body?.status || "")
        if (wanted === "running" || wanted === "stopped") vm.status = wanted
        return { statusCode: 200, data: { data: `UPID:${node}:status:${vmid}` } }
      }
      if (!action && method === "DELETE") {
        if (!vm) return this.notFound(endpoint)
        this.vms.delete(vmid)
        return { statusCode: 200, data: { data: `UPID:${node}:destroy:${vmid}` } }
      }
      if (action === "config" && (method === "PUT" || method === "POST")) {
        if (!vm) return this.notFound(endpoint)
        if (body?.memory) vm.memory = Number(body.memory)
        if (body?.cores) vm.cores = Number(body.cores)
        if (body?.name) vm.name = String(body.name)
        if (body?.net0) vm.net.net0 = String(body.net0)
        return { statusCode: 200, data: null }
      }
      if (action === "status" && method === "GET") {
        if (!vm) return this.notFound(endpoint)
        return {
          statusCode: 200,
          data: {
            vmid: vm.vmid,
            name: vm.name,
            status: vm.status,
            template: vm.template,
            qmpstatus: vm.status,
            maxmem: vm.memory,
            cpus: vm.cores,
            uptime: vm.status === "running" ? 3600 : 0,
            lock: undefined,
          },
        }
      }
      if (action === "config" && method === "GET") {
        if (!vm) return this.notFound(endpoint)
        return {
          statusCode: 200,
          data: {
            vmid: vm.vmid,
            name: vm.name,
            memory: String(vm.memory),
            cores: String(vm.cores),
            net0: vm.net.net0 || "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
            scsi0: `local-lvm:vm-${vm.vmid}-disk-0,size=${vm.diskGb}G`,
            template: vm.template ? 1 : 0,
          },
        }
      }
      if (action === "agent/ping" && method === "GET") {
        const online = this.options.guestAgentOnline ?? vm?.agentOnline ?? true
        if (!online) return { statusCode: 500, data: { data: null, message: "QEMU guest agent is not running" } }
        return { statusCode: 200, data: { data: [] } }
      }
      if (action === "agent/exec" && method === "POST") {
        const online = this.options.guestAgentOnline ?? vm?.agentOnline ?? true
        if (!online) return { statusCode: 500, data: { data: null, message: "QEMU guest agent is not running" } }
        return { statusCode: 200, data: { data: { pid: 1000 + this.sequence } } }
      }
      if (action === "agent/exec-status" && method === "GET") {
        return { statusCode: 200, data: { data: { exited: 0, exitcode: 0, "out-data": "", "err-data": "" } } }
      }
      if (action === "agent/network-get-interfaces" && method === "GET") {
        return {
          statusCode: 200,
          data: {
            data: [{
              "hardware-address": "aa:bb:cc:dd:ee:ff",
              "ip-addresses": [{ "ip-address": "10.20.0.15", "ip-address-type": "ipv4", "prefix": 24 }],
              name: "eth0",
            }],
          },
        }
      }
      return this.notFound(endpoint)
    }

    return this.notFound(endpoint)
  }
}

/**
 * Test mode is opt-in and must never be inferred.
 *
 * Without this switch a test would talk to production, and with it set by
 * accident a deployment would silently stop managing real VMs - so the flag
 * has to be explicit, and the resulting client is obviously fake.
 */
export function isProxmoxTestMode(env: NodeJS.ProcessEnv = process.env) {
  return ["1", "true", "yes"].includes(String(env.ZWS_INFRA_TEST_MODE || "").trim().toLowerCase())
}

export function assertProxmoxTestModeHostIsNotProduction(host: string, env: NodeJS.ProcessEnv = process.env) {
  const forbidden = String(env.ZWS_PRODUCTION_PROXMOX_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  // Proxmox hosts are configured with a scheme and usually a port
  // (`https://m2-v2.example.com:8006`), so the port has to be stripped before
  // comparing against the declared host, otherwise the guard silently misses.
  const normalized = String(host || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/:\d+$/, "")
  const blocked = forbidden
    .map((entry) => entry.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/:\d+$/, ""))
    .filter(Boolean)
    .some((entry) => normalized === entry || normalized.endsWith(`.${entry}`))
  if (blocked) {
    throw new Error(
      `[infra-test-mode] refusing to build a test client for production host "${host}". ` +
        `A test double must never be used to make a production node look healthy.`
    )
  }
  return true
}