/**
 * Validate a Proxmox base URL before the panel makes a request to it.
 *
 * ## Why this is not the generic SSRF guard
 *
 * The panel's general input scanner (`lib/security/input.ts`) flags private
 * ranges as an SSRF signal. That rule is right for a *user-supplied webhook* and
 * wrong here: a Proxmox node is, by definition, the customer's own hypervisor.
 * In this deployment it is reached at `172.18.0.1:8006` from a container and
 * resolves to a private address. Blocking `172.16/12` would block the only thing
 * this feature is for.
 *
 * So the risk being managed is not "an admin configured an internal host" — that
 * is the intended use. It is the panel becoming a request forwarder to somewhere
 * it should never go. Four things are refused outright:
 *
 * - **Cloud metadata.** `169.254.169.254` and friends hand out cloud instance
 *   credentials to anything that asks. A Proxmox host is never that, and
 *   following a redirect into it would be a credential theft.
 * - **Non-HTTP schemes.** `file:`, `gopher:` and friends turn the connection
 *   code into something it was not written for.
 * - **Embedded credentials.** `https://user:pass@host` would put a secret in the
 *   URL, and therefore in logs and error messages.
 * - **Redirects.** A host that answers 302 to `169.254.169.254` would otherwise
 *   reach the metadata service. The client follows no redirects.
 *
 * Everything else is the administrator's decision to make about their own
 * infrastructure, and is allowed through with a bounded timeout.
 */

import net from "node:net"

/** Address ranges that must never be reachable through a Proxmox host URL. */
const CLOUD_METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
])

const CLOUD_METADATA_HOSTNAMES = [
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
  "metadata.azure.com",
]

export type ProxmoxHostValidation =
  | { ok: true; url: URL; host: string; hostname: string; port: number; secure: boolean }
  | { ok: false; reason: string; code: ProxmoxHostRejection }

export type ProxmoxHostRejection =
  | "EMPTY"
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "EMBEDDED_CREDENTIALS"
  | "CLOUD_METADATA"
  | "INVALID_PORT"
  | "MALFORMED_HOST"

/** Ports Proxmox is ever reached on, plus the usual alternatives. */
const ALLOWED_PORTS = new Set([8006, 443, 80, 8443, 9443, 8080, 8081])

function isIpLiteral(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0
}

/**
 * Check a Proxmox base URL.
 *
 * Returns a normalised `URL` on success so the caller never re-parses a string
 * that has already been checked. The scheme default is https, and `http` is
 * accepted only with an explicit opt-in handled by the caller — see
 * `assertProxmoxTransportAllowed`.
 */
export function validateProxmoxHost(raw: string): ProxmoxHostValidation {
  const input = String(raw ?? "").trim().replace(/^["']|["']$/g, "")
  if (!input) return { ok: false, reason: "A Proxmox API URL is required.", code: "EMPTY" }

  // An explicit scheme is required to be deliberate; a bare host is assumed
  // https, which is what Proxmox serves.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: "That is not a URL the panel can parse.", code: "INVALID_URL" }
  }

  const scheme = url.protocol.replace(":", "").toLowerCase()
  if (!["http", "https"].includes(scheme)) {
    return {
      ok: false,
      reason: `Proxmox must be reached over http or https; "${scheme}:" is not supported.`,
      code: "UNSUPPORTED_SCHEME",
    }
  }

  if (url.username || url.password) {
    return {
      ok: false,
      reason: "Remove the username and password from the URL. Proxmox authentication uses an API token, sent in a header.",
      code: "EMBEDDED_CREDENTIALS",
    }
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!hostname) {
    return { ok: false, reason: "That URL has no hostname.", code: "MALFORMED_HOST" }
  }

  if (CLOUD_METADATA_ADDRESSES.has(hostname) || CLOUD_METADATA_HOSTNAMES.some((name) => hostname === name || hostname.endsWith(`.${name}`))) {
    return {
      ok: false,
      reason: "That address is a cloud instance metadata service, not a Proxmox host. The panel will not send requests to it.",
      code: "CLOUD_METADATA",
    }
  }

  const port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !ALLOWED_PORTS.has(port)) {
    return {
      ok: false,
      reason: `Port ${url.port || "default"} is not one this panel will connect to. Use the Proxmox API port (8006) or a reverse proxy port.`,
      code: "INVALID_PORT",
    }
  }

  // A bare hostname must look like a hostname, not an attempt at something else.
  if (!isIpLiteral(hostname) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    return { ok: false, reason: `"${hostname}" is not a valid hostname.`, code: "MALFORMED_HOST" }
  }

  return {
    ok: true,
    url,
    host: `${url.protocol}//${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`,
    hostname,
    port,
    secure: scheme === "https",
  }
}

/**
 * Whether plaintext HTTP is acceptable for this connection.
 *
 * Always true for an https URL. For http it requires an explicit opt-in, because
 * an API token travelling in an Authorization header over plaintext is readable
 * by anything on the path.
 */
export function assertProxmoxTransportAllowed(validation: ProxmoxHostValidation, allowInsecureTls: boolean): { allowed: true } | { allowed: false; reason: string } {
  if (validation.ok && validation.secure) return { allowed: true }
  if (allowInsecureTls) return { allowed: true }
  return {
    allowed: false,
    reason:
      "This URL is http, which would send the API token in clear text. Use https, or explicitly enable the insecure-TLS option for this node if you accept that risk.",
  }
}