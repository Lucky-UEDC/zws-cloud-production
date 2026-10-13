import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

import { extractClientIp, isSharedEgressIp } from "@/lib/request-context"

/**
 * Client IP resolution decides who gets rate limited, who gets throttled on
 * login, and who an IP block applies to. If that value can be forged, every one
 * of those controls is optional for an attacker.
 *
 * The order is deliberate: `x-real-ip` first (the proxy overwrites it), the
 * Cloudflare header only as a fallback.
 */

function headers(input: Record<string, string>): Request {
  return new Request("http://127.0.0.1/", { headers: input })
}

describe("client IP cannot be forged by request headers", () => {
  it("ignores a forged CF-Connecting-IP when the proxy has supplied X-Real-IP", () => {
    const request = headers({
      "x-real-ip": "203.0.113.10",
      "cf-connecting-ip": "198.51.100.99",
    })
    assert.equal(
      extractClientIp(request),
      "203.0.113.10",
      "an attacker must not be able to choose their identity with a header",
    )
  })

  it("keeps working when only the Cloudflare header is present", () => {
    // A deployment that terminates elsewhere still gets a usable address.
    assert.equal(extractClientIp(headers({ "cf-connecting-ip": "198.51.100.99" })), "198.51.100.99")
  })

  it("prefers X-Real-IP over X-Forwarded-For", () => {
    const request = headers({
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.5, 10.0.0.1",
    })
    assert.equal(extractClientIp(request), "203.0.113.10")
  })

  it("never returns a private or reserved address", () => {
    for (const value of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.4.4", "0.0.0.0", "::1"]) {
      assert.equal(extractClientIp(headers({ "x-real-ip": value })), "unknown", `${value} must not be an identity`)
      assert.equal(extractClientIp(headers({ "cf-connecting-ip": value })), "unknown")
      assert.equal(extractClientIp(headers({ "x-forwarded-for": value })), "unknown")
    }
  })

  it("rejects malformed addresses rather than passing them through", () => {
    assert.equal(extractClientIp(headers({ "x-real-ip": "not-an-ip" })), "unknown")
    assert.equal(extractClientIp(headers({ "cf-connecting-ip": "../../etc/passwd" })), "unknown")
    assert.equal(extractClientIp(headers({ "x-real-ip": "999.999.999.999" })), "unknown")
  })

  it("skips a private first entry in X-Forwarded-For and takes the public one", () => {
    assert.equal(extractClientIp(headers({ "x-forwarded-for": "10.0.0.7, 203.0.113.20" })), "203.0.113.20")
  })

  it("falls back to unknown rather than grouping everyone under one identity", () => {
    // If this ever returned a constant, every unidentified visitor would share
    // one rate-limit bucket - exactly the shared-IP problem.
    assert.equal(extractClientIp(headers({})), "unknown")
  })

  it("strips an IPv4-mapped IPv6 prefix", () => {
    assert.equal(extractClientIp(headers({ "x-real-ip": "::ffff:203.0.113.30" })), "203.0.113.30")
  })

  it("keeps a carrier-grade NAT address usable as an identity", () => {
    // Most Indian mobile customers sit behind CGNAT. Rejecting the address
    // would return "unknown" for all of them and merge them into one bucket.
    assert.equal(extractClientIp(headers({ "x-real-ip": "100.86.12.4" })), "100.86.12.4")
    assert.equal(isSharedEgressIp("100.86.12.4"), true)
    assert.equal(isSharedEgressIp("100.127.255.254"), true)
    assert.equal(isSharedEgressIp("100.63.255.255"), false, "100.64.0.0/10 starts at .64")
    assert.equal(isSharedEgressIp("203.0.113.10"), false)
  })
})

describe("the proxy is configured so the app cannot be fooled", () => {
  const nginx = readFileSync("config/nginx/docker.conf", "utf8")

  it("restores the real client IP from Cloudflare", () => {
    assert.match(nginx, /real_ip_header\s+CF-Connecting-IP;/)
    assert.match(nginx, /real_ip_recursive\s+on;/)
    // Restoration must be scoped to Cloudflare's ranges, or any client could
    // set the header and have nginx believe it.
    const trusted = nginx.match(/set_real_ip_from\s+[^;]+;/g) || []
    assert.ok(trusted.length >= 15, `expected Cloudflare's published ranges, found ${trusted.length}`)
    assert.ok(trusted.some((line) => line.includes("104.16.0.0/13")))
    assert.ok(trusted.some((line) => line.includes("2a06:98c0::/29")))
  })

  it("strips CF-Connecting-IP before proxying to the app", () => {
    const stripped = nginx.match(/proxy_set_header\s+CF-Connecting-IP\s+"";/g) || []
    const proxied = nginx.match(/proxy_set_header\s+Host\s+\$host;/g) || []
    assert.ok(stripped.length > 0, "the forgeable header must be cleared, not forwarded")
    assert.equal(
      stripped.length,
      proxied.length,
      "every proxy_pass block that forwards to the app must clear the header",
    )
  })

  it("always sets X-Real-IP on every block that forwards to the app", () => {
    const withHost = (nginx.match(/proxy_set_header\s+Host\s+\$host;/g) || []).length
    const withRealIp = (nginx.match(/proxy_set_header\s+X-Real-IP\s+\$remote_addr;/g) || []).length
    assert.equal(withRealIp, withHost, "X-Real-IP must be set wherever Host is")
  })

  it("keeps rate-limit zones keyed on the restored address", () => {
    // limit_req_zone uses $binary_remote_addr, which real_ip module rewrites, so
    // these inherit the fix rather than needing separate configuration.
    assert.match(nginx, /limit_req_zone\s+\$binary_remote_addr/)
  })
})