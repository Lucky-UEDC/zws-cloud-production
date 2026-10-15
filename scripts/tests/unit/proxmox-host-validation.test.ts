import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateProxmoxHost, assertProxmoxTransportAllowed } from "../../../lib/proxmox/host-validation"

/**
 * Proxmox destination validation.
 *
 * The rule being enforced is narrow and deliberate: a Proxmox node is the
 * customer's own hypervisor and is legitimately a private address — in this
 * deployment it is reached over a Docker bridge. Blocking RFC1918 would block the
 * only thing this feature is for. What must never be reachable is a cloud
 * metadata endpoint, a non-HTTP scheme, or credentials embedded in a URL.
 */

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8")

test("a public Proxmox host over https is accepted and normalised", () => {
  const result = validateProxmoxHost("pve.example.com")
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, "https://pve.example.com:443")
  assert.equal(result.secure, true)
  assert.equal(result.port, 443)
})

test("a bare host is upgraded to https, and the default port fills in", () => {
  const result = validateProxmoxHost("pve.example.com:8006")
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, "https://pve.example.com:8006")
  assert.equal(result.port, 8006)
})

test("a private address is allowed: a Proxmox node often IS one", () => {
  // 172.18.0.1 is the Docker bridge gateway this deployment reaches Proxmox on.
  // The generic SSRF scanner in lib/security/input.ts flags RFC1918; applying it
  // here would break the feature.
  for (const host of ["172.18.0.1:8006", "10.0.0.5:8006", "192.168.1.10:8006", "127.0.0.1:8006"]) {
    const result = validateProxmoxHost(host)
    assert.equal(result.ok, true, `${host} must be allowed as a Proxmox host`)
  }
})

test("cloud metadata endpoints are refused by IP and by hostname", () => {
  for (const host of ["169.254.169.254:8006", "169.254.170.2:8006", "100.100.100.200:8006", "metadata.google.internal:8006"]) {
    const result = validateProxmoxHost(host)
    assert.equal(result.ok, false, `${host} must be refused`)
    if (!result.ok) assert.equal(result.code, "CLOUD_METADATA")
  }
})

test("non-http schemes are refused", () => {
  for (const host of ["file:///etc/passwd", "gopher://x:8006", "dict://x:8006", "ftp://x:8006"]) {
    const result = validateProxmoxHost(host)
    assert.equal(result.ok, false, `${host} must be refused`)
    if (!result.ok) assert.equal(result.code, "UNSUPPORTED_SCHEME")
  }
})

test("credentials embedded in the URL are refused", () => {
  const result = validateProxmoxHost("https://user:pass@pve.example.com:8006")
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, "EMBEDDED_CREDENTIALS")
    // The message must explain the problem without echoing the supplied secret.
    assert.match(result.reason, /Remove the username and password/i)
    assert.equal(result.reason.includes("user:pass@"), false, "the URL must not be echoed back verbatim")
  }
})

test("an unexpected port is refused rather than silently attempted", () => {
  const result = validateProxmoxHost("pve.example.com:22")
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "INVALID_PORT")
  assert.equal(validateProxmoxHost("pve.example.com:8006").ok, true)
})

test("an empty or unparseable host is refused", () => {
  assert.equal(validateProxmoxHost("").ok, false)
  assert.equal(validateProxmoxHost("   ").ok, false)
})

test("plaintext http is refused unless explicitly opted into", () => {
  const http = validateProxmoxHost("http://pve.example.com:8006")
  assert.equal(http.ok, true)
  if (!http.ok) return
  assert.equal(assertProxmoxTransportAllowed(http, false).allowed, false)
  const refusal = assertProxmoxTransportAllowed(http, false)
  assert.equal(refusal.allowed, false)
  if (!refusal.allowed) assert.match(refusal.reason, /clear text/i)
  // Explicit opt-in is honoured, because an internal node may genuinely be plain.
  assert.equal(assertProxmoxTransportAllowed(http, true).allowed, true)
})

test("https never needs the insecure opt-in", () => {
  const https = validateProxmoxHost("https://pve.example.com:8006")
  assert.equal(https.ok, true)
  if (!https.ok) return
  assert.equal(assertProxmoxTransportAllowed(https, false).allowed, true)
})

test("no Proxmox call follows a redirect to an attacker-chosen destination", () => {
  // A 3xx from a Proxmox host to 169.254.169.254 must be reported, not followed:
  // otherwise the one path that follows redirects is also the path that can send
  // an Authorization header to a cloud metadata address.
  const source = read("lib/proxmox.ts")

  // node:https (the transport used by request/proxmoxRequest) never follows
  // redirects, which is why those call sites need nothing.
  assert.equal(/redirect\s*:\s*["']follow["']/.test(source), false, "no request may be configured to follow redirects")
  assert.equal(/maxRedirects/.test(source), false, "no redirect limit configured")

  // fetch() follows redirects by default, so every fetch call site must opt out.
  const fetchCalls = source.match(/fetch\([\s\S]{0,900}?\n\s*\}\s*(as RequestInit)?\)/g) || []
  assert.ok(fetchCalls.length > 0, "sanity: at least one fetch call site exists")
  for (const call of fetchCalls) {
    assert.match(
      call,
      /redirect\s*:\s*["']manual["']/,
      `every fetch() to Proxmox must set redirect: "manual" — found one that does not:\n${call.slice(0, 300)}`
    )
  }
})

test("the discovery route reports which fields are actually missing", () => {
  // Regression: `x && "name"` yields "" when x is absent, so filtering the
  // falsy entries produced "Missing required fields: , , ." — a 400 that named
  // nothing the caller could act on.
  const source = read("app/api/admin/proxmox-nodes/discover/route.ts")
  assert.equal(
    /missing\s*=\s*\[[^\]]*&&\s*"/.test(source),
    false,
    "must not build the missing list with `x && \"name\"`, which discards the names"
  )
  assert.match(source, /Missing required fields: \$\{missing\.join\(", "\)\}/)
})