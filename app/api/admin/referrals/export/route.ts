import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { badRequest, serverError } from "@/lib/referrals/http"
import { exportExcelXml, exportPdfTable, exportTabularResponse } from "@/lib/admin-export"
import {
  adminOrderList,
  adminReferralRelations,
  adminReferrerRows,
  dailyReport,
  monthlyReport,
  serviceReport,
} from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const DATASETS = new Set(["referrals", "referrers", "orders", "monthly", "daily", "services"])
const FORMATS = new Set(["csv", "excel", "pdf"])

/**
 * Referral exports, reusing the platform's existing export helpers
 * (lib/admin-export.ts) rather than introducing a second framework.
 *
 * The export honours exactly the same filters and date window as the screen,
 * so a downloaded file can never disagree with what the operator was looking
 * at.
 */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  const dataset = String(request.nextUrl.searchParams.get("dataset") || "referrals").toLowerCase()
  const format = String(request.nextUrl.searchParams.get("format") || "csv").toLowerCase()
  if (!DATASETS.has(dataset)) return badRequest("Unsupported export dataset")
  if (!FORMATS.has(format)) return badRequest("Unsupported export format")

  try {
    let rows: Array<Record<string, unknown>> = []
    let title = "Referral Report"

    if (dataset === "referrals") {
      const page = adminReferralRelations({ dataset: context.dataset, filters: context.filters, search: context.search })
      title = "Referral Relationships"
      rows = page.rows.map((row) => ({
        Referrer: row.referrerName,
        "Referrer Email": row.referrerEmail,
        "Referral Code": row.referralCode,
        "Referred Customer": row.name,
        "Referred Email": row.email,
        "Registered At": row.registeredAt,
        Status: row.status,
        "First Purchase": row.firstPurchaseAt || "",
        "Latest Purchase": row.latestPurchaseAt || "",
        Orders: row.orderCount,
        Services: row.services.totalServices,
        "Active Services": row.services.activeServices,
        "Total Spend": row.totalSpent,
        "Commission Earned": row.commissionEarned,
        "Commission Pending": row.commissionPending,
        "Commission Paid": row.commissionPaid,
        "Commission Reversed": row.commissionReversed,
      }))
    }

    if (dataset === "referrers") {
      const page = await adminReferrerRows({ dataset: context.dataset, filters: context.filters, search: context.search })
      title = "Referrers"
      rows = page.rows.map((row) => ({
        Referrer: row.name,
        Email: row.email,
        Code: row.code || "",
        "Account Status": row.accountStatus,
        "Joined": row.createdAt,
        "Total Referrals": row.totalReferrals,
        "Active Referrals": row.activeReferrals,
        "Inactive Referrals": row.inactiveReferrals,
        "Conversion Rate": row.conversionRate,
        // Clicks, accounts and conversions are separate columns so an export
        // can never be read as though a click were a customer.
        Visits: row.visits,
        "Registered Accounts (from visits)": row.visitRegisteredAccounts,
        "First-Purchase Conversions": row.visitConvertedCustomers,
        "Visit to Account Rate": row.visitConversionRate,
        Orders: row.orders,
        "Referral Revenue (excl. GST)": row.referralRevenue,
        "GST Collected": row.gstCollected,
        "Total Collected": row.totalCollected,
        "Commission Earned": row.commissionEarned,
        "Commission Pending": row.commissionPending,
        "Commission Paid": row.commissionPaid,
        "Commission Reversed": row.commissionReversed,
      }))
    }

    if (dataset === "orders") {
      const page = adminOrderList({ dataset: context.dataset, filters: context.filters, search: context.search })
      title = "Referred Orders"
      rows = page.rows.map((row) => ({
        Referrer: row.referrerName,
        Customer: row.referredCustomerName,
        "Customer Email": row.referredCustomerEmail,
        Service: row.serviceName || "",
        Product: row.productName,
        "Order ID": row.orderId,
        "Order Number": row.orderNumber,
        "Order Type": row.orderType || "",
        "Invoice Number": row.invoiceNumber,
        "Purchase Date": row.purchaseDate,
        "Service Start": row.serviceStartDate,
        "Billing Period": row.billingPeriod,
        "Renewal Date": row.renewalDate || "",
        "Product Amount (excl. GST)": row.eligibleBaseAmount,
        "GST Amount": row.taxAmount,
        "Order Amount (incl. GST)": row.amount,
        "Payment Status": row.paymentStatus,
        "Order Status": row.orderStatus,
        "Service Status": row.serviceStatus,
        "Commission Amount": row.commission.amount,
        "Commission Status": row.commission.status,
        "Commission Basis": "eligible product amount before GST",
        "Commission Rate": row.commission.ratePercent,
        "Commission Kind": row.commission.kind,
      }))
    }

    if (dataset === "monthly") {
      title = "Monthly Referral Report"
      rows = monthlyReport(context.dataset).map((row) => ({ ...row }))
    }

    if (dataset === "daily") {
      title = "Daily Referral Report"
      rows = dailyReport(context.dataset).map((row) => ({ ...row }))
    }

    if (dataset === "services") {
      title = "Service-wise Referral Report"
      rows = serviceReport(context.dataset).map((row) => ({ ...row }))
    }

    const headers = rows.length ? Object.keys(rows[0]) : ["No referral data"]
    const filename = `referral-${dataset}-${new Date().toISOString().slice(0, 10)}`

    if (format === "csv") return exportTabularResponse({ rows, headers, filename, format: "csv" })
    if (format === "excel") return exportExcelXml({ rows, headers, filename })
    return exportPdfTable({ title, rows, headers, filename })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_EXPORT]", error)
    return serverError()
  }
}