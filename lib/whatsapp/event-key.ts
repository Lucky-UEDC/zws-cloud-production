/**
 * Durable WhatsApp idempotency.
 *
 * The queue already sets a BullMQ `jobId` from a caller-supplied dedupe key,
 * but BullMQ removes completed jobs, so that key only protects against a
 * duplicate that arrives while the job is still pending. A worker restart, a
 * retry after a timeout, or a second event fired an hour later all re-send.
 *
 * This is the durable half: a row in `notification_delivery_logs` keyed by a
 * deterministic event key, claimed with an INSERT that must win a unique
 * index. The first caller wins the claim and sends; everyone else is told the
 * event was already handled. It therefore survives worker restart, retry,
 * timeout and duplicate queue delivery, which is exactly the property a
 * "send the VM is active message" path needs.
 *
 * The key is derived from the event itself, never from a timestamp:
 *
 *     order:<orderId>:paid
 *     vps:<vpsId>:active
 *     vps:<vpsId>:failed
 *     backup:<backupId>:completed
 *     reinstall:<jobId>:completed
 */

import { prisma } from "@/lib/db"

/** Sent successfully, or already claimed and in flight. */
export type EventClaim = "claimed" | "duplicate" | "unavailable"

export function whatsappEventKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(":")
}

/**
 * Try to claim an event for delivery.
 *
 * Returns `unavailable` (never `claimed`) if the database cannot be reached,
 * so a notification is still attempted rather than silently dropped. Failing
 * open is right here: a duplicate message is recoverable, a lost one is not.
 */
export async function claimWhatsAppEvent(input: {
  eventKey: string
  channel?: string
  eventType?: string
  recipient?: string | null
  customerId?: string | null
  metadata?: Record<string, unknown>
  /** Rewind the window so a genuinely new occurrence can send again. */
  ttlHours?: number
}): Promise<EventClaim> {
  const eventKey = String(input.eventKey || "").trim()
  if (!eventKey) return "claimed"
  const channel = input.channel || "whatsapp"
  const ttlHours = Number(input.ttlHours ?? 0) > 0 ? Number(input.ttlHours) : 0
  const now = new Date()

  try {
    // A unique index on (rule_key, event_type, channel) is what makes this
    // atomic across processes. Without it this is two queries and a race.
    const existing = await prisma.notificationDeliveryLog.findFirst({
      where: { ruleKey: eventKey, eventType: input.eventType || "whatsapp_event", channel },
      select: { id: true, status: true, createdAt: true },
    })
    if (existing) {
      if (!ttlHours) return "duplicate"
      const ageHours = (now.getTime() - new Date(existing.createdAt).getTime()) / 3_600_000
      // Inside the rewind window this is the same occurrence, not a new one.
      if (ageHours < ttlHours) return "duplicate"
      await prisma.notificationDeliveryLog.update({
        where: { id: existing.id },
        data: { status: "queued", deliveredAt: null, attempts: 0, error: null, createdAt: now },
      }).catch(() => null)
      return "claimed"
    }

    await prisma.notificationDeliveryLog.create({
      data: {
        ruleKey: eventKey,
        eventType: input.eventType || "whatsapp_event",
        channel,
        recipient: input.recipient || null,
        status: "queued",
        attempts: 1,
        metadata: { ...(input.metadata || {}), customerId: input.customerId || null, claimedAt: now.toISOString() },
      },
    })
    return "claimed"
  } catch (error) {
    // A unique-index violation means a concurrent caller won the claim.
    const message = (error as any)?.message || String(error)
    if (/unique|duplicate key/i.test(message)) return "duplicate"
    console.warn("[whatsapp-event-key] claim failed, delivering anyway", {
      eventKey,
      message,
    })
    return "unavailable"
  }
}

/** Record the outcome so the delivery log is honest about what happened. */
export async function completeWhatsAppEvent(input: {
  eventKey: string
  status: "delivered" | "failed"
  channel?: string
  eventType?: string
  error?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  const channel = input.channel || "whatsapp"
  try {
    await prisma.notificationDeliveryLog.updateMany({
      where: { ruleKey: input.eventKey, channel, ...(input.eventType ? { eventType: input.eventType } : {}) },
      data: {
        status: input.status,
        deliveredAt: input.status === "delivered" ? new Date() : null,
        error: input.error ? String(input.error).slice(0, 500) : null,
        // Prisma's JSON input type does not accept a plain Record; cast at the
        // boundary rather than reshaping the caller's data.
        ...(input.metadata ? { metadata: input.metadata as any } : {}),
      },
    })
  } catch {
    // Delivery already happened; a bookkeeping failure must not resend.
  }
}

/**
 * Lifecycle helper: claim, then send, then record. Returns whether a send was
 * actually performed so the caller can log the skip instead of a delivery.
 */
export async function sendWhatsAppEventOnce(input: {
  eventKey: string
  eventType?: string
  recipient?: string | null
  customerId?: string | null
  metadata?: Record<string, unknown>
  ttlHours?: number
  send: () => Promise<unknown>
}): Promise<{ sent: boolean; reason?: EventClaim }> {
  const claim = await claimWhatsAppEvent({
    eventKey: input.eventKey,
    eventType: input.eventType,
    recipient: input.recipient,
    customerId: input.customerId,
    metadata: input.metadata,
    ttlHours: input.ttlHours,
  })
  if (claim === "duplicate") return { sent: false, reason: claim }
  try {
    await input.send()
    await completeWhatsAppEvent({ eventKey: input.eventKey, eventType: input.eventType, status: "delivered" })
    return { sent: true }
  } catch (error: any) {
    await completeWhatsAppEvent({
      eventKey: input.eventKey,
      eventType: input.eventType,
      status: "failed",
      error: error?.message || String(error),
    })
    throw error
  }
}
