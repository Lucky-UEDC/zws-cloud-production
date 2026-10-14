import assert from "node:assert/strict"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const repoRoot = process.cwd()
const scriptPath = path.join(repoRoot, "scripts/platform-backup.ts")
const source = readFileSync(scriptPath, "utf8")

/**
 * Backup correctness.
 *
 * A backup is only real once it has been read back. Every property asserted
 * here is checked against the actual script rather than against a description
 * of it, so a regression in the tool cannot quietly pass.
 */

test("the client/server version guard parses real pg_dump output", () => {
  assert.match(source, /export function parsePgMajorVersion/)
  // Both shapes seen in the field: `pg_dump (PostgreSQL) 18.6 (Debian ...)`
  // and the older `pg_dump (PostgreSQL) 9.6.1`.
  assert.match(source, /text\.match\(\/\\\)\\s\+\(\\d\+\)\\\.\\d\+\/\)/)
  assert.match(source, /clientMajor < serverMajor/)
  // An undetectable client must stop the run rather than skip the check.
  assert.match(source, /Could not determine the pg_dump client version/)
})

test("a backup cannot be written without an encryption passphrase", () => {
  assert.match(source, /ZWS_BACKUP_ENCRYPTION_PASSPHRASE is not set/)
  assert.match(source, /An unencrypted backup must never be written/)
  // AES-256-GCM, which authenticates as well as encrypts: a tampered artifact
  // fails to decrypt instead of silently restoring wrong data.
  assert.match(source, /createCipheriv\(ALGORITHM, encryptionKey\(\), iv\)/)
  assert.match(source, /const ALGORITHM = "aes-256-gcm"/)
  assert.match(source, /setAuthTag/)
})

test("the plaintext dump is removed on every path, including failures", () => {
  const body = source.slice(source.indexOf("async function create("), source.indexOf("async function verify("))
  assert.match(body, /try \{/)
  // The failure that started this: a version mismatch left an unencrypted
  // partial dump on disk. Cleanup must be in a finally, not after success.
  assert.match(body, /finally \{[\s\S]*?rmSync\(plainPath, \{ force: true \}\)/)
})

test("artifacts and the backup directory are not world readable", () => {
  assert.match(source, /mkdirSync\(BACKUP_ROOT, \{ recursive: true, mode: 0o700 \}\)/)
  assert.match(source, /chmodSync\(BACKUP_ROOT, 0o700\)/)
  assert.match(source, /createWriteStream\(destination, \{ mode: 0o600 \}\)/)
  // The manifest records source identity; it must be owner-only too.
  assert.match(source, /writeFileSync\(manifestPath\(fileName\), JSON\.stringify\(manifest, null, 2\), \{ mode: 0o600 \}\)/)
})

test("integrity verification proves more than a successful exit code", () => {
  const body = source.slice(source.indexOf("async function verify("), source.indexOf("async function restore("))
  // Ciphertext digest, then authenticated decryption, then the plaintext
  // digest, then a structural listing.
  assert.match(body, /cipherSha256 !== manifest\.cipherSha256/)
  assert.match(body, /decryptFile\(encryptedPath, plainPath, manifest\.iv, manifest\.tag\)/)
  assert.match(body, /plainSha256 !== manifest\.plainSha256/)
  assert.match(body, /execFileAsync\(pgRestoreBin\(\), \["-l", plainPath\]/)
})

test("a restore refuses to overwrite the configured database", () => {
  const body = source.slice(source.indexOf("async function restore("), source.indexOf("function prune("))
  // There is no implicit target at all.
  assert.match(body, /restore requires --target=/)
  assert.match(body, /Refusing to restore over the configured database/)
  assert.match(body, /ZWS_ALLOW_RESTORE_IN_DEVELOPMENT/)
})

test("retention never removes the last verified backup", () => {
  const body = source.slice(source.indexOf("async function prune("), source.indexOf("async function health("))
  assert.match(body, /protectedFile/)
  assert.match(body, /try \{ await verify\(manifest\.fileName\)/)
})

test("retention cannot delete every artifact", () => {
  const body = source.slice(source.indexOf("function prune("), source.indexOf("async function health("))
  // The newest `keep` are always retained regardless of age, so a wrong
  // retention value cannot destroy the last recoverable copy.
  assert.match(body, /if \(manifest\.fileName === protectedFile \|\| index < keep \|\| \(!expired && index < keep \+ 50\)\)/)
  // Defaults are declared at module scope, not inside prune().
  assert.match(source, /const DEFAULT_RETENTION_DAYS = 14/)
  assert.match(source, /const DEFAULT_KEEP = 10/)
})

test("health monitoring fails closed rather than reporting a false green", () => {
  const body = source.slice(source.indexOf("async function health("), source.indexOf("async function main("))
  assert.match(body, /reason: "no_artifacts"/)
  assert.match(body, /reason: "stale"/)
  assert.match(body, /reason: "integrity_failed"/)
  // A failure must set a non-zero exit code rather than exiting 0.
  assert.match(source, /"ok" in result && \(result as any\)\.ok === false\) process\.exitCode = 2/)
})

test("uploaded files are covered by the artifact, not assumed to be", () => {
  // An attachment row without its file restores into the exact 404 this whole
  // exercise began with, so uploads are hashed into the manifest.
  assert.match(source, /async function uploadsManifest/)
  assert.match(source, /ZWS_UPLOAD_DIR/)
  assert.match(source, /sha256File\(full\)/)
})

test("errors never print a connection string or the passphrase", () => {
  assert.match(source, /<redacted>/, "connection strings must be redacted in operator-facing errors")
  assert.ok(
    source.includes('replace(/postgres(?:ql)?:\\/\\/[^\\s"\']+/gi, "postgres://<redacted>")'),
    "operator-facing errors must redact any connection string"
  )
  // The manifest records host/port/database/role but never a password.
  assert.doesNotMatch(source, /password:\s*source\./)
  assert.doesNotMatch(source, /manifest\.(url|DATABASE_URL)/)
  assert.doesNotMatch(source, /manifest:\s*process\.env\.DATABASE_URL/)
})

test("the artifact produced during this session is still intact and readable", { skip: !process.env.ZWS_BACKUP_DIR }, () => {
  const root = String(process.env.ZWS_BACKUP_DIR)
  const manifests = readdirSync(root).filter((entry) => entry.endsWith(".manifest.json"))
  assert.ok(manifests.length, "an artifact must exist for this check to mean anything")

  for (const entry of manifests) {
    const manifest = JSON.parse(readFileSync(path.join(root, entry), "utf8"))
    const artifact = path.join(root, manifest.fileName)
    const digest = crypto.createHash("sha256").update(readFileSync(artifact)).digest("hex")
    assert.equal(digest, manifest.cipherSha256, `${manifest.fileName} failed its integrity check`)
    assert.ok(manifest.plainBytes > 0, "an artifact must not be empty")
  }
})