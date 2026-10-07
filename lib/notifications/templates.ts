import type { NotificationData, NotificationType, NotificationUser } from "@/lib/notifications/types"
import { formatCurrency } from "@/lib/currency-format"

function value(data: NotificationData, key: string, fallback = "") {
  const raw = data[key as keyof NotificationData]
  if (raw === null || raw === undefined) return fallback
  return String(raw)
}

function firstLine(...items: Array<string | null | undefined>) {
  return items.map((item) => String(item || "").trim()).find(Boolean) || ""
}

function moneyLabel(data: NotificationData) {
  const amount = value(data, "amount")
  if (!amount) return ""
  const currency = value(data, "currency", "INR").toUpperCase()
  return `${formatCurrency(Number(amount || 0), currency)} ${currency}`
}

export function renderWhatsAppNotification(input: {
  user: NotificationUser
  type: NotificationType
  data: NotificationData
}) {
  const { user, type, data } = input
  const name = firstLine(user.name, value(data, "userName"), "there")
  // No hardcoded brand. "Cloud" was sent to customers as the company name whenever
  // the caller did not pass one, which for an OTP or invoice message meant the
  // message was signed by a product fragment rather than the operator.
  const brand = firstLine(value(data, "brandName"), value(data, "company_name")) || "our team"

  if (type === "otp") {
    throw new Error("WhatsApp OTP sends must use approved authentication templates.")
  }

  if (type === "login") {
    return [
      `Login alert for ${brand}.`,
      `Hi ${name}, a new login was detected on your account.`,
      `IP: ${value(data, "loginIp", "Unknown")}`,
      `Time: ${value(data, "loginTime", new Date().toLocaleString("en-IN"))}`,
      "If this was not you, reset your password immediately.",
    ].join("\n")
  }

  if (type === "order") {
    const status = firstLine(value(data, "status"), value(data, "orderStatus"), value(data, "templateKey"))
    const lines = [
      `Hi ${name}, your ${brand} order update is ready.`,
      `Order: ${firstLine(value(data, "orderNumber"), value(data, "orderId"), value(data, "invoiceNumber"), "n/a")}`,
      `Product: ${firstLine(value(data, "productName"), value(data, "serviceName"), "Cloud service")}`,
      status ? `Status: ${status}` : "",
      moneyLabel(data) ? `Amount: ${moneyLabel(data)}` : "",
      value(data, "paymentUrl") ? `Link: ${value(data, "paymentUrl")}` : "",
    ]
    return lines.filter(Boolean).join("\n")
  }

  return firstLine(
    value(data, "message"),
    value(data, "text"),
    `Hi ${name}, you have a new notification from ${brand}.`
  )
}
