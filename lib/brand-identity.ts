/**
 * Brand identity, resolved from configuration.
 *
 * The panel has one authoritative source for who it is: `getBrandSettings()`,
 * which resolves platform brand -> general brand -> company name -> app name,
 * plus the configured public domain.
 *
 * Eleven notification send paths each did their own `getBrandName().catch(() =>
 * "Cloud")`. That fallback is a hardcoded product fragment, and it is what a
 * customer sees signed at the bottom of an OTP, an invoice notice or a
 * suspension warning whenever the settings read fails. This is the single
 * fallback every path uses instead.
 *
 * The last resort is the configured domain, which is always present in a real
 * deployment and is at least an honest name for the operator. Only if even that
 * is missing do we use the panel's own default.
 */

import { getBrandName } from "@/lib/settings/site-settings"
import { configuredSiteDomain } from "@/lib/public-url"

const PANEL_FALLBACK = "ZWS Cloud"

/** `cloud.example.com` -> `cloud`. Never returns a bare TLD. */
export function brandNameFromDomain(domain: string | null | undefined): string {
  const host = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0]
  if (!host) return ""
  // Strip a leading "www." so the brand is not "www".
  const withoutWww = host.replace(/^www\./, "")
  const label = withoutWww.split(".")[0] || ""
  return label.length >= 2 ? label : withoutWww
}

/**
 * Resolve the brand name to sign customer messages with.
 *
 * Accepts an override so a caller that already knows the brand (e.g. it read it
 * earlier in the same request) does not pay for a second settings read.
 */
export async function resolveBrandIdentity(override?: string | null): Promise<string> {
  const explicit = String(override || "").trim()
  if (explicit) return explicit
  const configured = await getBrandName()
    .then((name) => String(name || "").trim())
    .catch(() => "")

  // "Cloud" was the old hardcoded fallback in eleven notification paths. It
  // is not a configured brand and must never win over the actual public domain.
  // Treat it as unresolved so production falls through to the configured domain.
  const usableConfigured = configured && configured.toLowerCase() !== "cloud" ? configured : ""
  if (usableConfigured) return usableConfigured

  const fromDomain = brandNameFromDomain(configuredSiteDomain())
  return fromDomain || PANEL_FALLBACK
}