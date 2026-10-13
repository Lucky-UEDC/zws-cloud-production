import { isIP } from "node:net"
import { UAParser } from "ua-parser-js"
import { resolveLocation } from "@/lib/geo/resolve-location"

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  // "This network" (0.0.0.0/8) and "unspecified". Neither identifies a client.
  // Letting 0.0.0.0 through would collapse every such request onto one
  // identity, which is the shared-IP failure this list exists to prevent.
  /^0\./,
  /^::$/,
  // Multicast and broadcast.
  /^224\./,
  /^239\./,
  /^255\./,
  // IPv6 loopback, unspecified, link-local and unique-local.
  /^::1$/,
  /^fe[89ab]/i,
  /^f[cd]/i,
]

/**
 * Carrier-grade NAT space (100.64.0.0/10) is deliberately NOT excluded.
 *
 * Most Indian mobile and broadband customers sit behind CGNAT, so their "IP" is
 * shared with thousands of strangers. Dropping it would return "unknown" for
 * most of them and merge the entire internet into a single rate-limit bucket,
 * which is strictly worse than a coarse identity.
 *
 * Instead the coarse address is treated as the weakest possible identity: the
 * risk engine keys on session, then device, then IP, so a signed-in customer
 * behind CGNAT accumulates their own score and is never blocked because of
 * somebody else sharing the same pool.
 */
const SHARED_EGRESS_IP_RANGES = [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]

/** True when the address is a carrier-grade NAT pool shared by many customers. */
export function isSharedEgressIp(value: string): boolean {
  return SHARED_EGRESS_IP_RANGES.some((pattern) => pattern.test(String(value || "")))
}

type HeaderReader = Pick<Headers, "get">

function firstHeader(headers: HeaderReader, name: string) {
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || ""
}

function cleanIp(value: string | null | undefined) {
  const candidate = String(value || "").split(",")[0]?.trim().replace(/^::ffff:/, "") || ""
  return isIP(candidate) ? candidate : ""
}

function publicForwardedIp(value: string | null | undefined) {
  for (const part of String(value || "").split(",")) {
    const candidate = part.trim().replace(/^::ffff:/, "")
    if (isIP(candidate) && publicIp(candidate)) return candidate
  }
  return ""
}

function publicIp(value: string) {
  if (!value) return ""
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(value)) ? "" : value
}

/**
 * Resolves the client IP.
 *
 * Order matters and is a security property, not a preference.
 *
 * `x-real-ip` comes first because the reverse proxy overwrites it with the
 * socket address it actually saw. That address has Cloudflare's real-IP
 * restoration already applied, so it is the true client whether or not traffic
 * is proxied.
 *
 * `cf-connecting-ip` is a fallback only. It used to be checked first, and
 * nothing in front of the app was setting it, which meant any client could
 * forge their own IP by sending that header - defeating rate limits, login
 * throttles and every IP-based block. The proxy now consumes the header and
 * strips it before it reaches the app, so this branch is a belt-and-braces
 * fallback for deployments that terminate differently.
 *
 * Private and reserved addresses are never returned, so a forged or proxied
 * local address cannot make unrelated traffic share one identity.
 */
export function extractClientIp(headersOrRequest: HeaderReader | Request) {
  const headers = "headers" in headersOrRequest ? headersOrRequest.headers : headersOrRequest
  return (
    publicIp(cleanIp(firstHeader(headers, "x-real-ip"))) ||
    publicForwardedIp(firstHeader(headers, "x-forwarded-for")) ||
    publicIp(cleanIp(firstHeader(headers, "cf-connecting-ip"))) ||
    cleanIp((headersOrRequest as any).ip) ||
    "unknown"
  )
}

async function lookupIpIntel(ip: string) {
  if (!ip || ip === "unknown" || PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip))) return null
  const token = process.env.IPINFO_TOKEN
  const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${encodeURIComponent(token)}` : ""}`
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

export async function getRequestContext(request: Request) {
  const ip = extractClientIp(request)
  const userAgent = request.headers.get("user-agent") || ""
  const parsed = new UAParser(userAgent).getResult()
  const [location, intel] = await Promise.all([
    resolveLocation(request.headers).catch(() => null),
    lookupIpIntel(ip).catch(() => null),
  ])
  const org = String(intel?.org || "")
  const privacy = intel?.privacy || {}
  const browser = parsed.browser.name || "Unknown browser"
  const os = parsed.os.name || "Unknown OS"
  const deviceType = parsed.device.type || (/(mobile|android|iphone)/i.test(userAgent) ? "mobile" : "desktop")
  const device = `${browser} on ${os}`
  const provider = org || null
  const proxy = Boolean(privacy?.vpn || privacy?.proxy || privacy?.tor || privacy?.relay || /hosting|cloud|digitalocean|amazon|google|microsoft|ovh|hetzner/i.test(org))

  return {
    ip,
    country: location?.countryCode || intel?.country || null,
    countryName: location?.country || null,
    region: location?.state || intel?.region || null,
    city: location?.city || intel?.city || null,
    timezone: location?.timezone || intel?.timezone || null,
    asn: org.split(" ")[0] || null,
    provider,
    proxy,
    vpn: Boolean(privacy?.vpn),
    tor: Boolean(privacy?.tor),
    relay: Boolean(privacy?.relay),
    browser,
    browserVersion: parsed.browser.version || null,
    os,
    osVersion: parsed.os.version || null,
    device,
    deviceType,
    platform: parsed.device.vendor || parsed.cpu.architecture || deviceType,
    cpuArchitecture: parsed.cpu.architecture || null,
    userAgent,
    geoSource: location?.source || (intel ? "ip" : "default"),
  }
}
