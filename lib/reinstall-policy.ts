/**
 * Reinstall allowance policy.
 *
 * The rule is deliberately small and pure so it can be reasoned about (and
 * tested) without a database: how many reinstalls a customer may run per
 * calendar month, whether unused allowance rolls over, how much of it may roll
 * over, a per-server cap and a cooldown between attempts.
 *
 * Two limit modes, exactly as the admin UI presents them:
 *
 *   fixed    - each month starts again at `monthlyLimit`. Unused allowance is
 *              lost.
 *   rollover - each month starts at `monthlyLimit` plus whatever was left from
 *              the previous month, capped by `rolloverCap` (0 = no rollover).
 *
 * Allowance is only ever consumed when a reinstall is actually accepted, and
 * consumption is idempotent on `operationId`, so a browser retry cannot burn
 * two of the customer's reinstalls.
 */

import { z } from "zod"

export const REINSTALL_POLICY_CATEGORY = "reinstall_policy_settings" as const

/**
 * Admin input is clamped, never trusted: a typo becomes the nearest legal
 * value instead of either throwing the request away or silently disabling the
 * limit entirely.
 */
function clampedInt(fallback: number, min: number, max: number) {
  return z.coerce.number()
    .transform((value) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback))
    .catch(fallback)
}

export const reinstallPolicySettingsSchema = z.object({
  version: z.number().default(1),
  enabled: z.boolean().catch(true).default(true),
  /** Reinstalls allowed per customer per calendar month. */
  monthlyLimit: clampedInt(5, 0, 1000),
  /** `fixed` resets monthly; `rollover` carries unused allowance forward. */
  mode: z.enum(["fixed", "rollover"]).catch("fixed").default("fixed"),
  /** Maximum unused allowance that may roll into the next month. 0 = none. */
  rolloverCap: clampedInt(10, 0, 1000),
  /** Maximum reinstalls a single server may run per month. */
  perVmLimit: clampedInt(5, 0, 1000),
  /** Minimum minutes between two reinstalls of the same server. */
  cooldownMinutes: clampedInt(60, 0, 10080),
  /** Staff-triggered reinstalls ignore the allowance. */
  adminBypass: z.boolean().catch(true).default(true),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

export type ReinstallPolicySettings = z.infer<typeof reinstallPolicySettingsSchema>

export const DEFAULT_REINSTALL_POLICY: ReinstallPolicySettings = reinstallPolicySettingsSchema.parse({})

/**
 * Per-month consumption record. Stored in `Customer.metadata` (customer-wide
 * allowance) and `Order.metadata` (per-server allowance) so no extra table is
 * required and the counters survive with the row they describe.
 */
export type ReinstallTracking = {
  /** `YYYY-MM` the counters belong to. */
  monthKey: string
  /** Reinstalls consumed inside that month. */
  used: number
  /**
   * Allowance granted for that month (base + anything carried in). Unused
   * allowance is `granted - used`, which is what rollover mode carries into
   * the next month.
   */
  granted: number
  /** Allowance carried in from the previous month (rollover mode only). */
  rollover: number
  /** ISO timestamp of the last accepted reinstall. */
  lastUsedAt: string | null
  /** Last operation id consumed, so a retried request is a no-op. */
  lastOperationId: string | null
  /** Recently consumed operation ids, so a retry after a page reload is safe. */
  recentOperationIds: string[]
}

export function emptyReinstallTracking(monthKey = "", granted = 0): ReinstallTracking {
  return { monthKey, used: 0, granted, rollover: 0, lastUsedAt: null, lastOperationId: null, recentOperationIds: [] }
}

export function parseReinstallTracking(value: unknown): ReinstallTracking {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<ReinstallTracking> | null
  const used = Number(raw?.used || 0)
  const granted = Number(raw?.granted || 0)
  const rollover = Number(raw?.rollover || 0)
  return {
    monthKey: String(raw?.monthKey || ""),
    used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0,
    granted: Number.isFinite(granted) && granted > 0 ? Math.floor(granted) : 0,
    rollover: Number.isFinite(rollover) && rollover > 0 ? Math.floor(rollover) : 0,
    lastUsedAt: raw?.lastUsedAt ? String(raw.lastUsedAt) : null,
    lastOperationId: raw?.lastOperationId ? String(raw.lastOperationId) : null,
    recentOperationIds: Array.isArray(raw?.recentOperationIds) ? raw.recentOperationIds.map((item) => String(item)).slice(-10) : [],
  }
}

export function normalizeReinstallPolicy(value: unknown): ReinstallPolicySettings {
  const parsed = reinstallPolicySettingsSchema.safeParse(value || {})
  return parsed.success ? parsed.data : { ...DEFAULT_REINSTALL_POLICY }
}

export function monthKeyFor(date: Date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

export function nextMonthReset(date: Date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

export type ReinstallAllowance = {
  monthKey: string
  /** Allowance granted for the current month, after any rollover. */
  granted: number
  base: number
  rollover: number
  used: number
  remaining: number
  /** Per-server numbers. */
  perVmLimit: number
  perVmUsed: number
  perVmRemaining: number
  mode: ReinstallPolicySettings["mode"]
  enabled: boolean
  cooldownMinutes: number
  cooldownRemainingMinutes: number
  nextResetAt: string
  allowed: boolean
  /** Customer-safe reason. Never contains internal ids. */
  reason: string | null
}

/**
 * Roll the counters into the current month and evaluate what is left.
 *
 * Fixed mode discards unused allowance. Rollover mode carries it forward, never
 * beyond `rolloverCap`.
 */
export function evaluateReinstallAllowance(input: {
  policy?: ReinstallPolicySettings | null
  customerTracking?: ReinstallTracking | null
  vpsTracking?: ReinstallTracking | null
  now?: Date
}): ReinstallAllowance {
  const policy = input.policy ? normalizeReinstallPolicy(input.policy) : { ...DEFAULT_REINSTALL_POLICY }
  const now = input.now || new Date()
  const monthKey = monthKeyFor(now)

  const roll = (tracking: ReinstallTracking | null | undefined): ReinstallTracking => {
    const parsed = parseReinstallTracking(tracking)
    if (parsed.monthKey === monthKey) return parsed.granted > 0 ? parsed : { ...parsed, granted: policy.monthlyLimit }
    if (!parsed.monthKey) return emptyReinstallTracking(monthKey, policy.monthlyLimit)
    // Unused allowance is what the previous month actually granted minus what
    // it actually used - including anything that was rolled in.
    const leftover = Math.max(0, parsed.granted - parsed.used)
    if (policy.mode === "rollover") {
      const carried = policy.rolloverCap > 0 ? Math.min(policy.rolloverCap, leftover) : 0
      return {
        monthKey,
        used: 0,
        granted: policy.monthlyLimit + carried,
        rollover: carried,
        lastUsedAt: parsed.lastUsedAt,
        lastOperationId: parsed.lastOperationId,
        recentOperationIds: parsed.recentOperationIds,
      }
    }
    return {
      ...emptyReinstallTracking(monthKey, policy.monthlyLimit),
      lastUsedAt: parsed.lastUsedAt,
      lastOperationId: parsed.lastOperationId,
      recentOperationIds: parsed.recentOperationIds,
    }
  }

  const customer = roll(input.customerTracking)
  const vps = roll(input.vpsTracking)

  const granted = customer.granted
  const remaining = Math.max(0, granted - customer.used)
  const perVmRemaining = Math.max(0, policy.perVmLimit - vps.used)

  let cooldownRemainingMinutes = 0
  if (policy.cooldownMinutes > 0 && customer.lastUsedAt) {
    const elapsed = now.getTime() - new Date(customer.lastUsedAt).getTime()
    const waitMs = policy.cooldownMinutes * 60_000
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < waitMs) {
      cooldownRemainingMinutes = Math.ceil((waitMs - elapsed) / 60_000)
    }
  }

  let allowed = true
  let reason: string | null = null
  if (!policy.enabled) {
    allowed = false
    reason = "Reinstalls are currently unavailable. Please contact support."
  } else if (cooldownRemainingMinutes > 0) {
    allowed = false
    reason = `A reinstall was completed recently. Please try again in ${cooldownRemainingMinutes} minute${cooldownRemainingMinutes === 1 ? "" : "s"}.`
  } else if (remaining <= 0) {
    allowed = false
    reason = "Monthly reinstall limit reached."
  } else if (policy.perVmLimit > 0 && perVmRemaining <= 0) {
    allowed = false
    reason = "This server has used its reinstall allowance for this month."
  }

  return {
    monthKey,
    granted,
    base: policy.monthlyLimit,
    rollover: granted - policy.monthlyLimit,
    used: customer.used,
    remaining,
    perVmLimit: policy.perVmLimit,
    perVmUsed: vps.used,
    perVmRemaining,
    mode: policy.mode,
    enabled: policy.enabled,
    cooldownMinutes: policy.cooldownMinutes,
    cooldownRemainingMinutes,
    nextResetAt: nextMonthReset(now).toISOString(),
    allowed,
    reason,
  }
}

export type ReinstallConsumption = {
  allowed: boolean
  reason: string | null
  /** Already consumed by this operation id - a retried request. */
  duplicate: boolean
  customerTracking: ReinstallTracking
  vpsTracking: ReinstallTracking
  allowance: ReinstallAllowance
}

/**
 * Consume one reinstall from the allowance.
 *
 * Idempotent on `operationId`: the same id returns the previous decision with
 * `duplicate: true` instead of burning another allowance, so a browser retry
 * or a double-submitted form costs the customer exactly one reinstall.
 */
export function consumeReinstallAllowance(input: {
  policy?: ReinstallPolicySettings | null
  customerTracking?: ReinstallTracking | null
  vpsTracking?: ReinstallTracking | null
  operationId: string
  now?: Date
  bypass?: boolean
}): ReinstallConsumption {
  const policy = input.policy ? normalizeReinstallPolicy(input.policy) : { ...DEFAULT_REINSTALL_POLICY }
  const now = input.now || new Date()
  const operationId = String(input.operationId || "").trim()
  const allowance = evaluateReinstallAllowance({ policy, customerTracking: input.customerTracking, vpsTracking: input.vpsTracking, now })

  if (!operationId) {
    return { allowed: false, reason: "Reinstall request is missing its operation id.", duplicate: false, customerTracking: parseReinstallTracking(input.customerTracking), vpsTracking: parseReinstallTracking(input.vpsTracking), allowance }
  }

  const existingCustomer = parseReinstallTracking(input.customerTracking)
  const duplicate = existingCustomer.recentOperationIds.includes(operationId) || existingCustomer.lastOperationId === operationId
  if (duplicate) {
    return { allowed: true, reason: null, duplicate: true, customerTracking: existingCustomer, vpsTracking: parseReinstallTracking(input.vpsTracking), allowance }
  }

  const bypass = input.bypass === true && policy.adminBypass
  if (!bypass && !allowance.allowed) {
    return { allowed: false, reason: allowance.reason, duplicate: false, customerTracking: existingCustomer, vpsTracking: parseReinstallTracking(input.vpsTracking), allowance }
  }

  const previousCustomer = parseReinstallTracking(input.customerTracking)
  const previousVps = parseReinstallTracking(input.vpsTracking)
  const sameCustomerMonth = previousCustomer.monthKey === allowance.monthKey
  const customerTracking: ReinstallTracking = {
    ...previousCustomer,
    monthKey: allowance.monthKey,
    granted: allowance.granted,
    used: (sameCustomerMonth ? previousCustomer.used : 0) + (bypass ? 0 : 1),
    rollover: allowance.rollover,
    lastUsedAt: bypass ? previousCustomer.lastUsedAt : now.toISOString(),
    lastOperationId: operationId,
    recentOperationIds: [...previousCustomer.recentOperationIds, operationId].slice(-10),
  }
  const vpsTracking: ReinstallTracking = {
    ...previousVps,
    monthKey: allowance.monthKey,
    granted: allowance.perVmLimit,
    used: (allowance.monthKey === previousVps.monthKey ? previousVps.used : 0) + (bypass ? 0 : 1),
    lastUsedAt: bypass ? previousVps.lastUsedAt : now.toISOString(),
    lastOperationId: operationId,
    recentOperationIds: [...previousVps.recentOperationIds, operationId].slice(-10),
  }

  return {
    allowed: true,
    reason: null,
    duplicate: false,
    customerTracking,
    vpsTracking,
    allowance,
  }
}

/** Customer-facing shape. Never contains internal identifiers. */
export function customerReinstallSummary(allowance: ReinstallAllowance) {
  return {
    allowed: allowance.allowed,
    reason: allowance.reason,
    monthlyLimit: allowance.granted,
    used: allowance.used,
    remaining: allowance.remaining,
    mode: allowance.mode,
    nextResetAt: allowance.nextResetAt,
  }
}
