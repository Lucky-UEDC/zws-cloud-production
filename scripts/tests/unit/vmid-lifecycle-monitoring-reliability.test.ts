import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function read(path: string) {
  return readFileSync(path, "utf8")
}

test("shared VPS power control queues authorized node and VMID lifecycle actions", () => {
  const source = read("lib/vm-action-jobs.ts")
  assert.match(source, /VMID_INVALID/)
  assert.match(source, /VM_NOT_FOUND/)
  assert.match(source, /client\.startVM\(job\.nodeName, job\.vmid\)/)
  assert.match(source, /robustlyStopVm\(\{ client, node: job\.nodeName, vmid: job\.vmid, graceful: true/)
  assert.match(source, /robustlyRebootVm\(\{ client, node: job\.nodeName, vmid: job\.vmid \}\)/)
  assert.doesNotMatch(source, /getVMStatus\([^,\n]+hostname/i)
  assert.doesNotMatch(source, /startVM\([^,\n]+hostname/i)
  assert.doesNotMatch(source, /stopVM\([^,\n]+hostname/i)
})

test("legacy admin VMID action route delegates to shared VM action service", () => {
  const source = read("app/api/admin/proxmox/vms/[vmid]/action/route.ts")
  assert.match(source, /runAdminVmAction\(\{ vpsId: vps\.id, action, actorEmail/)
  assert.doesNotMatch(source, /createProxmoxClient/)
  assert.doesNotMatch(source, /\.startVM\(/)
  assert.doesNotMatch(source, /\.stopVM\(/)
  assert.doesNotMatch(source, /\.rebootVM\(/)
})

test("VM power fallback remains VMID-only and escalates shutdown stop kill", () => {
  const source = read("lib/vm-power-control.ts")
  assert.match(source, /shutdownVM\(node, vmid\)/)
  assert.match(source, /stopVM\(node, vmid/)
  assert.match(source, /qemu-server\/\$\{vmid\}\.pid/)
  assert.match(source, /resetVM\(input\.node, input\.vmid\)/)
  assert.doesNotMatch(source, /hostname/)
})

test("customer monitoring copy distinguishes a telemetry gap from an offline server", () => {
  const status = read("app/api/client/vps/[id]/status/route.ts")
  const metrics = read("app/api/client/vps/[id]/metrics/route.ts")
  const truth = read("lib/vm-db-truth.ts")
  const page = read("app/client-area/vps/[id]/page.tsx")
  // The API still distinguishes the two, and still reports it precisely.
  assert.doesNotMatch(status, /createProxmoxClient/)
  assert.match(truth, /Monitoring unavailable/)
  assert.match(truth, /Guest agent offline/)
  assert.match(truth, /guestAgentStatus/)
  assert.match(truth, /reported: diskUsageReported/)
  assert.doesNotMatch(metrics, /createProxmoxClient/)
  assert.match(truth, /UNAVAILABLE/)

  // The customer copy changed on purpose. "Monitoring unavailable",
  // "Usage unavailable" and "No traffic sample" all read as faults on a
  // perfectly healthy server whose last sample simply predates the poll, which
  // is the complaint this release fixes. The API vocabulary above stays; the
  // page now says when the number was measured, or that it was never measured.
  assert.match(page, /Not collected yet/)
  assert.match(page, /Last recorded/)
  assert.doesNotMatch(page, /Monitoring unavailable/)
  assert.doesNotMatch(page, /Usage unavailable/)
  assert.doesNotMatch(page, /Server offline/)
  assert.doesNotMatch(page, /Not reported yet/)
})

test("production reconciliation is VMID-only, locked, and reports conflicts instead of duplicating records", () => {
  const engine = read("lib/production-vps-reconciliation.ts")
  const cli = read("scripts/reconcile-production-vps.ts")
  const worker = read("scripts/database-first-proxmox-sync-worker.ts")
  assert.match(cli, /--dry-run/)
  assert.match(cli, /--apply/)
  assert.match(cli, /--report/)
  assert.match(cli, /--limit/)
  assert.match(cli, /--vps-id/)
  assert.match(worker, /runProductionVpsReconciliation\(\{/)
  assert.match(worker, /5 \* 60 \* 1000/)
  assert.match(engine, /withRedisLock\(LOCK_KEY, LOCK_TTL_MS/)
  assert.match(engine, /client\.getVMStatus\(node\.nodeName, vps\.vmid\)/)
  assert.match(engine, /client\.getVMConfig\(node\.nodeName, vps\.vmid\)/)
  assert.match(engine, /client\.pingVMGuestAgent\(node\.nodeName, vps\.vmid\)/)
  assert.match(engine, /client\.getVMGuestNetworkInterfaces\(node\.nodeName, vps\.vmid\)/)
  assert.match(engine, /duplicate_ip_conflict/)
  assert.match(engine, /duplicate_vmid_rows/)
  assert.match(engine, /assigned_ip_missing_in_database/)
  assert.match(engine, /status: "MISSING"/)
  assert.match(engine, /vmRuntime\.upsert/)
  assert.match(engine, /vmMetricsCache\.upsert/)
  assert.match(engine, /vmNetwork\.upsert/)
  assert.match(engine, /vmNetworkCache\.upsert/)
  assert.doesNotMatch(engine, /getVMStatus\([^,\n]+hostname/i)
  assert.doesNotMatch(engine, /getVMStatus\([^,\n]+ipAddress/i)
  assert.match(engine, /getVMList\(node\.nodeName\)/)
  assert.match(engine, /vmReconciliationIncident\.upsert/)
  assert.match(engine, /createRecoveredVps/)
  assert.match(engine, /vpsInstance\.create/)
  assert.match(engine, /Proxmox VM has no deterministic database owner/)
  assert.doesNotMatch(engine, /ipPool\.create/)
  assert.doesNotMatch(engine, /ipPool\.delete/)
  assert.doesNotMatch(engine, /deleteMany\(\{\s*where:\s*\{\s*pool/i)
})
