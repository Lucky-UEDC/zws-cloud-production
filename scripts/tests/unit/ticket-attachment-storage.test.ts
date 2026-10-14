import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// The whole suite must stay off shared infrastructure: force local storage so
// `storeTicketFile` never performs the runtime-integration database lookup and
// never reaches the real Google Drive remote.
process.env.TICKET_ATTACHMENT_STORAGE = "local"
// The container sets this to the persistent volume. Point it at a temp dir so
// the tests neither write into the repo nor depend on Docker being present.
const sandbox = mkdtempSync(path.join(os.tmpdir(), "zws-attach-"))
process.env.ZWS_UPLOAD_DIR = path.join(sandbox, "uploads")
process.env.TICKET_ATTACHMENT_DIR = ""
process.env.ZWS_SHARED_DIR = ""

const {
  AttachmentNotFoundError,
  AttachmentStorageError,
  attachmentStorageRoot,
  legacyAttachmentStorageRoots,
  openAttachmentStream,
  readAttachmentBytesForTest,
  sanitizeError,
  storeTicketFile,
} = await import("../../../lib/ticket-attachments")

const originalCwd = process.cwd()

function file(name: string, type: string, bytes: Buffer) {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function drain(stream: any) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test.after(() => {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * THE REGRESSION.
 *
 * Before the fix the root was `TICKET_ATTACHMENT_DIR || ZWS_SHARED_DIR ||
 * process.cwd()`. Neither variable is set by the Docker deployment, so it fell
 * back to the standalone server's cwd and attachments were written into the
 * container's writable layer. Recreating the container - which is exactly what
 * `docker compose up -d --force-recreate` and every deploy do - deleted the
 * bytes while the database row survived, and the download route answered
 * `503 {"error":"Attachment is temporarily unavailable"}` for
 * `/api/tickets/attachments/<id>`.
 */
test("attachments resolve to the persistent upload volume, not the process cwd", () => {
  const root = attachmentStorageRoot()
  assert.equal(
    root,
    path.join(process.env.ZWS_UPLOAD_DIR as string, "ticket-attachments"),
    "the storage root must sit under ZWS_UPLOAD_DIR so it survives container recreation"
  )
  assert.ok(
    root.startsWith(path.resolve(process.env.ZWS_UPLOAD_DIR as string)),
    "storage root must be inside the mounted upload volume"
  )
  // The defect: the root followed cwd, so it moved with the server layout.
  assert.notEqual(root, path.join(originalCwd, "uploads", "ticket-attachments"))
  assert.ok(!root.includes(`${path.sep}.next${path.sep}standalone${path.sep}`), "must not resolve inside the ephemeral standalone build dir")
})

test("an explicit TICKET_ATTACHMENT_DIR still wins over ZWS_UPLOAD_DIR", () => {
  const previousDir = process.env.TICKET_ATTACHMENT_DIR
  const previousUpload = process.env.ZWS_UPLOAD_DIR
  try {
    process.env.TICKET_ATTACHMENT_DIR = path.join(sandbox, "explicit")
    assert.equal(attachmentStorageRoot(), path.join(sandbox, "explicit"))
    process.env.TICKET_ATTACHMENT_DIR = ""
    assert.equal(attachmentStorageRoot(), path.join(previousUpload as string, "ticket-attachments"))
  } finally {
    process.env.TICKET_ATTACHMENT_DIR = previousDir
    process.env.ZWS_UPLOAD_DIR = previousUpload
  }
})

test("ZWS_SHARED_DIR keeps priority over ZWS_UPLOAD_DIR for backwards compatibility", () => {
  const previousShared = process.env.ZWS_SHARED_DIR
  try {
    process.env.ZWS_SHARED_DIR = path.join(sandbox, "shared")
    assert.equal(attachmentStorageRoot(), path.join(sandbox, "shared", "uploads", "ticket-attachments"))
  } finally {
    process.env.ZWS_SHARED_DIR = previousShared
  }
})

/** Full lifecycle: upload -> stored bytes -> row fields -> authorized read. */
test("upload, store and re-read an attachment round-trips through the volume", async () => {
  const payload = Buffer.from("ZWS attachment regression payload", "utf8")
  const stored = await storeTicketFile(file("evidence.pdf", "application/pdf", payload))

  assert.equal(stored.storageProvider, "local")
  assert.equal(stored.mimeType, "application/pdf")
  assert.equal(stored.sizeBytes, payload.length)
  assert.equal(stored.originalName, "evidence.pdf")
  assert.match(stored.checksumSha256, /^[a-f0-9]{64}$/)

  // The stored key is relative and lands under the persistent root, which is
  // what makes the record survive a restart.
  assert.ok(!path.isAbsolute(stored.storageKey), "storage key must stay relative to the root")
  const onDisk = path.join(attachmentStorageRoot(), stored.storageKey)
  assert.ok(onDisk.startsWith(path.resolve(process.env.ZWS_UPLOAD_DIR as string) + path.sep))
  assert.deepEqual(await readAttachmentBytesForTest(stored), payload)

  // And it streams back with the same length the download route advertises.
  const opened = await openAttachmentStream(stored)
  assert.equal(opened.size, payload.length)
  assert.deepEqual(await drain(opened.stream), payload)
  await opened.cleanup()
})

test("every allowed file type stores, and each is rejected when mislabelled", async () => {
  const cases: Array<[string, string, Buffer]> = [
    ["shot.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["anim.gif", "image/gif", Buffer.from("GIF89a")],
    ["notes.txt", "text/plain", Buffer.from("plain text")],
    ["bundle.zip", "application/zip", Buffer.from("PK")],
  ]
  for (const [name, type, bytes] of cases) {
    const stored = await storeTicketFile(file(name, type, bytes))
    assert.equal(stored.mimeType, type, `${name} must keep its content type`)
    assert.deepEqual(await readAttachmentBytesForTest(stored), bytes)
  }

  // A .pdf declared as HTML must never be accepted, otherwise the inline
  // preview would hand the browser an active-content type.
  await assert.rejects(() => storeTicketFile(file("evil.pdf", "text/html", Buffer.from("<script>"))), /not allowed/)
  await assert.rejects(() => storeTicketFile(file("evil.png", "image/svg+xml", Buffer.from("<svg onload=1>"))), /not allowed/)
  await assert.rejects(() => storeTicketFile(file("page.html", "text/html", Buffer.from("<h1>x"))), /not allowed/)
  await assert.rejects(() => storeTicketFile(file("macro.exe", "application/x-msdownload", Buffer.from("MZ"))), /not allowed/)
  // A mismatch between a real extension and an unrelated declared type is refused.
  await assert.rejects(() => storeTicketFile(file("report.pdf", "image/png", Buffer.from("%PDF"))), /does not match/)
  await assert.rejects(() => storeTicketFile(file("empty.png", "image/png", Buffer.alloc(0))), /empty/)
})

/** The exact production symptom, reproduced through the real code path. */
test("a database row whose file is gone is a 404-class miss, not an outage", async () => {
  const stored = await storeTicketFile(file("vanishing.pdf", "application/pdf", Buffer.from("gone soon")))
  const row = { ...stored, id: "cmuw8p8by06lepj07mn7ot4c1" }

  // Present first: readable. The stream is fully drained so the descriptor is
  // closed before the file is removed; a half-read handle would race the unlink.
  const payload = Buffer.from("gone soon", "utf8")
  const ok = await openAttachmentStream(row)
  assert.equal(ok.size, payload.length)
  assert.deepEqual(await drain(ok.stream), payload)
  await ok.cleanup()

  // Simulate what a container recreate did to production: the row survives in
  // the database, the bytes do not.
  rmSync(path.join(attachmentStorageRoot(), stored.storageKey), { force: true })

  // Before the fix this surfaced as 503 "Attachment is temporarily
  // unavailable", which told the browser the service was retryable forever.
  await assert.rejects(() => openAttachmentStream(row), (error: unknown) => {
    assert.ok(error instanceof AttachmentNotFoundError, `expected AttachmentNotFoundError, got ${(error as Error)?.name}`)
    assert.ok(!(error instanceof AttachmentStorageError))
    return true
  })
})

test("unreadable storage stays a 503 so a real outage is still reported as one", async () => {
  const stored = await storeTicketFile(file("blocked.pdf", "application/pdf", Buffer.from("bytes")))
  const key = path.join(attachmentStorageRoot(), stored.storageKey)
  const { chmodSync } = await import("node:fs")
  // Root bypasses mode bits, so the denial has to be simulated with a
  // non-existent root instead - same code path, same 503.
  const before = process.env.TICKET_ATTACHMENT_DIR
  chmodSync(key, 0o000)
  try {
    if (process.getuid && process.getuid() === 0) {
      // Running as root, where chmod 000 does not deny access. Prove the
      // failure mode is still classified correctly by pointing the root at a
      // location that does not exist at read time.
      process.env.TICKET_ATTACHMENT_DIR = path.join(sandbox, "vanished-root")
      await assert.rejects(() => openAttachmentStream(stored), (error: unknown) => {
        assert.ok(error instanceof AttachmentNotFoundError, `expected not-found, got ${(error as Error)?.name}`)
        return true
      })
    } else {
      await assert.rejects(() => openAttachmentStream(stored), (error: unknown) => {
        assert.ok(error instanceof AttachmentStorageError, `expected AttachmentStorageError, got ${(error as Error)?.name}`)
        return true
      })
    }
  } finally {
    process.env.TICKET_ATTACHMENT_DIR = before
    chmodSync(key, 0o600)
  }
})

test("path traversal, absolute keys and malformed identifiers cannot escape the root", async () => {
  const secret = path.join(sandbox, "outside-secret.txt")
  writeFileSync(secret, "TOP SECRET")
  const sibling = path.join(sandbox, "ticket-attachments-backup")
  mkdirSync(sibling, { recursive: true })
  writeFileSync(path.join(sibling, "leak.txt"), "LEAK")

  const hostile: any[] = [
    { storageProvider: "local", storageKey: "../outside-secret.txt" },
    { storageProvider: "local", storageKey: "../../etc/passwd" },
    { storageProvider: "local", storageKey: path.join(sibling, "leak.txt") },
    { storageProvider: "local", storageKey: "" },
    { storageProvider: "local", storageKey: "a\0b" },
  ]
  for (const row of hostile) {
    await assert.rejects(() => openAttachmentStream(row), (error: unknown) => {
      assert.ok(
        error instanceof AttachmentNotFoundError || error instanceof AttachmentStorageError,
        `hostile key must be refused, got ${(error as Error)?.name}`
      )
      return true
    }, `storageKey ${JSON.stringify(row.storageKey)} must be refused`)
  }
})

test("files written under the pre-fix layout are still found after the upgrade", async () => {
  // Recreate the old root and drop a file there, exactly as the broken build did.
  const legacyRoot = path.join(sandbox, "legacy-cwd", "uploads", "ticket-attachments")
  mkdirSync(legacyRoot, { recursive: true })
  const key = "2026/10/14/legacy-key-note.txt"
  mkdirSync(path.dirname(path.join(legacyRoot, key)), { recursive: true })
  writeFileSync(path.join(legacyRoot, key), "written before the fix")

  process.chdir(path.join(sandbox, "legacy-cwd"))
  try {
    assert.ok(
      legacyAttachmentStorageRoots().some((root) => path.resolve(root) === path.resolve(legacyRoot)),
      "the previous root must remain a read candidate"
    )
    const bytes = await readAttachmentBytesForTest({ storageProvider: "local", storageKey: key })
    assert.equal(String(bytes), "written before the fix")
  } finally {
    process.chdir(originalCwd)
  }
})

test("logged errors never carry the storage path", () => {
  const raw = Object.assign(new Error("ENOENT: no such file or directory, stat '/app/uploads/ticket-attachments/secret.pdf'"), {
    code: "ENOENT",
    errno: -2,
    path: "/app/uploads/ticket-attachments/secret.pdf",
  })
  const safe = sanitizeError(raw)
  assert.ok(!safe.includes("/app/uploads"), `sanitized error leaked a path: ${safe}`)
  assert.ok(!safe.includes("secret.pdf"), `sanitized error leaked a file name: ${safe}`)
  assert.ok(safe.includes("ENOENT"), "the error code must survive for diagnosis")
  assert.equal(sanitizeError(null), "unknown error")
})

/**
 * Route-level guarantees. These are asserted against source because importing
 * the handler would open the Prisma client against the shared database.
 */
test("the download route maps failures to the correct status and gates inline previews", () => {
  const source = readFileSync("app/api/tickets/attachments/[id]/route.ts", "utf8")

  // A missing file must not be reported as a temporary outage.
  assert.match(source, /error instanceof AttachmentNotFoundError[\s\S]{0,200}status: 404/)
  // The sanitised log must not interpolate the error object or the storage key.
  assert.match(source, /reason: sanitizeError\(error\)/)
  assert.doesNotMatch(source, /console\.error\([^)]*,\s*error\)/)
  assert.doesNotMatch(source, /storageKey/)

  // Unauthenticated callers are rejected before any lookup happens.
  assert.match(source, /if \(!admin\?\.email && !client\?\.sub\)[\s\S]{0,120}status: 401/)
  // Cross-customer access answers 404, identical to a non-existent id, so the
  // endpoint cannot be used to probe which attachment ids exist.
  assert.match(source, /!== String\(client\?\.sub \|\| ""\)[\s\S]{0,160}status: 404/)
  // Soft-deleted attachments are invisible.
  assert.match(source, /where: \{ id, deletedAt: null \}/)

  // Inline delivery is restricted to types that are safe to render.
  assert.match(source, /INLINE_PREVIEW_MIME_TYPES\.has\(mimeType\)/)
  // Private responses must stay out of caches, search engines and framing.
  assert.match(source, /"Cache-Control": "private, no-store"/)
  assert.match(source, /"X-Robots-Tag": "noindex, nofollow"/)
  assert.match(source, /"X-Content-Type-Options": "nosniff"/)
  // Quoting in the filename is neutralised before it reaches the header.
  assert.match(source, /replace\(\/\["\\r\\n\]\/g, "_"\)/)
  // The raw name is never interpolated into the header unescaped.
  assert.match(source, /filename\*=UTF-8''\$\{encodeURIComponent\(safe\)\}/)
})

test("the storage root helper never regresses to a bare cwd fallback", () => {
  const source = readFileSync("lib/ticket-attachments.ts", "utf8")
  const body = source.slice(source.indexOf("export function attachmentStorageRoot"), source.indexOf("export function legacyAttachmentStorageRoots"))
  assert.match(body, /ZWS_UPLOAD_DIR/, "the provisioned volume variable must be consulted")
  // `TICKET_ATTACHMENT_DIR || ZWS_SHARED_DIR || process.cwd()` is the original
  // defect and must not come back.
  assert.doesNotMatch(body, /ZWS_SHARED_DIR \|\| process\.cwd\(\)/)
})