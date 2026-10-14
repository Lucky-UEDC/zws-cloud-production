import { NextRequest, NextResponse } from "next/server"
import { Readable } from "node:stream"
import { prisma } from "@/lib/db"
import { getAdminFromRequest, getClientFromRequest } from "@/lib/server-auth"
import {
  AttachmentNotFoundError,
  INLINE_PREVIEW_MIME_TYPES,
  openAttachmentStream,
  sanitizeError,
} from "@/lib/ticket-attachments"

export const dynamic = "force-dynamic"

function disposition(name: string, inline: boolean) {
  const safe = String(name || "attachment").replace(/["\r\n]/g, "_")
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [admin, client] = await Promise.all([
    getAdminFromRequest(request).catch(() => null),
    getClientFromRequest(request).catch(() => null),
  ])
  if (!admin?.email && !client?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const attachment = await (prisma as any).supportTicketAttachment.findFirst({
    where: { id, deletedAt: null },
    include: { ticket: { select: { customerId: true } } },
  }).catch(() => null)
  if (!attachment) return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
  // A caller that does not own the ticket gets the same 404 as a caller asking
  // for an id that never existed, so attachment ids cannot be enumerated.
  if (!admin?.email && String(attachment.ticket?.customerId || "") !== String(client?.sub || "")) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
  }

  try {
    const opened = await openAttachmentStream(attachment)
    const mimeType = String(attachment.mimeType || "application/octet-stream")
    // `?preview=1` only ever upgrades the response for a type that is safe to
    // render; anything else stays a download regardless of what the caller asked
    // for, so an unexpected or mislabelled type cannot be executed inline.
    const inline = request.nextUrl.searchParams.get("preview") === "1" && INLINE_PREVIEW_MIME_TYPES.has(mimeType)
    const stream = Readable.toWeb(opened.stream) as ReadableStream
    opened.stream.once("close", () => void opened.cleanup())
    return new NextResponse(stream, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(opened.size),
        "Content-Disposition": disposition(attachment.originalName, inline),
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'none'; script-src 'none'; sandbox",
      },
    })
  } catch (error) {
    // The file being gone is a 404, not an outage. Reporting it as 503 made a
    // permanently lost attachment look like a temporary service problem and
    // invited clients to retry forever.
    if (error instanceof AttachmentNotFoundError) {
      return NextResponse.json({ error: "Attachment file is no longer available" }, { status: 404 })
    }
    // Sanitised: never logs the storage path, the storage key or the raw message.
    console.error("[ticket_attachment_stream_failed]", JSON.stringify({
      attachmentId: id,
      storageProvider: attachment.storageProvider,
      reason: sanitizeError(error),
    }))
    return NextResponse.json({ error: "Attachment is temporarily unavailable" }, { status: 503 })
  }
}