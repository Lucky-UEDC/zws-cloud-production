#!/usr/bin/env tsx
/**
 * Verify the panel's permission matrix against the running Proxmox's own API
 * schema.
 *
 * ## Why this exists
 *
 * `lib/proxmox/permission-requirements.ts` tells an administrator which
 * privilege is missing when Proxmox answers a 403. That advice is only worth
 * anything if it is what Proxmox actually evaluates. Proxmox publishes its
 * complete API schema — including the ACL check for every operation — at
 * `/pve-docs/api-viewer/apidoc.js`, so the claim is checkable rather than a
 * matter of trust.
 *
 * A Proxmox upgrade that changes an endpoint's required privilege is exactly the
 * event that turns this file into a source of confident wrong answers. This
 * script catches it.
 *
 * ## Usage
 *
 *   pnpm verify:proxmox:permissions -- --host pve.example.com:8006
 *   pnpm verify:proxmox:permissions -- --host pve:8006 --insecure
 *   pnpm verify:proxmox:permissions -- --host pve:8006 --from-file ./apidoc.js
 *
 * Read-only: it fetches a static documentation file and compares it. It sends no
 * API token and changes nothing on the Proxmox host.
 */

import fs from "node:fs"
import https from "node:https"
import { normalizeProxmoxHost } from "../lib/proxmox"
import { PROXMOX_ENDPOINT_PERMISSIONS, type ProxmoxAclRequirement } from "../lib/proxmox/permission-requirements"

type Argv = { host: string; insecure: boolean; fromFile: string | null; timeoutMs: number }

function parseArgs(argv: string[]): Argv {
  const out: Argv = { host: "", insecure: false, fromFile: null, timeoutMs: 20000 }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === "--host" && next) { out.host = next; i += 1 }
    else if (token === "--insecure") out.insecure = true
    else if (token === "--from-file" && next) { out.fromFile = next; i += 1 }
    else if (token === "--timeout-ms" && next) { out.timeoutMs = Number(next) || out.timeoutMs; i += 1 }
  }
  return out
}

function fetchApiSchema(host: string, insecure: boolean, timeoutMs: number): Promise<string> {
  const url = `${normalizeProxmoxHost(host)}/pve-docs/api-viewer/apidoc.js`
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: !insecure, timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`GET ${url} answered HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`)))
    req.on("error", reject)
  })
}

/**
 * Parse `const apiSchema = [...]` out of the viewer script.
 *
 * The file is JavaScript, not JSON, and it carries statements after the array,
 * so the closing bracket is found by scanning for the one that matches the
 * opening bracket rather than by taking the last `]` in the file.
 */
export function extractApiSchema(source: string): any {
  const start = source.indexOf("[")
  if (start < 0) throw new Error("No array literal found in the API viewer script")
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "[") depth += 1
    else if (ch === "]") {
      depth -= 1
      if (depth === 0) return JSON.parse(source.slice(start, i + 1))
    }
  }
  throw new Error("Unbalanced array literal in the API viewer script")
}

type SchemaOp = { path: string; method: string; permissions: any }

/** Flatten the schema tree into `{METHOD, path} -> permissions` entries. */
export function flattenApiSchema(schema: any[]): SchemaOp[] {
  const out: SchemaOp[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return
    // Proxmox's viewer repeats the full path on every node, not a path segment.
    const path = typeof node.path === "string" ? node.path : ""
    if (node.info && typeof node.info === "object") {
      for (const [method, info] of Object.entries<any>(node.info)) {
        out.push({ path, method: String(method).toUpperCase(), permissions: info?.permissions })
      }
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  for (const entry of schema) walk(entry)
  return out
}

/** Render the panel's expectation in the same shape the schema reports. */
export function expectedPermissions(requirement: ProxmoxAclRequirement): { privilege: string | null; alternatives: string[]; aclPath: string | null; alsoRequires: Array<{ privilege: string; aclPath: string }> } {
  return {
    privilege: requirement.privilege,
    alternatives: requirement.alternatives ?? [],
    aclPath: requirement.aclPath ?? null,
    alsoRequires: requirement.alsoRequires ?? [],
  }
}

/** Collect every `{aclPath, privileges}` clause reachable inside a check tree. */
function collectCheckClauses(check: any, out: Array<{ aclPath: string | null; privileges: string[]; anyOf: boolean }> = []) {
  if (!Array.isArray(check)) return out
  if (check[0] === "perm" && Array.isArray(check[2])) {
    out.push({ aclPath: typeof check[1] === "string" ? check[1] : null, privileges: check[2].map(String), anyOf: check[3] === "any" })
    return out
  }
  for (const clause of check.slice(1)) {
    if (Array.isArray(clause)) collectCheckClauses(clause, out)
  }
  return out
}

type Mismatch = { requirement: ProxmoxAclRequirement; actual: any; reason: string }

/**
 * Compare the panel's matrix with what Proxmox reports.
 *
 * An endpoint absent from the schema is a mismatch, not a pass: if Proxmox
 * renamed or removed it, the panel is calling something that no longer exists.
 */
export function compareAgainstSchema(requirements: ProxmoxAclRequirement[], ops: SchemaOp[]): { mismatches: Mismatch[]; checked: number } {
  const index = new Map<string, any>()
  for (const op of ops) index.set(`${op.method} ${op.path}`, op.permissions)

  const mismatches: Mismatch[] = []
  let checked = 0

  for (const requirement of requirements) {
    const actual = index.get(`${requirement.method} ${requirement.path}`)
    checked += 1
    if (actual === undefined) {
      mismatches.push({ requirement, actual, reason: "endpoint is not present in this Proxmox's API schema" })
      continue
    }

    // Proxmox spells "any authenticated user" as {user: "all"}.
    const isUserAll = actual && typeof actual === "object" && actual.user === "all"
    const check = actual?.check

    if (isUserAll) {
      if (requirement.privilege) {
        mismatches.push({ requirement, actual, reason: "panel expects a privilege but Proxmox applies no ACL check to this endpoint" })
      }
      continue
    }

    if (!Array.isArray(check)) {
      mismatches.push({ requirement, actual, reason: `unexpected permission shape: ${JSON.stringify(actual)}` })
      continue
    }

    const expected = expectedPermissions(requirement)
    const expectedPrivileges = expected.privilege ? [expected.privilege] : expected.alternatives

    if (!expectedPrivileges.length) {
      mismatches.push({ requirement, actual, reason: `panel records no privilege but Proxmox requires ${JSON.stringify(check)}` })
      continue
    }

    // Composite `or`/`and` checks have to be matched clause-wise: the primary
    // clause, any alternative scope for it, and every `and` half. Indexing the
    // raw tree by position cannot express that.
    const clauses = collectCheckClauses(check)
    const primary = clauses.find((clause) => clause.aclPath === expected.aclPath)
    if (!primary) {
      mismatches.push({ requirement, actual, reason: `no clause at ${expected.aclPath}; Proxmox clauses are ${clauses.map((c) => `${c.aclPath}:${c.privileges.join("|")}`).join(", ")}` })
      continue
    }

    const missingPrimary = expectedPrivileges.filter((privilege) => !primary.privileges.includes(privilege))
    if (missingPrimary.length) {
      mismatches.push({ requirement, actual, reason: `privilege(s) ${missingPrimary.join(", ")} not among Proxmox's ${primary.privileges.join(", ")}` })
      continue
    }
    if (primary.anyOf !== (expected.alternatives.length > 1)) {
      mismatches.push({ requirement, actual, reason: `any-of semantics differ: panel anyOf=${expected.alternatives.length > 1}, Proxmox anyOf=${primary.anyOf}` })
      continue
    }
    for (const alternative of requirement.alternativeAclPaths ?? []) {
      if (!clauses.some((clause) => clause.aclPath === alternative && clause.privileges.includes(String(expected.privilege)))) {
        mismatches.push({ requirement, actual, reason: `panel claims ${expected.privilege} is also accepted on ${alternative}, but Proxmox has no such clause` })
      }
    }
    for (const also of expected.alsoRequires) {
      const found = clauses.some((clause) => clause.aclPath === also.aclPath && clause.privileges.includes(also.privilege))
      if (!found) {
        mismatches.push({ requirement, actual, reason: `panel claims ${also.privilege} on ${also.aclPath} is also required, but Proxmox does not check it` })
      }
    }
  }

  return { mismatches, checked }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.host && !args.fromFile) {
    console.error("Usage: pnpm verify:proxmox:permissions -- --host <host:port> [--insecure] [--from-file ./apidoc.js]")
    process.exit(2)
  }

  const source = args.fromFile ? fs.readFileSync(args.fromFile, "utf8") : await fetchApiSchema(args.host, args.insecure, args.timeoutMs)
  const ops = flattenApiSchema(extractApiSchema(source))
  const { mismatches, checked } = compareAgainstSchema(PROXMOX_ENDPOINT_PERMISSIONS, ops)

  console.log(`Checked ${checked} endpoint(s) against ${ops.length} operations in the Proxmox API schema.`)
  if (!mismatches.length) {
    console.log("Every permission the panel reports matches what this Proxmox actually evaluates.")
    return
  }
  console.error(`\n${mismatches.length} mismatch(es):\n`)
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch.requirement.method} ${mismatch.requirement.path}`)
    console.error(`    reason: ${mismatch.reason}`)
    console.error(`    proxmox: ${JSON.stringify(mismatch.actual)}`)
  }
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.message || error))
    process.exit(1)
  })
}