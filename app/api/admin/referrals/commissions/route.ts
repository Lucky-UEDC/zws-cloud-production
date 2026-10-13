import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { ok, serverError } from "@/lib/referrals/http"
import { clientCommissionList } from "@/lib/referrals/service"
import { sumCommissionTotals } from "@/lib/referrals/commission"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Commission ledger with earned / pending / paid / reversed kept distinct. */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  try {
    const page = clientCommissionList({
      dataset: context.dataset,
      filters: context.filters,
      search: context.search,
      referrerCustomerId: "",
    })

    const lifetime = sumCommissionTotals(
      context.dataset.transactions.map((row) => ({
        amount: row.commission.amount,
        status: row.commission.materialised ? row.commission.status : "pending",
      })),
    )
    const windowTotals = sumCommissionTotals(
      context.dataset.windowTransactions.map((row) => ({
        amount: row.commission.amount,
        status: row.commission.materialised ? row.commission.status : "pending",
      })),
    )

    const [paidByLedger, pendingByLedger] = await Promise.all([
      prisma.referralCommission.groupBy({ by: ["status"], _sum: { amount: true }, _count: { _all: true } }),
      prisma.referralCommission.count({ where: { status: "pending" } }),
    ])

    return ok({
      commissions: page.rows,
      pagination: page.pagination,
      totals: {
        window: windowTotals,
        lifetime,
        // What the durable ledger currently holds, independent of the window.
        ledger: paidByLedger.map((row) => ({
          status: String(row.status || "pending"),
          amount: Number(row._sum.amount || 0),
          count: row._count._all,
        })),
        pendingLedgerRows: pendingByLedger,
      },
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_COMMISSIONS]", error)
    return serverError()
  }
}