import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pipeline } from "node:stream/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { describeResolvedDatabaseTarget } from "@/lib/db-isolation"
import { sanitizePostgresUrlForPgDump } from "@/lib/db-url"

const execFileAsync = promisify(execFile)

/**
 * Platform backup and restore.
 *
 * This exists because the application's own backup job had not produced a
 * single artifact in three months while the backup volume sat empty. It is
 * deliberately filesystem-only: `create` reads the database with `pg_dump` and
 * writes an encrypted artifact plus a manifest to disk. It performs no
 * database writes, so it can be used to take a recoverable safety copy before
 * isolation is resolved, without touching the shared database.
 *
 * Encryption is AES-256-GCM with a key derived from
 * `ZWS_BACKUP_ENCRYPTION_PASSPHRASE`. The artifact is unreadable without it.
 *
 *   tsx scripts/platform-backup.ts create
 *   tsx scripts/platform-backup.ts list
 *   tsx scripts/platform-backup.ts verify  [--file=<name>]
 *   tsx scripts/platform-backup.ts restore --target=<url> [--file=<name>]
 *   tsx scripts/platform-backup.ts prune  --keep-days=<n>
 *   tsx scripts/platform-backup.ts health
 *
 * `restore` refuses to target the configured database. Pointing a restore at
 * the working development database is the one mistake that cannot be undone.
 */

const BACKUP_ROOT = String(process.env.ZWS_BACKUP_DIR || "/var/backups/zws").replace(/\/+$/, "")
const MANIFEST_SUFFIX = ".manifest.json"
const ARTIFACT_SUFFIX = ".dump.enc"
const ALGORITHM = "aes-256-gcm"
const DEFAULT_RETENTION_DAYS = 14
const DEFAULT_KEEP = 10

type Manifest = {
  version: 1
  fileName: string
  createdAt: string
  source: { host: string; port: string; database: string; username: string }
  plainBytes: number
  cipherBytes: number
  plainSha256: string
  cipherSha256: string
  algorithm: typeof ALGORITHM
  iv: string
  tag: string
  toolVersion: string
  contents: string[]
  /** Persistent uploads covered by this artifact, with a digest per file. */
  uploads?: { root: string; available: boolean; files: Array<{ path: string; bytes: number; sha256: string }> }
}

/**
 * PostgreSQL client binaries.
 *
 * The container ships a client that may predate the server's major version,
 * which is the outage documented in the issue report. Deployment sets
 * `ZWS_PG_DUMP_BIN` (and the restore counterpart) to the absolute path of
 * the versioned binaries installed beside the application, so multiple clients
 * can coexist without one shadowing the other. Without the override the
 * PATH-resolved binary is used, unchanged from the previous behaviour.
 *
 * The variables are read at call time rather than at module load so that unit
 * tests and preflight scripts can point them at a test double.
 */
function pgDumpBin() { return String(process.env.ZWS_PG_DUMP_BIN || "pg_dump").trim() || "pg_dump" }
function pgRestoreBin() { return String(process.env.ZWS_PG_RESTORE_BIN || "pg_restore").trim() || "pg_restore" }
function psqlBin() { return String(process.env.ZWS_PSQL_BIN || "psql").trim() || "psql" }

function passphrase() {
  const value = String(process.env.ZWS_BACKUP_ENCRYPTION_PASSPHRASE || "").trim()
  if (!value) {
    throw new Error(
      "ZWS_BACKUP_ENCRYPTION_PASSPHRASE is not set. An unencrypted backup must never be written; " +
        "set the passphrase supplied by the administrator before creating artifacts."
    )
  }
  return value
}

function encryptionKey() {
  return crypto.createHash("sha256").update(passphrase()).digest()
}

function lockPath() { return path.join(requireDirectory(), ".platform-backup-running") }
function acquireBackupLock() {
  const file = lockPath()
  try {
    const prior = JSON.parse(fs.readFileSync(file, "utf8"))
    const started = new Date(prior.startedAt).getTime()
    const stale = !prior || !started || Date.now() - started > 2 * 60 * 60 * 1000
    if (!stale) throw new Error(`Another backup is already running (started ${prior.startedAt}, pid ${prior.pid}). Refusing to overlap.`)
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      if (error?.message?.startsWith("Another backup is already running")) throw error
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
}
function releaseBackupLock() {
  fs.rmSync(lockPath(), { force: true })
}

function requireDirectory() {
  if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 })
  // Backups contain customer records: keep them off other local accounts.
  try {
    fs.chmodSync(BACKUP_ROOT, 0o700)
  } catch {
    /* best effort on exotic filesystems */
  }
  return BACKUP_ROOT
}

function artifactPath(fileName: string) {
  return path.join(requireDirectory(), fileName)
}

function manifestPath(fileName: string) {
  return `${artifactPath(fileName)}${MANIFEST_SUFFIX}`
}

function listManifests(): Manifest[] {
  requireDirectory()
  return fs
    .readdirSync(BACKUP_ROOT)
    .filter((entry) => entry.endsWith(MANIFEST_SUFFIX))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(BACKUP_ROOT, entry), "utf8")) as Manifest
      } catch {
        return null
      }
    })
    .filter((entry): entry is Manifest => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

function encryptFile(source: string, destination: string) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv)
  return new Promise<{ iv: string; tag: string }>((resolve, reject) => {
    pipeline(createReadStream(source), cipher, createWriteStream(destination, { mode: 0o600 }))
      .then(() => resolve({ iv: iv.toString("base64"), tag: (cipher as crypto.CipherGCM).getAuthTag().toString("base64") }))
      .catch(reject)
  })
}

function decryptFile(source: string, destination: string, iv: string, tag: string) {
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, "base64"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  return pipeline(createReadStream(source), decipher, createWriteStream(destination, { mode: 0o600 }))
}

function flag(name: string) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || ""
}

/**
 * Refuse to run when the local client is older than the server.
 *
 * `pg_dump` aborts with "server version mismatch" when the client is older
 * than the server, and it does so only after connecting and starting work.
 * That is not the failure that stopped this platform's backups: the container
 * ships pg_dump 15 against a PostgreSQL 18 server, so every attempt died the
 * same way. Checking the pair up front turns an opaque abort into a precise
 * instruction, and makes the mismatch visible to monitoring as `client_too_old`.
 */
/** Parse `pg_dump (PostgreSQL) 18.6 (Debian ...)` and the older `pg_dump 9.6.1`. */
export function parsePgMajorVersion(output: string) {
  const text = String(output || "")
  const modern = text.match(/\)\s+(\d+)\.\d+/)
  if (modern) return Number(modern[1])
  const legacy = text.match(/(\d+)\.\d+/)
  return legacy ? Number(legacy[1]) : 0
}

async function assertClientSupportsServer() {
  const clientRaw = await execFileAsync(pgDumpBin(), ["--version"]).then((result) => String(result.stdout))
  const clientMajor = parsePgMajorVersion(clientRaw)
  if (!clientMajor) {
    // Failing closed: an undetectable client version means the guard cannot do
    // its job, and silently skipping it is what let an incompatible client run.
    throw new Error(
      "Could not determine the pg_dump client version. Refusing to continue, because the client/server " +
        "compatibility check could not be performed."
    )
  }

  const serverMajor = await execFileAsync(
    psqlBin(),
    [sanitizePostgresUrlForPgDump(process.env.DATABASE_URL || ""), "-tAc", "SHOW server_version_num"],
    { maxBuffer: 1024 * 1024 }
  )
    .then((result) => Math.floor(Number(String(result.stdout).trim()) / 10_000))
    .catch(() => 0)

  if (serverMajor && clientMajor < serverMajor) {
    throw new Error(
      `pg_dump client ${clientMajor} is older than the PostgreSQL ${serverMajor} server, so it cannot take a usable dump. ` +
        `Install a matching client (or run pg_dump from a ${serverMajor} client image) and retry. ` +
        `Set ZWS_PG_DUMP_BIN to point at a compatible binary.`
    )
  }
  return { serverMajor, clientMajor }
}

/**
 * Hash every persistent upload, so an artifact can prove that attachment and
 * branding files are covered and not merely assumed to be.
 *
 * The database dump on its own is not a recovery: an attachment row without
 * its file restores to a broken 404, which is exactly the failure this whole
 * exercise started from.
 */
async function uploadsManifest() {
  const root = String(process.env.ZWS_UPLOAD_DIR || "/app/uploads").replace(/\/+$/, "")
  if (!fs.existsSync(root)) return { root, available: false, files: [] as Array<{ path: string; bytes: number; sha256: string }> }
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push({ path: path.relative(root, full), bytes: fs.statSync(full).size, sha256: await sha256File(full) })
    }
  }
  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { root, available: true, files }
}

/**
 * Take a backup. Reads the database; never writes to it.
 */
async function create() {
  const source = describeResolvedDatabaseTarget()
  if (!source.configured) throw new Error("No database is configured, so there is nothing to back up.")
  // Prevent two scheduled runs from writing the same plain path or racing on the
  // encryption key. The process supervision also avoids overlaps, but a hung
  // job or two ad-hoc invocations must not corrupt a critical backup.
  acquireBackupLock()
  const versions = await assertClientSupportsServer()

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `zws-${source.database}-${stamp}${ARTIFACT_SUFFIX}`
  const encryptedPath = artifactPath(fileName)
  const plainPath = path.join(requireDirectory(), `.plain-${stamp}.dump`)

  try {
    await execFileAsync(pgDumpBin(), [sanitizePostgresUrlForPgDump(process.env.DATABASE_URL || ""), "--format=custom", "--compress=6", "--no-owner", "--no-privileges", "-f", plainPath], {
      maxBuffer: 1024 * 1024 * 32,
    })

    const plainSha256 = await sha256File(plainPath)
    const plainBytes = fs.statSync(plainPath).size
    const { iv, tag } = await encryptFile(plainPath, encryptedPath)
    const cipherSha256 = await sha256File(encryptedPath)
    const cipherBytes = fs.statSync(encryptedPath).size

    const manifest: Manifest = {
      version: 1,
      fileName,
      createdAt: new Date().toISOString(),
      // The source identity is recorded without a password or connection string
      // so a restore operator knows what the artifact contains.
      source: { host: source.host, port: source.port, database: source.database, username: source.username },
      plainBytes,
      cipherBytes,
      plainSha256,
      cipherSha256,
      algorithm: ALGORITHM,
      iv,
      tag,
      toolVersion: "1",
      contents: ["database"],
      uploads: await uploadsManifest(),
    }
    fs.writeFileSync(manifestPath(fileName), JSON.stringify(manifest, null, 2), { mode: 0o600 })

    return { ok: true, fileName, cipherBytes, cipherSha256, source: manifest.source, versions }
  } finally {
    // The plaintext dump is unencrypted customer data. It must be removed on
    // every path, including a failed run: a version mismatch or a full disk
    // must not leave readable records sitting in the backup directory.
    try { fs.rmSync(plainPath, { force: true }) } catch { /* ignored */ }
    releaseBackupLock()
  }
}

/**
 * Prove an artifact is intact: ciphertext digest, authenticated decryption, and
 * a structural listing produced by pg_restore. A job that reports success is
 * not evidence - this is.
 */
async function verify(fileName?: string) {
  const manifests = listManifests()
  if (!manifests.length) throw new Error("No backup artifacts were found.")
  const manifest = fileName ? manifests.find((entry) => entry.fileName === fileName) : manifests[0]
  if (!manifest) throw new Error(`No backup artifact named "${fileName}".`)

  const encryptedPath = artifactPath(manifest.fileName)
  if (!fs.existsSync(encryptedPath)) throw new Error(`Artifact ${manifest.fileName} is missing from disk.`)

  const cipherSha256 = await sha256File(encryptedPath)
  if (cipherSha256 !== manifest.cipherSha256) {
    throw new Error(`Ciphertext digest mismatch for ${manifest.fileName}: the artifact has been altered or truncated.`)
  }

  const plainPath = path.join(requireDirectory(), `.verify-${manifest.fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}.dump`)
  try {
    // GCM authentication fails here if the file or the passphrase is wrong.
    await decryptFile(encryptedPath, plainPath, manifest.iv, manifest.tag)
    const plainSha256 = await sha256File(plainPath)
    if (plainSha256 !== manifest.plainSha256) {
      throw new Error(`Decrypted digest mismatch for ${manifest.fileName}.`)
    }
    const listed = await execFileAsync(pgRestoreBin(), ["-l", plainPath], { maxBuffer: 1024 * 1024 * 64 })
    const entries = String(listed.stdout).split("\n").filter((line) => line.trim() && !line.trim().startsWith(";"))
    const tables = entries.filter((line) => /\bTABLE\b|\bTABLE DATA\b/.test(line)).length
    return {
      ok: true,
      fileName: manifest.fileName,
      createdAt: manifest.createdAt,
      cipherSha256,
      plainBytes: manifest.plainBytes,
      archiveEntries: entries.length,
      tableEntries: tables,
      source: manifest.source,
    }
  } finally {
    fs.rmSync(plainPath, { force: true })
  }
}

/**
 * Restore into an explicitly named target.
 *
 * Refusing the configured database is the whole point: a restore aimed at the
 * working development database is unrecoverable.
 */
async function restore() {
  const target = flag("target")
  if (!target) throw new Error("restore requires --target=<connection string>. There is no implicit target.")

  const configured = describeResolvedDatabaseTarget()
  const proposed = (() => {
    try {
      const url = new URL(target)
      return {
        host: url.hostname,
        port: url.port || "5432",
        database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      }
    } catch {
      throw new Error("--target is not a valid connection string.")
    }
  })()

  const sameTarget = configured.configured &&
    proposed.host === configured.host &&
    proposed.port === configured.port &&
    proposed.database === configured.database
  if (sameTarget && String(process.env.ZWS_ALLOW_RESTORE_IN_DEVELOPMENT || "") !== "1") {
    throw new Error(
      `Refusing to restore over the configured database ${configured.database} on ${configured.host}. ` +
        `Restore into a separate restoration database, or set ZWS_ALLOW_RESTORE_IN_DEVELOPMENT=1 to override deliberately.`
    )
  }

  const report = await verify(flag("file") || undefined)
  const manifest = listManifests().find((entry) => entry.fileName === report.fileName)!
  const plainPath = path.join(requireDirectory(), `.restore-${manifest.fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}.dump`)
  try {
    await decryptFile(artifactPath(manifest.fileName), plainPath, manifest.iv, manifest.tag)
    await execFileAsync(pgRestoreBin(), ["--no-owner", "--no-privileges", "--dbname", target, plainPath], { maxBuffer: 1024 * 1024 * 64 })
    return { ok: true, restoredFrom: manifest.fileName, target: `${proposed.database}@${proposed.host}:${proposed.port}` }
  } finally {
    fs.rmSync(plainPath, { force: true })
  }
}

async function prune() {
  const keepDays = Number(flag("keep-days") || process.env.ZWS_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS)
  const keep = Number(flag("keep") || process.env.ZWS_BACKUP_KEEP || DEFAULT_KEEP)
  const manifests = listManifests()
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000

  // Identify the newest artifact that still verifies, and refuse to prune it.
  // Retention is never allowed to delete the last known-good verified backup,
  // no matter how old or misconfigured the policy is.
  let protectedFile: string | null = null
  for (const manifest of manifests) {
    try { await verify(manifest.fileName); protectedFile = manifest.fileName; break } catch { /* not verified, try next */ }
  }

  const removed: string[] = []
  const kept: string[] = []

  for (const [index, manifest] of manifests.entries()) {
    const expired = new Date(manifest.createdAt).getTime() < cutoff
    // Retention never removes every artifact: the newest `keep` are always
    // kept, so a misconfigured retention value cannot destroy the last copy.
    // The last verified backup is protected from policy-driven removal as well.
    if (manifest.fileName === protectedFile || index < keep || (!expired && index < keep + 50)) {
      kept.push(manifest.fileName)
      continue
    }
    fs.rmSync(artifactPath(manifest.fileName), { force: true })
    fs.rmSync(manifestPath(manifest.fileName), { force: true })
    removed.push(manifest.fileName)
  }
  return { ok: true, protectedBackup: protectedFile, kept: kept.length, removed }
}

/**
 * Monitoring probe. Exits non-zero when backups are stale or unreadable, so a
 * scheduler or uptime check notices. Never marks an unhealthy state healthy.
 */
async function health() {
  // 1. Backup-client compatibility. A newer server cannot be dumped by an
  //    older client; prove the installed client reaches it before anything else.
  try { await assertClientSupportsServer() } catch (error: any) {
    return { ok: false, reason: "client_too_old", detail: error?.message || String(error) }
  }

  // 2. Free disk space. A backup that cannot fit must be reported rather than
  //    silently aborting halfway and leaving a partial artifact.
  try {
    const stat = fs.statfsSync(requireDirectory())
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    const minFree = Number(process.env.ZWS_BACKUP_MIN_FREE_BYTES || 1 * 1024 * 1024 * 1024)
    if (freeBytes < minFree) {
      return { ok: false, reason: "low_disk", detail: `Only ${freeBytes} bytes free under ${minFree} required.`, freeBytes, minFree }
    }
  } catch { /* statfs unavailable on the target platform; skip gracefully */ }

  const manifests = listManifests()
  const maxAgeHours = Number(process.env.ZWS_BACKUP_MAX_AGE_HOURS || 24)
  if (!manifests.length) {
    return { ok: false, reason: "no_artifacts", detail: "No backup artifact exists. Any migration now has no rollback point." }
  }
  const newest = manifests[0]
  const ageHours = (Date.now() - new Date(newest.createdAt).getTime()) / 3_600_000
  if (ageHours > maxAgeHours) {
    return { ok: false, reason: "stale", detail: `Newest artifact is ${ageHours.toFixed(1)}h old, past the ${maxAgeHours}h limit.`, newest: newest.fileName, ageHours }
  }
  try {
    const report = await verify(newest.fileName)
    // `verify` already reports `ok`; spread it first so its value is the one
    // that survives rather than being silently overwritten.
    return { ...report, reason: "fresh", ageHours }
  } catch (error: any) {
    return { ok: false, reason: "integrity_failed", detail: error?.message || String(error), newest: newest.fileName }
  }
}

async function main() {
  const command = process.argv[2] || "help"
  switch (command) {
    case "create":
      return create()
    case "list":
      return listManifests().map((entry) => ({ fileName: entry.fileName, createdAt: entry.createdAt, cipherBytes: entry.cipherBytes, source: entry.source }))
    case "verify":
      return verify(flag("file") || undefined)
    case "restore":
      return restore()
    case "prune":
      return await prune()
    case "health":
      return health()
    default:
      return { usage: "create | list | verify | restore --target=<url> | prune | health", root: BACKUP_ROOT }
  }
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2))
    if (result && typeof result === "object" && "ok" in result && (result as any).ok === false) process.exitCode = 2
  })
  .catch((error) => {
    // Never echo the connection string or passphrase back to the operator.
    console.error(`[platform-backup] ${String(error?.message || error).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://<redacted>")}`)
    process.exit(1)
  })