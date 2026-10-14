import assert from "node:assert/strict"
import test from "node:test"
import {
  ProxmoxTestCluster,
  assertProxmoxTestModeHostIsNotProduction,
  isMutatingProxmoxRequest,
  isProxmoxTestMode,
} from "../../../lib/proxmox-test-double"

/**
 * Safety contract for provisioning tests.
 *
 * The point of these is not to test Proxmox; it is to prove that a test which
 * exercises provisioning, retry and recovery *cannot* reach live customer
 * infrastructure. Development is wired to real node MUB-1, so a test that
 * silently reached the network would clone, restart or delete real VMs.
 */

test("a test cluster answers the endpoints provisioning depends on, with no network", () => {
  const cluster = new ProxmoxTestCluster({ vms: [{ vmid: 100, name: "template", template: true }] })
  const node = cluster.node

  assert.equal(cluster.handle({ endpoint: "/cluster/status", method: "GET" }).statusCode, 200)
  assert.equal(cluster.handle({ endpoint: `/nodes/${node}/status`, method: "GET" }).statusCode, 200)
  assert.equal(cluster.handle({ endpoint: `/nodes/${node}/storage`, method: "GET" }).statusCode, 200)
  assert.equal(cluster.handle({ endpoint: `/nodes/${node}/tasks`, method: "GET" }).statusCode, 200)

  const storage = cluster.handle({ endpoint: `/nodes/${node}/storage`, method: "GET" }).data as any[]
  const byId = Object.fromEntries(storage.map((entry) => [entry.storage, entry]))
  // Mirrors the real development node: one thin pool and one directory pool.
  assert.equal(byId["local-lvm"].type, "lvmthin")
  assert.equal(byId.local.type, "dir")
})

test("clone, start, reconfigure and delete are all reachable without a network", () => {
  const cluster = new ProxmoxTestCluster({ vms: [{ vmid: 100, name: "tmpl", template: true }] })
  const node = cluster.node

  const cloned = cluster.handle({ endpoint: `/nodes/${node}/qemu/100/clone`, method: "POST", body: { newid: 101, name: "customer-vm" } })
  assert.equal(cloned.statusCode, 200)
  const newVmid = Number(cloned.data.data.split(":").pop())
  assert.ok(cluster.vms.has(newVmid))

  cluster.handle({ endpoint: `/nodes/${node}/qemu/${newVmid}/status`, method: "POST", body: { status: "running" } })
  assert.equal(cluster.vms.get(newVmid)?.status, "running")

  cluster.handle({ endpoint: `/nodes/${node}/qemu/${newVmid}/config`, method: "POST", body: { memory: 4096, cores: 4 } })
  assert.equal(cluster.vms.get(newVmid)?.memory, 4096)

  cluster.handle({ endpoint: `/nodes/${node}/qemu/${newVmid}`, method: "DELETE" })
  assert.ok(!cluster.vms.has(newVmid), "delete must actually remove the guest")
})

test("every mutating call is recorded so a test can assert on blast radius", () => {
  const cluster = new ProxmoxTestCluster({ vms: [{ vmid: 100, template: true }] })
  const node = cluster.node
  cluster.handle({ endpoint: `/nodes/${node}/status`, method: "GET" })
  cluster.handle({ endpoint: `/nodes/${node}/qemu/100/clone`, method: "POST", body: {} })
  cluster.handle({ endpoint: `/nodes/${node}/qemu/101/status`, method: "POST", body: { status: "start" } })

  assert.equal(cluster.mutatingCalls().length, 2)
  assert.equal(cluster.calls.length, 3)
  // Reads are never mistaken for writes.
  assert.equal(isMutatingProxmoxRequest({ endpoint: "/nodes/x/status", method: "GET" }), false)
  assert.equal(isMutatingProxmoxRequest({ endpoint: "/nodes/x/qemu", method: "POST" }), true)
  assert.equal(isMutatingProxmoxRequest({ endpoint: "/nodes/x/qemu", method: "delete" }), true)
})

test("a saturated clone queue is reproducible on demand", () => {
  const busy = new ProxmoxTestCluster({ queuedTasks: 8, activeTasks: 3 })
  const tasks = busy.handle({ endpoint: `/nodes/${busy.node}/tasks`, method: "GET" }).data as any[]
  assert.equal(tasks.length, 11)
  assert.equal(tasks.filter((task) => task.status === "queued").length, 8)

  const idle = new ProxmoxTestCluster({ queuedTasks: 0, activeTasks: 0 })
  assert.deepEqual(idle.handle({ endpoint: `/nodes/${idle.node}/tasks`, method: "GET" }).data, [])
})

test("retry behaviour can be driven by injecting transient failures", () => {
  const cluster = new ProxmoxTestCluster({ vms: [{ vmid: 100, template: true }] })
  cluster.failNext(2, 502)
  // Two failures are consumed, then the call succeeds - the shape a retry loop
  // needs in order to prove it recovers rather than giving up.
  assert.equal(cluster.handle({ endpoint: `/nodes/${cluster.node}/qemu/100/clone`, method: "POST", body: {} }).statusCode, 502)
  assert.equal(cluster.handle({ endpoint: `/nodes/${cluster.node}/qemu/100/clone`, method: "POST", body: {} }).statusCode, 502)
  assert.equal(cluster.handle({ endpoint: `/nodes/${cluster.node}/qemu/100/clone`, method: "POST", body: {} }).statusCode, 200)
})

test("the rejected-token and unreachable-host failures reproduce exactly", () => {
  // Proxmox answers a bad token with 401 and an empty body.
  const auth = new ProxmoxTestCluster({ authFailure: true })
  const denied = auth.handle({ endpoint: `/nodes/${auth.node}/status`, method: "GET" })
  assert.equal(denied.statusCode, 401)
  assert.equal(denied.data, null, "the body must be empty, which is what produced the {\"data\":null} alert")

  // An unreachable host must raise a transport error, not return a payload.
  const offline = new ProxmoxTestCluster({ networkFailure: true })
  assert.throws(() => offline.handle({ endpoint: `/nodes/${offline.node}/status`, method: "GET" }), /ECONNREFUSED/)
})

test("a guest agent that never answers is reproducible", () => {
  const cluster = new ProxmoxTestCluster({ guestAgentOnline: false, vms: [{ vmid: 200, status: "running" }] })
  const node = cluster.node
  assert.equal(cluster.handle({ endpoint: `/nodes/${node}/qemu/200/agent/ping`, method: "GET" }).statusCode, 500)
  // The VM itself is still reported as running, which is the case that used to
  // leave provisioning stuck at "running" with no explanation.
  const status = cluster.handle({ endpoint: `/nodes/${node}/qemu/200/status`, method: "GET" })
  assert.equal(status.statusCode, 200)
  assert.equal((status.data as any).status, "running")
})

test("allocated RAM is tracked so allocation policy can be tested against the cluster", () => {
  const cluster = new ProxmoxTestCluster({ vms: [{ vmid: 100, memory: 2048 }, { vmid: 101, memory: 4096 }] })
  assert.equal(cluster.allocatedRamGb(), 6)
})

test("test mode is opt-in and can never be pointed at a production host", () => {
  assert.equal(isProxmoxTestMode({} as NodeJS.ProcessEnv), false)
  assert.equal(isProxmoxTestMode({ ZWS_INFRA_TEST_MODE: "1" } as NodeJS.ProcessEnv), true)
  assert.equal(isProxmoxTestMode({ ZWS_INFRA_TEST_MODE: "true" } as NodeJS.ProcessEnv), true)

  const env = { ZWS_PRODUCTION_PROXMOX_HOSTS: "m2-v2.irctcrdp.com" } as NodeJS.ProcessEnv
  assert.throws(() => assertProxmoxTestModeHostIsNotProduction("https://m2-v2.irctcrdp.com:8006", env), /refusing to build a test client for production host/)
  // A genuine test host is accepted.
  assert.equal(assertProxmoxTestModeHostIsNotProduction("https://mocknode.invalid:8006", env), true)
})

test("the client factory routes through the double only when test mode is on", () => {
  const source = readFileSync("lib/proxmox.ts", "utf8")
  const factory = source.slice(source.indexOf("export function createProxmoxClient("))
  // The test-mode branch must come before the real client is constructed.
  assert.ok(
    factory.indexOf("isProxmoxTestMode()") < factory.indexOf("new ProxmoxClient("),
    "test mode must be checked before any real client is built"
  )
  assert.match(factory, /assertProxmoxTestModeHostIsNotProduction\(host\)/)
  // Substituting only the transport is sufficient: every public method
  // delegates to requestWithStatus.
  assert.match(
    source,
    /async requestWithStatus<T>\(endpoint: string, method = "GET"[\s\S]{0,80}Promise<ProxmoxResponse<T>> \{\s*return proxmoxRequest/
  )
})

import { readFileSync } from "node:fs"