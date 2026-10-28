import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { getAdminFromCookies } from "@/lib/server-auth"
import { invoiceTaxWriteFields } from "@/lib/invoices/tax"
import { createInvoiceForOrder } from "@/lib/invoices"
import { handlePaidInvoice } from "@/lib/payment-finalization"
import { classifyInvoiceDeletionSafety, invoiceDeletionInclude } from "@/lib/invoice-deletion"

function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `ZWS-${timestamp}-${random}`
}

export async function GET(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const status = request.nextUrl.searchParams.get("status")

  const invoices = await prisma.invoice.findMany({
    where: { deletedAt: null, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      ...invoiceDeletionInclude(),
    },
  })

  return NextResponse.json({
    invoices: invoices.map((invoice) => ({
      ...invoice,
      deletionSafety: classifyInvoiceDeletionSafety(invoice),
    })),
  })
}

export async function POST(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json()) as {
    invoiceNumber?: string
    customerId?: string
    totalAmount?: number
    subtotal?: number
    taxAmount?: number
    discountAmount?: number
    taxRate?: number
    lineItems?: any[]
    productId?: string
    productMode?: "existing" | "custom"
    paymentStatus?: "pending" | "paid"
    termMonths?: number
    billingCycle?: string
    customProduct?: Record<string, any>
    operatingSystemId?: string | null
    notes?: string
  }

  const invoiceNumber = String(body.invoiceNumber || `INV-MANUAL-${Date.now()}`).trim()
  const customerId = String(body.customerId || "").trim()
  const totalAmount = Number(body.totalAmount || 0)
  const paymentStatus = String(body.paymentStatus || "pending").toLowerCase()
  const notes = String(body.notes || "").trim()

  if (!invoiceNumber || !customerId || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    return NextResponse.json({ error: "invoiceNumber, customerId and positive totalAmount are required" }, { status: 400 })
  }
  const customer = await prisma.customer.findUnique({ where: { id: customerId } })
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 })

  const now = new Date()
  const dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const subtotal = Number.isFinite(Number(body.subtotal)) && Number(body.subtotal) > 0 ? Number(body.subtotal) : Number((totalAmount / 1.18).toFixed(2))
  const taxAmount = Number.isFinite(Number(body.taxAmount)) ? Number(body.taxAmount) : Number((totalAmount - subtotal).toFixed(2))
  const discountAmount = Math.max(0, Number(body.discountAmount || 0))
  const taxRate = Number.isFinite(Number(body.taxRate)) ? Number(body.taxRate) : 18
  const termMonths = [1, 3, 6, 12].includes(Number(body.termMonths || 1)) ? Number(body.termMonths || 1) : 1
  const lineItems = Array.isArray(body.lineItems) && body.lineItems.length ? body.lineItems : [
    {
      description: "Manual admin invoice",
      quantity: 1,
      unitPrice: subtotal,
      termMonths,
      total: subtotal,
    },
  ]

  if (paymentStatus === "paid") {
    const product = body.productId ? await prisma.product.findUnique({ where: { id: String(body.productId) } }) : null
    const custom = body.customProduct && typeof body.customProduct === "object" ? body.customProduct : null
    if (!product && !custom) return NextResponse.json({ error: "Paid invoice creation requires an existing or custom product." }, { status: 400 })
    const orderNumber = generateOrderNumber()
    const customConfig = custom ? await prisma.customConfig.create({
      data: {
        customerId,
        cpuCores: Math.max(1, Number(custom.cpuCores || custom.cpu || 1)),
        ramGb: Math.max(1, Number(custom.ramGb || custom.ram || 1)),
        disks: [{ type: "nvme", sizeGb: Math.max(1, Number(custom.diskGb || custom.storageGb || 20)), label: "Custom storage" }],
        bandwidthTb: Math.max(0, Number(custom.bandwidthTb || custom.bandwidth || 0)),
        termMonths,
        monthlyPrice: Number(custom.sellingPrice || subtotal),
        totalPrice: subtotal,
        status: "draft",
      },
    }) : null
    const order = await prisma.order.create({
      data: {
        orderNumber,
        customerId,
        productId: product?.id || null,
        customConfigId: customConfig?.id || null,
        orderType: "admin_invoice",
        termMonths,
        unitPrice: subtotal,
        quantity: 1,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount,
        originalAmount: subtotal + taxAmount,
        finalAmount: totalAmount,
        payableAmount: totalAmount,
        operatingSystemId: body.operatingSystemId || null,
        osName: String(custom?.os || ""),
        currency: "INR",
        status: "paid",
        provisioningStatus: body.operatingSystemId ? "pending" : "waiting_for_admin",
        notes: notes || null,
        metadata: {
          createdByAdmin: admin.email,
          source: "admin_invoice_create",
          billingCycle: body.billingCycle || "monthly",
          customProduct: custom,
          addOns: {
            backupSlots: Number(custom?.backupSlots || 0),
            snapshots: Number(custom?.snapshots || 0),
            ipv4Count: Number(custom?.ipv4Count || 1),
          },
        } as any,
      },
    })
    const invoice = await createInvoiceForOrder(order.id, { allowPending: true })
    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        invoiceNumber,
        status: "paid",
        paidAt: now,
        lineItems,
        notes: notes || null,
        metadata: {
          ...((invoice.metadata && typeof invoice.metadata === "object" && !Array.isArray(invoice.metadata)) ? invoice.metadata as Record<string, unknown> : {}),
          source: "admin_invoice_create",
          billingCycle: body.billingCycle || "monthly",
        } as any,
      },
    })
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        invoiceId: updatedInvoice.id,
        customerId,
        gateway: "manual",
        amount: totalAmount,
        currency: "INR",
        status: "completed",
        purpose: "admin_invoice_paid",
        completedAt: now,
        gatewayTransactionId: `manual:${order.orderNumber}`,
        transactionId: `manual:${order.orderNumber}`,
        errorMessage: "Marked paid by admin during invoice creation",
      },
    })
    const finalization = body.operatingSystemId
      ? await handlePaidInvoice(updatedInvoice.id, {
          paymentId: payment.id,
          actor: `admin:${admin.email}`,
          autoProvision: true,
          purpose: "admin_invoice_paid",
          transactionId: `manual:${order.orderNumber}`,
        }).catch((error: any) => ({ finalized: false, reason: error?.message || "finalization_failed" }))
      : { finalized: true, queued: false, reason: "waiting_for_admin" }
    return NextResponse.json({ success: true, invoice: updatedInvoice, order, payment, finalization }, { status: 201 })
  }

  const publicBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://myrdphub.com").replace(/\/+$/, "")
  const paymentUrl = `${publicBaseUrl}/invoice/${encodeURIComponent(invoiceNumber)}`
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      customerId,
      issueDate: now,
      dueDate,
      subtotal,
      ...invoiceTaxWriteFields({ taxRate, taxAmount }),
      discountAmount,
      totalAmount,
      status: "pending",
      type: "manual",
      lineItems: lineItems as any,
      notes: notes || null,
      metadata: {
        source: "admin_invoice_create",
        productMode: body.productMode || "custom",
        productId: body.productId || null,
        customProduct: body.customProduct || null,
        billingCycle: body.billingCycle || "monthly",
        orderCreationPolicy: "create_order_after_payment",
        paymentUrl,
      } as any,
    },
  })

  return NextResponse.json({ success: true, invoice, paymentUrl }, { status: 201 })
}
