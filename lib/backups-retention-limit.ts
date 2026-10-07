/**
 * Backup retention arithmetic — pure, no database, no Proxmox.
 *
 * Kept separate from `lib/backups-retention.ts` (which talks to storage) so
 * customer-facing pages can import it without pulling the server-only modules
 * into the client bundle.
 */

/**
 * The one number that describes how many backups a plan actually keeps.
 *
 * `null` means the plan sets no limit at all. When both limits exist the
 * stricter wins: retention is a promise about what survives, so it cannot be
 * larger than the ceiling the plan allows. A plan claiming 15 backups kept with
 * retention 10 keeps 10, and must be displayed as 10.
 */
export function effectiveBackupLimit(input: {
  maxBackups?: number | null
  retentionCount?: number | null
}): number | null {
  const max = input.maxBackups == null ? null : Math.max(0, Math.floor(Number(input.maxBackups)))
  const retention = input.retentionCount == null ? null : Math.max(0, Math.floor(Number(input.retentionCount)))
  const limits = [max, retention].filter((value): value is number => value != null && Number.isFinite(value))
  if (!limits.length) return null
  return Math.min(...limits)
}

/**
 * Which completed backups fall outside the retention window.
 *
 * Only completed backups are considered. A `running` backup has no settled
 * artifact yet and a `failed` one is evidence of a real failure; pruning either
 * would destroy something worth keeping.
 */
export function selectBackupsToPrune(input: {
  completedBackups: Array<{ id: string; createdAt: Date }>
  limit: number | null
}): Array<{ id: string; createdAt: Date }> {
  if (input.limit == null) return []
  const oldestFirst = [...input.completedBackups].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const excess = oldestFirst.length - input.limit
  if (excess <= 0) return []
  return oldestFirst.slice(0, excess)
}