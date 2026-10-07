import { NextRequest, NextResponse } from "next/server"
import { sendWhatsAppMessage } from "@/lib/whatsapp/queue"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { badRequest, jsonError, noStoreHeaders, requireWhatsAppAdmin } from "../_shared"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export async function POST(request: NextRequest) {
  try {
    await requireWhatsAppAdmin(request)
    const body = await request.json().catch(() => ({}))
    const phone = text(body.phone)
    const message = text(body.message)
    if (!phone) badRequest("Phone number is required.")
    if (!message && !body.filePath) badRequest("Message or media is required.")

    const templateKey = text(body.templateKey) || WHATSAPP_TEMPLATE_KEYS.ADMIN_TEST
    const brandName = await resolveBrandIdentity()
    const result = await sendWhatsAppMessage({
      to: phone,
      filePath: text(body.filePath) || undefined,
      captionText: text(body.caption) || message,
      messageType: text(body.messageType) as any || "text",
      customerId: text(body.customerId) || null,
      orderId: text(body.orderId) || null,
      invoiceId: text(body.invoiceId) || null,
      ticketId: text(body.ticketId) || null,
      category: text(body.category) || "transactional",
      templateKey,
      variables: {
        ...(body.variables && typeof body.variables === "object" ? body.variables : {}),
        company_name: brandName,
        brandName,
        message_text: message || text(body.caption) || `Your ${brandName} update is ready.`,
      },
      metadata: { source: "admin_send" },
    })

    return NextResponse.json({ ...result, ok: true }, { headers: noStoreHeaders })
  } catch (error) {
    return jsonError(error)
  }
}
