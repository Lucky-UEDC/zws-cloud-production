import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const page = fs.readFileSync(path.join(root, "app/status/page.tsx"), "utf8")
const monitor = fs.readFileSync(path.join(root, "components/status/live-platform-status.tsx"), "utf8")
const healthRoute = fs.readFileSync(path.join(root, "app/api/health/route.ts"), "utf8")
const diagnosticsRoute = fs.readFileSync(path.join(root, "app/api/admin/diagnostics/route.ts"), "utf8")

test("public status page reports live health without fabricated service data", () => {
  assert.match(page, /LivePlatformStatus/)
  assert.doesNotMatch(page, /placeholder status page|99\.993|Compute \(BOM\)|Elevated latency in FRA/)
  assert.match(monitor, /fetch\("\/api\/health", \{ cache: "no-store" \}\)/)
  assert.match(monitor, /window\.setInterval\(refresh, 30_000\)/)
  assert.match(monitor, /operational|degraded|unavailable/)
})

test("PM2 probes survive release-directory replacement", () => {
  for (const source of [healthRoute, diagnosticsRoute]) {
    assert.match(source, /execFileAsync\("pm2", \["jlist"\], \{ cwd: "\/"/)
  }
})

// A WhatsApp outage still has to be visible, but it must not decide whether the
// whole platform is healthy: an external provider's latency was enough to turn
// the entire panel red, which trains everyone to ignore the signal. It is
// reported as a warning on both response shapes instead.
//
// The second assertion is the guard against over-correcting: the warning logic
// has to still look at the session, the worker heartbeat and the probe result,
// so a real outage cannot slip through unreported.
test("configured WhatsApp outages are reported as a warning, not as platform health", () => {
  const gateStart = healthRoute.indexOf("const healthy =")
  const gateEnd = healthRoute.indexOf("if (!wantsVerbose", gateStart)
  const gate = healthRoute.slice(gateStart, gateEnd)

  assert.doesNotMatch(gate, /whatsapp\.ok/, "WhatsApp must not gate platform health")
  assert.doesNotMatch(gate, /whatsappReport/)

  assert.match(healthRoute, /const whatsappRequired = queuesReport\?\.whatsappConfigured === true/)
  assert.match(healthRoute, /!whatsapp\.ok/, "the warning must consider a failed probe")
  assert.match(healthRoute, /!whatsappReport\?\.connected/, "the warning must consider a disconnected session")
  assert.match(healthRoute, /whatsappRequired && !whatsappReport\?\.workerHeartbeatFresh/, "a stale worker heartbeat must still be reported")

  // Visible on both response shapes, so a monitor reading only the status code
  // can still alert on it.
  assert.match(healthRoute, /warning: whatsappWarning/)
  assert.match(healthRoute, /warnings: whatsappWarning \? \[whatsappWarning\] : \[\]/)
})
