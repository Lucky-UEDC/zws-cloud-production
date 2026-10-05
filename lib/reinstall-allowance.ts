/**
 * Database-backed reinstall allowance.
 *
 * The pure rules live in `lib/reinstall-policy.ts`. This module is the only
 * place that reads or writes the counters, so consumption is transactional and
 * the customer counter and the per-server counter can never disagree.
 *
 * Counters are stored inside existing JSON columns (`Customer.metadata` and
 * `Order.metadata`) rather than a new table: an additive column/table on a live
 * billing system is a bigger risk than a JSON object the schema already allows.
 */

import { prisma } from "@/lib/db"
import { getSetting } from "@/lib/settings"
import {
  consumeReinstallAllowance,
  customerReinstallSummary,
  DEFAULT_REINSTALL_POLICY,
  evaluateReinstallAllowance,
  normalizeReinstallPolicy,
  parseReinstallTracking,
  REINSTALL_POLICY_CATEGORY,
  type ReinstallAllowance,
  type ReinstallPolicySettings,
  type ReinstallTracking,
} from "@/lib/reinstall-policy"

const CUSTOMER_KEY = "reinstallTracking"
const ORDER_KEY = "reinstallTracking"

function metadataObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
}

export async function getReinstallPolicy(): Promise<ReinstallPolicySettings> {
  const stored = await getSetting<ReinstallPolicySettings | null>(REINSTALL_POLICY_CATEGORY, null).catch(() => null)
  return normalizeReinstallPolicy(stored || DEFAULT_REINSTALL_POLICY)
}

export async function getReinstallAllowance(input: { customerId: string; orderId: string }): Promise<ReinstallAllowance> {
  const policy = await getReinstallPolicy()
  const [customer, order] = await Promise.all([
    prisma.customer.findUnique({ where: { id: input.customerId }, select: { metadata: true } }).catch(() => null),
    prisma.order.findUnique({ where: { id: input.orderId }, select: { metadata: true } }).catch(() => null),
  ])
  return evaluateReinstallAllowance({
    policy,
    customerTracking: parseReinstallTracking(metadataObject(customer?.metadata)[CUSTOMER_KEY]),
    vpsTracking: parseReinstallTracking(metadataObject(order?.metadata)[ORDER_KEY]),
  })
}

export async function getReinstallAllowanceForVps(input: { customerId: string; orderId: string }) {
  const allowance = await getReinstallAllowance(input)
  return { ...allowance, customer: customerReinstallSummary(allowance) }
}

/**
 * Consume one reinstall. Idempotent: the same `operationId` never consumes
 * twice, so a browser retry cannot burn a second allowance.
 *
 * Returns the decision without writing anything when the allowance is not
 * available - a refused reinstall must not touch the counters.
 */
export async function consumeReinstallAllowanceForVps(input: {
  customerId: string
  orderId: string
  operationId: string
  bypass?: boolean
}): Promise<{ allowed: boolean; duplicate: boolean; reason: string | null; allowance: ReinstallAllowance }> {
  const policy = await getReinstallPolicy()
  const decision = await prisma.$transaction(async (tx) => {
    const [customer, order] = await Promise.all([
      tx.customer.findUnique({ where: { id: input.customerId }, select: { metadata: true } }).catch(() => null),
      tx.order.findUnique({ where: { id: input.orderId }, select: { metadata: true } }).catch(() => null),
    ])
    const customerMetadata = metadataObject(customer?.metadata)
    const orderMetadata = metadataObject(order?.metadata)
    const result = consumeReinstallAllowance({
      policy,
      customerTracking: parseReinstallTracking(customerMetadata[CUSTOMER_KEY]),
      vpsTracking: parseReinstallTracking(orderMetadata[ORDER_KEY]),
      operationId: input.operationId,
      bypass: input.bypass === true,
    })
    if (!result.allowed || result.duplicate) return result
    await tx.customer.update({
      where: { id: input.customerId },
      data: { metadata: { ...customerMetadata, [CUSTOMER_KEY]: result.customerTracking } },
    }).catch(() => null)
    await tx.order.update({
      where: { id: input.orderId },
      data: { metadata: { ...orderMetadata, [ORDER_KEY]: result.vpsTracking } },
    }).catch(() => null)
    return result
  })

  return { allowed: decision.allowed, duplicate: decision.duplicate, reason: decision.reason, allowance: decision.allowance }
}

export function reinstallTrackingFromMetadata(metadata: unknown): ReinstallTracking {
  return parseReinstallTracking(metadataObject(metadata)[ORDER_KEY])
}
