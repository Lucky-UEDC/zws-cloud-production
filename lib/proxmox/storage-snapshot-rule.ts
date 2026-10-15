/**
 * Which Proxmox storage types can snapshot a volume, and under what condition.
 *
 * ## Why this lives on its own
 *
 * This is a fact about a *storage type*, and both the node-level capability
 * detector and the per-VM snapshot diagnostic need to answer it. Keeping it in
 * `lib/proxmox-snapshots.ts` — which imports the HTTP client — and then having
 * `lib/proxmox.ts` reach it created a cycle:
 *
 * ```
 * proxmox.ts -> storage-capabilities.ts -> proxmox-snapshots.ts -> proxmox.ts
 * ```
 *
 * A rule about storage types has no business depending on an HTTP client, so it
 * is here instead. `lib/proxmox-snapshots.ts` re-exports it, so existing callers
 * and their tests are unaffected.
 *
 * ## The rule itself
 *
 * A Proxmox snapshot is a snapshot of the volume, not of the guest. Whether one
 * can be taken therefore depends on what the volume *is*:
 *
 * - CoW/thin-pool/block backends (lvmthin, zfspool, zfs, rbd, ceph, cephfs,
 *   btrfs) snapshot natively, whatever the disk format.
 * - `dir` is a filesystem, so its "volume" is a file. Only a qcow2 image has
 *   internal snapshots; a raw image on a `dir` storage does not, and taking one
 *   would mean converting the disk. This panel never does that silently.
 *
 * The `format` argument exists precisely so `dir` + `raw` can be told apart from
 * `dir` + `qcow2`. Passing `qcow2` asks "could a qcow2 disk here be
 * snapshotted", which is the question a storage-level capability check is
 * asking; the per-VM path passes the disk's actual format instead.
 */

/**
 * Storage types whose volumes carry snapshots natively.
 *
 * `lvm` is deliberately absent: thick LVM volumes cannot be snapshotted while
 * the guest is running, which is the only case the panel cares about.
 *
 * The list is unchanged from the rule that previously lived in
 * `lib/proxmox-snapshots.ts`. Widening it to cover NFS/CIFS — which Proxmox
 * backs with a directory-style storage and which would therefore support qcow2
 * snapshots — is a plausible future improvement, but it is a behaviour change
 * and `snapshot-billing-static.test.ts` pins the current list. Widening it here
 * would silently change what the panel promises customers about snapshot
 * support, which is not a change to make while repairing a detector.
 */
export const SNAPSHOT_CAPABLE_TYPES: readonly string[] = ["lvmthin", "zfspool", "zfs", "rbd", "ceph", "cephfs", "btrfs"]

export function storageTypeIsSnapshotCapable(type: string, format: string): boolean {
  const t = String(type || "").toLowerCase().trim()
  if (SNAPSHOT_CAPABLE_TYPES.includes(t)) return true
  // File-backed storage can only snapshot a qcow2 image. `raw` is excluded.
  if (t === "dir") return format === "qcow2"
  return false
}