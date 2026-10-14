import { prisma } from "@/lib/db"
import {
  DEFAULT_NODE_RESOURCE_POLICY,
  normalizeNodeResourcePolicy,
  type NodeResourcePolicy,
} from "@/lib/node-resource-policy"

/**
 * Persistence for the node resource allocation policy.
 *
 * The policy lives in the generic `admin_settings` key/value store rather than
 * in a new dedicated column, so enabling it needs no schema migration and no
 * write against a shared database. The calculations themselves stay in
 * `lib/node-resource-policy.ts`, which stays pure and dependency free.
 */
export const NODE_RESOURCE_POLICY_SETTING_KEY = "node_resource_policy"

/** Reads are best effort: a missing or unreadable row yields safe defaults. */
export async function readNodeResourcePolicy(): Promise<NodeResourcePolicy> {
  const row = await prisma.adminSetting
    .findUnique({ where: { key: NODE_RESOURCE_POLICY_SETTING_KEY }, select: { value: true } })
    .catch(() => null)
  if (!row) return { ...DEFAULT_NODE_RESOURCE_POLICY }
  const value = row.value && typeof row.value === "object" && !Array.isArray(row.value)
    ? row.value as Record<string, unknown>
    : {}
  return normalizeNodeResourcePolicy(value)
}

export async function writeNodeResourcePolicy(input: unknown, updatedBy?: string | null): Promise<NodeResourcePolicy> {
  // Validate before persisting so an out-of-range ratio can never be stored and
  // later trusted by the provisioning gate.
  const policy = normalizeNodeResourcePolicy(input)
  await prisma.adminSetting.upsert({
    where: { key: NODE_RESOURCE_POLICY_SETTING_KEY },
    create: {
      key: NODE_RESOURCE_POLICY_SETTING_KEY,
      value: policy as never,
      description: "Node RAM and disk allocation policy. RAM defaults to 80% of allocatable physical RAM; disk overcommit up to 5:1 is only applied to verified thin-provisioned storage.",
      updatedBy: updatedBy || null,
    },
    update: {
      value: policy as never,
      updatedBy: updatedBy || null,
    },
  })
  return policy
}