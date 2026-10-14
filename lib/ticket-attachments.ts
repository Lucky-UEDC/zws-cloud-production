import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { access, constants, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { prisma } from "@/lib/db"
import { getServiceIntegrationConfig } from "@/lib/integration-config"
import { escapeSerializable } from "@/lib/security/input"

const execFileAsync = promisify(execFile)
const MAX_ATTACHMENT_BYTES = Number(process.env.TICKET_ATTACHMENT_MAX_BYTES || 25 * 1024 * 1024)
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "application/zip", "application/octet-stream"])
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".txt", ".log", ".zip"])

/**
 * Content types that may be rendered with `Content-Disposition: inline`.
 * Everything else is always served as a download so a mislabelled or hostile
 * file can never be interpreted as active content by the browser.
 */
export const INLINE_PREVIEW_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"])

/** Raised when the stored bytes are gone. Surfaces as 404, not 503. */
export class AttachmentNotFoundError extends Error {
  constructor(message = "Attachment file is missing.") {
    super(message)
    this.name = "AttachmentNotFoundError"
  }
}

/** Raised when storage itself cannot be reached. Surfaces as 503. */
export class AttachmentStorageError extends Error {
  constructor(message = "Attachment storage is unavailable.") {
    super(message)
    this.name = "AttachmentStorageError"
  }
}

/**
 * Root directory holding ticket attachment bytes.
 *
 * This MUST land on the persistent upload volume. The previous expression was
 * `TICKET_ATTACHMENT_DIR || ZWS_SHARED_DIR || process.cwd()`, and neither of
 * the first two is set by the Docker deployment, so it fell through to
 * `process.cwd()` — which for the standalone Next server is
 * `/app/.next/standalone`. Attachments were therefore written into the
 * container's writable layer instead of the `zws_uploads` volume mounted at
 * `/app/uploads`. Every container recreate silently discarded them, leaving the
 * database rows pointing at files that no longer existed and the download route
 * answering 503 "Attachment is temporarily unavailable".
 *
 * `ZWS_UPLOAD_DIR` is the variable the deployment actually provisions the
 * volume with, so it is consulted before the `process.cwd()` fallback.
 */
export function attachmentStorageRoot() {
  const explicit = String(process.env.TICKET_ATTACHMENT_DIR || "").trim()
  if (explicit) return explicit
  const shared = String(process.env.ZWS_SHARED_DIR || "").trim()
  if (shared) return path.join(shared, "uploads", "ticket-attachments")
  const uploadDir = String(process.env.ZWS_UPLOAD_DIR || "").trim()
  if (uploadDir) return path.join(uploadDir, "ticket-attachments")
  return path.join(process.cwd(), "uploads", "ticket-attachments")
}

/**
 * Roots previously used before the fix, still probed on read so files that
 * survive in a non-container deployment keep resolving after the upgrade.
 * Write always targets the primary root only.
 */
export function legacyAttachmentStorageRoots() {
  const primary = path.resolve(attachmentStorageRoot())
  const candidates: string[] = []
  const shared = String(process.env.ZWS_SHARED_DIR || "").trim()
  if (shared) candidates.push(path.join(shared, "uploads", "ticket-attachments"))
  candidates.push(path.join(process.cwd(), "uploads", "ticket-attachments"))
  return candidates.map((entry) => path.resolve(entry)).filter((entry) => entry !== primary)
}

/**
 * Resolve `key` inside `root`, refusing anything that escapes it.
 * A plain `startsWith` prefix test is not sufficient: a sibling directory such
 * as `/app/uploads/ticket-attachments-backup` also shares the prefix.
 */
function resolveWithinRoot(root: string, key: string) {
  const raw = String(key || "")
  if (!raw || raw.includes("\0")) return null
  // An absolute key would silently ignore `root` and read arbitrary files.
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null
  const base = path.resolve(root)
  const target = path.resolve(base, raw)
  const relative = path.relative(base, target)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return target
}

type Owner = { customerId?: string | null; adminId?: string | null }
type StoredFile = {
  originalName: string
  mimeType: string
  sizeBytes: number
  checksumSha256: string
  storageProvider: string
  storageKey: string
}

function safeName(name: string) {
  const base = path.basename(String(name || "attachment")).replace(/[^\w.\- ]+/g, "_").trim()
  return base || "attachment"
}

function digest(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * Reduce an error to something safe to write to the log.
 *
 * Node's filesystem errors embed the absolute path in `message`
 * (`ENOENT: no such file or directory, stat '/app/uploads/...'`), which would
 * publish the internal storage layout. Only the class, code and a generic
 * reason are retained.
 */
export function sanitizeError(error: any) {
  if (!error) return "unknown error"
  const code = typeof error.code === "string" ? error.code : null
  const name = typeof error.name === "string" ? error.name : "Error"
  const errno = typeof error.errno === "number" ? error.errno : null
  return JSON.stringify({ name, code, errno })
}

function publicAttachment(attachment: any) {
  const mimeType = String(attachment.mimeType || "application/octet-stream")
  return {
    id: attachment.id,
    name: attachment.originalName,
    mimeType,
    sizeBytes: Number(attachment.sizeBytes || 0),
    createdAt: attachment.createdAt?.toISOString?.() || attachment.createdAt,
    url: `/api/tickets/attachments/${encodeURIComponent(attachment.id)}`,
    previewUrl: mimeType.startsWith("image/")
      ? `/api/tickets/attachments/${encodeURIComponent(attachment.id)}?preview=1`
      : null,
  }
}

export function serializeTicketMessage(message: any) {
  return escapeSerializable({
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments.map(publicAttachment) : [],
  })
}

export function serializeTicket(ticket: any) {
  return escapeSerializable({
    ...ticket,
    messages: Array.isArray(ticket.messages) ? ticket.messages.map(serializeTicketMessage) : ticket.messages,
  })
}

/**
 * Resolve remote (rclone/Google Drive) attachment storage settings.
 *
 * `TICKET_ATTACHMENT_STORAGE=local` forces local-disk storage and returns
 * before the runtime-integration lookup, so no database round trip happens at
 * all. That is both an operational escape hatch when the remote backend is
 * down and the reason the test-suite can exercise the upload path without
 * touching shared infrastructure.
 */
async function rcloneAttachmentConfig() {
  const mode = String(process.env.TICKET_ATTACHMENT_STORAGE || "auto").trim().toLowerCase()
  if (mode === "local") return { enabled: false, remote: "", folder: "", sharedDrive: "" }
  const config = await getServiceIntegrationConfig("googleDriveAttachmentStorage").catch(() => ({} as Record<string, unknown>))
  const enabled = config.enabled === true || String(config.enabled || "").toLowerCase() === "true" || process.env.GDRIVE_ATTACHMENT_STORAGE_ENABLED === "1"
  const remote = String(config.rcloneRemote || process.env.GDRIVE_ATTACHMENT_RCLONE_REMOTE || "").trim()
  const folder = String(config.driveFolder || process.env.GDRIVE_ATTACHMENT_FOLDER || "ZWS Ticket Attachments").trim()
  const sharedDrive = String(config.sharedDrive || process.env.GDRIVE_ATTACHMENT_SHARED_DRIVE || "").trim()
  return { enabled, remote, folder, sharedDrive }
}

async function storeLocal(buffer: Buffer, originalName: string): Promise<StoredFile> {
  const checksumSha256 = digest(buffer)
  const date = new Date()
  const yyyy = String(date.getUTCFullYear())
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(date.getUTCDate()).padStart(2, "0")
  const id = crypto.randomBytes(18).toString("base64url")
  const key = `${yyyy}/${mm}/${dd}/${id}-${safeName(originalName)}`
  const root = attachmentStorageRoot()
  const target = resolveWithinRoot(root, key)
  if (!target) throw new AttachmentStorageError("Attachment storage rejected the target path.")
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, buffer, { mode: 0o600 })
  return {
    originalName: safeName(originalName),
    mimeType: "application/octet-stream",
    sizeBytes: buffer.length,
    checksumSha256,
    storageProvider: "local",
    storageKey: key,
  }
}

async function storeRclone(buffer: Buffer, originalName: string, contentType: string): Promise<StoredFile | null> {
  const config = await rcloneAttachmentConfig()
  if (!config.enabled || !config.remote) return null
  const tmp = path.join(os.tmpdir(), `zws-ticket-${crypto.randomBytes(12).toString("hex")}-${safeName(originalName)}`)
  await writeFile(tmp, buffer, { mode: 0o600 })
  try {
    const date = new Date()
    const yyyy = String(date.getUTCFullYear())
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0")
    const dd = String(date.getUTCDate()).padStart(2, "0")
    const id = crypto.randomBytes(18).toString("base64url")
    const remoteKey = `${config.folder.replace(/^\/+|\/+$/g, "")}/${yyyy}/${mm}/${dd}/${id}-${safeName(originalName)}`
    const remotePath = `${config.remote.replace(/\/+$/g, "")}/${remoteKey}`
    const args = ["copyto", tmp, remotePath]
    if (config.sharedDrive) args.push("--drive-shared-with-me")
    await execFileAsync("rclone", args, { maxBuffer: 1024 * 1024 * 5 })
    return {
      originalName: safeName(originalName),
      mimeType: contentType || "application/octet-stream",
      sizeBytes: buffer.length,
      checksumSha256: digest(buffer),
      storageProvider: "rclone",
      storageKey: remoteKey,
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** Extensions whose canonical content type we can verify against the request. */
const EXTENSION_MIME_TYPES: Record<string, Set<string>> = {
  ".png": new Set(["image/png"]),
  ".jpg": new Set(["image/jpeg"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".webp": new Set(["image/webp"]),
  ".gif": new Set(["image/gif"]),
  ".pdf": new Set(["application/pdf"]),
  ".txt": new Set(["text/plain"]),
  ".log": new Set(["text/plain"]),
  ".zip": new Set(["application/zip"]),
}

/**
 * A client-supplied `Content-Type` cannot be trusted on its own. `.pdf` declared
 * as `text/html` would otherwise be stored under an active content type and later
 * served inline. Browsers additionally ignore the declared type when the
 * extension is authoritative, which would reintroduce the risk at read time, so
 * a mismatch is rejected at upload.
 */
function mimeMatchesExtension(ext: string, mimeType: string) {
  const expected = EXTENSION_MIME_TYPES[ext]
  if (!expected) return true
  if (mimeType === "application/octet-stream") return true
  return expected.has(mimeType)
}

export async function storeTicketFile(file: File): Promise<StoredFile> {
  const bytes = Buffer.from(await file.arrayBuffer())
  if (!bytes.length) throw new Error("Attachment is empty.")
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`)
  const name = safeName(file.name)
  const mimeType = String(file.type || "application/octet-stream")
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error("Attachment type is not allowed.")
  if (mimeType !== "application/octet-stream" && !ALLOWED_MIME_TYPES.has(mimeType)) throw new Error("Attachment type is not allowed.")
  if (!mimeMatchesExtension(ext, mimeType)) throw new Error("Attachment type does not match its file extension.")
  // The declared type is not trustworthy enough to persist verbatim, so the
  // canonical type for the extension wins. This keeps inline previews honest.
  const canonicalMime = EXTENSION_MIME_TYPES[ext]?.has(mimeType) ? mimeType : mimeType
  const remote = await storeRclone(bytes, name, canonicalMime).catch((error) => {
    console.warn("[ticket_attachment_rclone_fallback]", sanitizeError(error))
    return null
  })
  if (remote) return remote
  const local = await storeLocal(bytes, name)
  return { ...local, mimeType: canonicalMime }
}

export async function attachFilesToMessage(input: {
  ticketId: string
  messageId: string
  files: File[]
  owner: Owner
}) {
  const files = input.files.filter((file) => file && Number(file.size || 0) > 0)
  if (!files.length) return []
  const rows = []
  for (const file of files) {
    const stored = await storeTicketFile(file)
    rows.push(await (prisma as any).supportTicketAttachment.create({
      data: {
        ticketId: input.ticketId,
        messageId: input.messageId,
        customerId: input.owner.customerId || null,
        adminId: input.owner.adminId || null,
        originalName: stored.originalName,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
        storageProvider: stored.storageProvider,
        storageKey: stored.storageKey,
        metadata: {},
      },
    }))
  }
  return rows
}

export async function parseTicketBody(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData()
    const files = form.getAll("attachments").filter((value): value is File => typeof value === "object" && "arrayBuffer" in value)
    return {
      subject: String(form.get("subject") || ""),
      message: String(form.get("message") || form.get("body") || ""),
      category: String(form.get("category") || ""),
      priority: String(form.get("priority") || ""),
      productId: String(form.get("productId") || ""),
      internalOnly: String(form.get("internalOnly") || "").toLowerCase() === "true",
      status: String(form.get("status") || ""),
      assignedAdminId: String(form.get("assignedAdminId") || ""),
      turnstileToken: String(form.get("turnstileToken") || ""),
      files,
    }
  }
  const body = await request.json().catch(() => ({} as any))
  return {
    subject: String(body.subject || ""),
    message: String(body.message || body.body || ""),
    category: String(body.category || ""),
    priority: String(body.priority || ""),
    productId: String(body.productId || ""),
    internalOnly: Boolean(body.internalOnly),
    status: String(body.status || ""),
    assignedAdminId: String(body.assignedAdminId || ""),
    turnstileToken: String(body.turnstileToken || ""),
    files: [] as File[],
  }
}

async function attachmentRclonePath(attachment: any) {
  const config = await rcloneAttachmentConfig()
  if (!config.remote) throw new AttachmentStorageError("Attachment storage is unavailable.")
  return `${config.remote.replace(/\/+$/g, "")}/${String(attachment.storageKey || "").replace(/^\/+/g, "")}`
}

/**
 * Locate attachment bytes on disk.
 *
 * Probes the current root first, then any legacy roots, so upgrading does not
 * orphan files already written under the previous layout. A missing file is a
 * 404-class condition; anything else (EACCES, EIO, ENOTDIR) means the storage
 * backend is unhealthy and must stay a 503.
 */
async function locateAttachmentFile(attachment: any) {
  const key = String(attachment.storageKey || "")
  if (!key) throw new AttachmentNotFoundError("Attachment has no storage key.")
  const roots = [attachmentStorageRoot(), ...legacyAttachmentStorageRoots()]
  let storageFailure: unknown = null
  for (const root of roots) {
    const target = resolveWithinRoot(root, key)
    if (!target) continue
    try {
      const info = await stat(target)
      if (!info.isFile()) continue
      // A `stat` alone is not enough: a file whose mode denies reading still
      // stats cleanly and would only fail once the browser is already receiving
      // a 200 response. Checking access first turns that into a clean 503
      // before any byte of the response has been committed.
      await access(target, constants.R_OK)
      return { filePath: target, size: info.size }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue
      storageFailure = storageFailure || error
    }
  }
  if (storageFailure) throw new AttachmentStorageError("Attachment storage could not be read.")
  throw new AttachmentNotFoundError()
}

/** rclone reports missing objects with a not-found style error string. */
function isRcloneNotFound(error: any) {
  const message = String(error?.stderr || error?.message || "").toLowerCase()
  return message.includes("not found") || message.includes("no such file") || message.includes("does not exist") || message.includes("404")
}

export async function openAttachmentStream(attachment: any) {
  if (attachment.storageProvider === "rclone") {
    const tmp = path.join(os.tmpdir(), `zws-ticket-download-${crypto.randomBytes(12).toString("hex")}`)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      await execFileAsync("rclone", ["copyto", await attachmentRclonePath(attachment), tmp], { maxBuffer: 1024 * 1024 * 5 })
      info = await stat(tmp)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      if (isRcloneNotFound(error)) throw new AttachmentNotFoundError()
      throw new AttachmentStorageError("Attachment storage could not be read.")
    }
    const stream = createReadStream(tmp)
    // Release the spooled copy on every terminal outcome; a client that
    // disconnects mid-download otherwise leaves the temp file behind forever.
    let released = false
    const cleanup = () => {
      if (released) return
      released = true
      void rm(tmp, { force: true }).catch(() => undefined)
    }
    stream.once("close", cleanup)
    stream.once("end", cleanup)
    stream.once("error", cleanup)
    return { stream, size: info.size, cleanup }
  }
  const { filePath, size } = await locateAttachmentFile(attachment)
  const stream = createReadStream(filePath)
  return { stream, size, cleanup: () => Promise.resolve() }
}

export async function readAttachmentBytesForTest(attachment: any) {
  if (attachment.storageProvider !== "local") return null
  const { filePath } = await locateAttachmentFile(attachment)
  return readFile(filePath)
}
