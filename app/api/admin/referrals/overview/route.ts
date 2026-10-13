import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { ok, serverError } from "@/lib/referrals/http"
import { prisma } from "@/lib/db"
import {
  dailyReport,
  monthlyReport,
  referralStatusBreakdown,
  serviceReport,
  topReferrers,
  topReferredCustomers,
} from "@/lib/referrals/service"
import { summarizeReferralActivity } from "@/lib/referrals/reporting"
import { getReferralProgramRule } from "@/lib/referrals/program"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  try {
    const [program, statusCounts, topReferrerRows, topCustomerRows, referrerTotal, commissionTotals] = await Promise.all([
      getReferralProgramRule(),
      referralStatusBreakdown(context.dataset),
      Promise.resolve(topReferrers(context.dataset, 5)),
      Promise.resolve(topReferredCustomers(context.dataset, 5)),
      prisma.referralAccount.count({ where: { status: "active" } }),
      prisma.referralCommission.groupBy({
        by: ["status"],
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ])

    // Two clearly separated numbers: what the selected window produced, and
    // what the programme has produced since it started.
    const windowTotals = summarizeReferralActivity({
      customers: context.dataset.customers,
      transactions: context.dataset.windowTransactions,
    })
    const lifetimeTotals = summarizeReferralActivity({
      customers: context.dataset.customers,
      transactions: context.dataset.transactions,
    })

    return ok({
      overview: {
        totalReferrers: referrerTotal,
        totalReferredCustomers: context.dataset.referralTotal,
        statusBreakdown: statusCounts,
        conversionRate: lifetimeTotals.conversionRate,
        // Clicks, accounts and purchases are reported as separate numbers.
        // A click never becomes an account here, and an account never becomes
        // revenue without a paid invoice behind it.
        visits: context.dataset.visits,
        ledgerCommission: commissionTotals.map((row) => ({
          status: String(row.status || "pending"),
          amount: Number(row._sum.amount || 0),
          count: row._count._all,
        })),
      },
      window: {
        range: context.window.range,
        start: context.window.start ? context.window.start.toISOString() : null,
        end: context.window.end ? context.window.end.toISOString() : null,
      },
      totals: { window: windowTotals, lifetime: lifetimeTotals },
      program: {
        commissionPercent: program.commissionPercent,
        holdDays: program.holdDays,
        minimumOrderAmount: program.minimumOrderAmount,
        isActive: program.isActive,
      },
      topReferrers: topReferrerRows,
      topReferredCustomers: topCustomerRows,
      monthly: monthlyReport(context.dataset),
      daily: dailyReport(context.dataset),
      services: serviceReport(context.dataset),
      truncated: context.dataset.truncated,
    })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_OVERVIEW]", error)
    return serverError()
  }
}