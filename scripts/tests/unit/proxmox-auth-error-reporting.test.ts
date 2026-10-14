import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { safeMonitoringError } from "../../../lib/compute-node-monitoring"

/**
 * Regression for the MUB-1 telemetry failure.
 *
 * Proxmox answers a rejected API token with HTTP 401 and the body
 * `{"data":null}`. The client stringified that body into the error message, so
 * the node-offline alert an administrator saw was literally:
 *
 *   title:   MUB-1 offline
 *   message: {"data":null}
 *
 * which names no cause at all. The endpoint was in fact reachable - only the
 * credential was rejected - so the operator had no way to tell an auth problem
 * from a network one without repeating the investigation by hand.
 */

const read = (path: string) => readFileSync(path, "utf8")

test("a rejected token is reported as an auth failure, not as its empty body", () => {
  const authFailure = {
    // What the client now builds for a 401 with a `{"data":null}` body.
    message: "Unauthorized token",
    status: 400,
    httpStatus: 401,
    code: "AUTH_FAILED_401",
  }
  assert.equal(safeMonitoringError(authFailure), "Proxmox authentication or permission failed")

  // The classification must not depend on the message wording: even if the
  // raw body still leaks through, the code alone is enough.
  assert.equal(
    safeMonitoringError({ message: '{"data":null}', status: 400, httpStatus: 401, code: "AUTH_FAILED_401" }),
    "Proxmox authentication or permission failed"
  )
  // Permission denied (403) is the same operator problem.
  assert.equal(
    safeMonitoringError({ message: "Permission denied", status: 400, httpStatus: 403, code: "PERMISSION_DENIED_403" }),
    "Proxmox authentication or permission failed"
  )
})

test("an empty error body never reaches an administrator verbatim", () => {
  // Whatever the path, `{"data":null}` must not be the message an operator reads.
  const rendered = safeMonitoringError({ message: '{"data":null}', status: 502, code: "UNKNOWN_ERROR" })
  assert.notEqual(rendered, '{"data":null}')
  assert.match(rendered, /Proxmox/)
})

test("other classifications keep working and tokens stay redacted", () => {
  assert.equal(safeMonitoringError({ message: "x", code: "TEMPLATE_MISSING" }), "Proxmox template is missing")
  assert.equal(safeMonitoringError({ message: "x", code: "STORAGE_UNAVAILABLE" }), "Proxmox storage is unavailable")
  assert.equal(safeMonitoringError({ message: "x", code: "INSUFFICIENT_RESOURCES" }), "Proxmox node has insufficient resources")
  assert.equal(safeMonitoringError({ message: "Proxmox API timeout after 15000ms" }), "Proxmox API timeout")
  assert.equal(safeMonitoringError({ message: "TLS handshake failed" }), "Proxmox TLS/certificate issue")
  assert.equal(safeMonitoringError({ message: "TCP connection refused" }), "Unable to reach Proxmox host")

  // A real, informative Proxmox message is still surfaced verbatim.
  assert.equal(
    safeMonitoringError({ message: "no such VM: 101", code: "VM_NOT_FOUND" }),
    "Proxmox VM was not found on this node"
  )

  // Secrets must never survive into the alert text.
  const redacted = safeMonitoringError({ message: "clone failed for PVEAPIToken=root@pam!secret=abc123", code: "CLONE_FAILED" })
  assert.ok(!redacted.includes("abc123"), `token leaked into the alert: ${redacted}`)
  assert.match(redacted, /redacted/)
})

test("the client prefers the HTTP status over an uninformative response body", () => {
  const source = read("lib/proxmox.ts")
  const body = source.slice(source.indexOf("function errorMessageForStatus"), source.indexOf("function apiStatusForProxmoxStatus"))

  // The 401/403 wording must be decided before the generic detail is used.
  const authIndex = body.indexOf("Unauthorized token")
  const detailIndex = body.indexOf("proxmoxDetailText(fallback)")
  assert.ok(authIndex > -1, "a 401 must have its own message")
  assert.ok(detailIndex > -1, "the response detail must still be used where it helps")
  assert.ok(authIndex < detailIndex, "the status-specific message must win over a detail that may be empty")
  assert.match(body, /if \(status === 401\) return "Unauthorized token"/)
  assert.match(body, /if \(status === 403\) return "Permission denied"/)
  // A body that says nothing must not be preferred over the status wording.
  assert.match(body, /"data"\s*:\s*null/)
})

test("the monitoring classifier keys on the auth codes the client emits", () => {
  const source = read("lib/compute-node-monitoring.ts")
  const body = source.slice(source.indexOf("export function safeMonitoringError"))
  assert.match(body, /AUTH_FAILED_401/)
  assert.match(body, /PERMISSION_DENIED_403/)
  assert.match(body, /httpStatus/)
})