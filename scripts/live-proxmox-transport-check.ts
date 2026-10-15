/**
 * Live transport check against a real Proxmox host.
 *
 * Uses a deliberately invalid token, so the only thing this can establish is
 * that the request reached Proxmox and Proxmox rejected it — which is exactly the
 * question that matters for the TLS finding. It creates nothing, changes nothing,
 * and is not a credential test.
 *
 * Usage: npx tsx scripts/live-proxmox-transport-check.ts <host:port>
 */

import { runProxmoxDiagnostics } from "../lib/proxmox"

async function main() {
  const host = process.argv[2]
  if (!host) {
    console.error("Usage: npx tsx scripts/live-proxmox-transport-check.ts <host:port>")
    process.exit(2)
  }

  console.log(`Probing ${host} with an intentionally invalid token.\n`)

  // allowInsecureTls is false and stays false: this is the point of the check.
  const result = await runProxmoxDiagnostics({
    host,
    nodeName: "transport-check",
    tokenId: "transport-check@pve!invalid",
    tokenSecret: "invalid-secret-for-transport-check",
    allowInsecureTls: false,
    timeoutMs: 15000,
  })

  for (const step of result.steps) {
    const mark = step.ok ? "PASS" : "FAIL"
    console.log(`  [${mark}] ${step.name}${step.code !== "OK" ? ` — ${step.code}` : ""}`)
    console.log(`         ${step.message}`)
  }

  console.log("")
  const dns = result.steps.find((step) => step.name === "DNS resolve host")
  const tcp = result.steps.find((step) => step.name.startsWith("TCP connect"))
  const tls = result.steps.find((step) => step.name === "TLS handshake")
  const version = result.steps.find((step) => step.name.includes("/api2/json/version"))

  console.log(`DNS resolved          : ${dns?.ok ? dns?.addresses?.join(", ") : "no"}`)
  console.log(`TCP connect           : ${tcp?.ok ? "yes" : "no"}`)
  console.log(`TLS certificate valid : ${tls?.ok ? `yes${String(tls.message).includes("verification disabled") ? " (verification was DISABLED)" : " (verified against the system trust store)"}` : "no"}`)
  console.log(`API answered          : ${version?.ok ? "yes" : `no (${version?.code})`}`)
  console.log(`Expected outcome      : API answered "no" with AUTH_FAILED_401 — that is a rejected token, not a transport failure.`)
  console.log("")
  console.log(`Verdict: ${tls?.ok && dns?.ok && tcp?.ok && version?.code === "AUTH_FAILED_401" ? "TRANSPORT OK — TLS verification is working and the token was correctly rejected" : "TRANSPORT PROBLEM — see the steps above"}`)
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exit(1)
})