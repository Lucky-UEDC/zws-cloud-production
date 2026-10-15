/**
 * What a Proxmox storage can actually do, decided from its own configuration.
 *
 * ## Why this is not a substring match on the storage type
 *
 * "No snapshot-capable storage found" is the result the panel used to report for
 * a node that had perfectly good storage, because the check it ran was this:
 *
 * ```ts
 * storages.some((s) => s.type === "dir" || s.type === "lvmthin" || ...)
 * ```
 *
 * That treats a `dir` storage as universally snapshot-capable. It is not.
 * Proxmox takes a snapshot of a VM by snapshotting the *volume*, and on a `dir`
 * storage a volume is a file — only a qcow2 image can be snapshotted without
 * converting it. A `dir` storage whose disks are raw is exactly the case where
 * the old check said yes and `qm snapshot` returns an error.
 *
 * So snapshot capability is a property of the pair **(storage type, disk
 * format)**, never of the storage type alone. `storageSnapshotVerdict` is that
 * function; it is the same rule `lib/proxmox-snapshots.ts` already applies to an
 * individual VM's disks, so a node-level verdict and a per-VM verdict can no
 * longer disagree.
 *
 * ## Why backup capability is not "storage exists"
 *
 * A backup target has to be a storage that is enabled, available on the node,
 * and whose `content` actually lists a backup content type. Proxmox distinguishes
 * two of them and they are not interchangeable:
 *
 * - `vzdump` — a normal storage that holds `.tar.zst` archives written by
 *   `POST /nodes/{node}/vzdump`. This is the default backup target.
 * - `backup` — a Proxmox Backup Server datastore, written through the PBS
 *   protocol rather than the filesystem.
 *
 * The panel previously looked for `backup` in one place and for `backup` *or*
 * `vzdump` in another, so an ordinary `vzdump` storage was reported as a backup
 * target on the node card and then filtered out of the backup picker. Both call
 * sites now go through `storageSupportsBackups`.
 *
 * ## This module never changes storage
 *
 * It reads and it explains. It does not enable a content type, convert a
 * filesystem, reformat a disk or delete a volume. The only write in the whole
 * storage story is an explicit, administrator-confirmed action elsewhere, and
 * that path is not here.
 */

import { storageTypeIsSnapshotCapable } from "./storage-snapshot-rule"

/** The content types Proxmox understands, as documented by `pvesm`. */
export const PROXMOX_CONTENT_TYPES = ["images", "rootdir", "iso", "vztmpl", "backup", "vzdump", "snmp", "import"] as const

export type ProxmoxContentType = (typeof PROXMOX_CONTENT_TYPES)[number]

/** The two content types that mean "backups may be written here". */
export const BACKUP_CONTENT_TYPES: readonly string[] = ["vzdump", "backup"]

/**
 * Storage types that host VM images.
 *
 * Proxmox's own `pvesm status` groups these; anything not listed here (PBS,
 * CIFS-only ISO shares, and so on) cannot hold a VM disk whatever its content
 * string claims.
 */
export const VM_DISK_STORAGE_TYPES: readonly string[] = [
  "dir",
  "nfs",
  "cifs",
  "glusterfs",
  "lvm",
  "lvmthin",
  "zvol",
  "zfspool",
  "zfs",
  "rbd",
  "ceph",
  "cephfs",
  "btrfs",
  "iscsi",
  "iscsidirect",
  "pbs",
]

/**
 * Storage types that cannot hold a VM disk at all.
 *
 * Proxmox Backup Server is the notable one: it is a perfectly good backup target
 * and a completely invalid disk target, and confusing the two is how a node ends
 * up trying to provision a VM onto a PBS datastore.
 */
export function storageAcceptsVmDisks(type: string): boolean {
  return VM_DISK_STORAGE_TYPES.includes(String(type || "").toLowerCase().trim()) && String(type).toLowerCase().trim() !== "pbs"
}

/** `content` is a comma-separated string in the API. Parse it once, properly. */
export function parseStorageContent(content: unknown): string[] {
  if (Array.isArray(content)) return content.map((entry) => String(entry).trim()).filter(Boolean)
  return String(content ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export type ProxmoxStorageRow = {
  storage: string
  type?: string
  content?: string | string[]
  enabled?: number | boolean
  active?: number | boolean
  shared?: number | boolean
  avail?: number
  total?: number
  used?: number
  [key: string]: unknown
}

export type StorageCapability = {
  name: string
  type: string
  /** Content types this storage accepts, parsed from Proxmox's comma list. */
  content: string[]
  enabled: boolean
  active: boolean
  shared: boolean
  usable: boolean
  totalBytes: number | null
  usedBytes: number | null
  freeBytes: number | null
  /** Whether a VM disk can be created here at all. */
  acceptsVmDisks: boolean
  /**
   * Whether snapshots work here, once the real disk formats are taken into
   * account.
   *
   * Null means the storage cannot host disks at all, which is different from
   * false: `null` means "this question does not apply", `false` means "asked and
   * the answer is no", `true` means "yes for the disks actually in use".
   */
  supportsSnapshots: boolean | null
  /** The disk formats observed on this storage, when VM configs were readable. */
  observedDiskFormats: string[]
  /** Whether backups may be written here, and which content type says so. */
  supportsBackups: boolean
  backupContentType: string | null
  /** Why this storage is not usable, when it is not. */
  unusableReason: string | null
  /** True when a guest ran out of disk capacity rather than being disabled. */
  full: boolean
}

function boolField(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  const text = String(value).toLowerCase().trim()
  if (text === "false" || text === "0" || text === "no" || text === "off") return false
  if (text === "true" || text === "1" || text === "yes" || text === "on") return true
  return fallback
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Snapshot capability for a storage, given the disk formats actually in use on it.
 *
 * `diskFormats` is the set of formats the VMs on this node really have on this
 * storage, read from their `scsiN`/`virtioN`/`sataN` volume definitions. It is
 * what separates "this storage could snapshot a qcow2 disk" from "the disks here
 * are raw, so `qm snapshot` would fail".
 *
 * When the disk formats are unknown the verdict is `null` — a real third answer,
 * not a guess:
 *
 * - `true`  — every disk here can be snapshotted.
 * - `false` — at least one disk cannot, and the panel will not convert it.
 * - `null`  — the storage could hold a snapshot-capable disk, but nothing on the
 *             node establishes what format its disks are in.
 *
 * The old detector had no third answer: it matched on `type === "dir"` and called
 * it supported, which is right only when the disks happen to be qcow2.
 */
export function storageSnapshotVerdict(type: string, diskFormats?: string[]): boolean | null {
  const acceptsDisks = storageAcceptsVmDisks(type)
  if (!acceptsDisks) return null

  const formats = (diskFormats || []).map((format) => String(format).toLowerCase().trim()).filter(Boolean)
  if (!formats.length) {
    // No disk information. For a type that can only snapshot qcow2 this is
    // genuinely unknown; for a type that snapshots natively it is simply yes.
    return storageTypeIsSnapshotCapable(type, "qcow2")
  }

  // Native-snapshot backends do not care about the disk format.
  if (storageTypeIsSnapshotCapable(type, "raw")) return true
  // Everything else here is file-backed, where only qcow2 can be snapshotted.
  return formats.every((format) => format === "qcow2")
}

/**
 * Turn one `/nodes/{node}/storage` row into a full capability record.
 *
 * `enabled` and `active` are kept separate because Proxmox distinguishes them: a
 * storage can be enabled in configuration and still inactive at runtime, which
 * is the usual meaning of a storage that will not mount.
 */
export function describeStorageCapability(row: ProxmoxStorageRow, diskFormats?: string[]): StorageCapability {
  const type = String(row.type || "").toLowerCase().trim()
  const content = parseStorageContent(row.content)
  const enabled = boolField(row.enabled, true)
  const active = boolField(row.active, true)
  const shared = boolField(row.shared, false)
  const acceptsVmDisks = storageAcceptsVmDisks(type)
  const freeBytes = numberOrNull(row.avail)
  const full = freeBytes !== null && freeBytes <= 0
  const observedDiskFormats = (diskFormats || []).map((format) => String(format).toLowerCase().trim()).filter(Boolean)

  let unusableReason: string | null = null
  if (!enabled) unusableReason = "Disabled in the storage configuration on the Proxmox host."
  else if (!active) unusableReason = "Enabled but not active on this node — the storage is not mounted or not reachable from here."
  else if (full) unusableReason = "Enabled and active, but reporting zero free space."

  const backupContentType = content.find((entry) => BACKUP_CONTENT_TYPES.includes(entry)) ?? null

  return {
    name: String(row.storage || ""),
    type,
    content,
    enabled,
    active,
    shared,
    usable: !unusableReason,
    totalBytes: numberOrNull(row.total),
    usedBytes: numberOrNull(row.used),
    freeBytes,
    acceptsVmDisks,
    supportsSnapshots: storageSnapshotVerdict(type, observedDiskFormats),
    observedDiskFormats,
    // Backups need the storage to be there *and* to declare a backup content
    // type. A content type on a storage that is not active is a configuration
    // intent, not a working target.
    supportsBackups: Boolean(backupContentType) && enabled && active && !full,
    backupContentType,
    unusableReason,
    full,
  }
}

export type CapabilityVerdict = {
  supported: boolean
  /** Storage names that support the capability. */
  storages: StorageCapability[]
  /** Everything inspected, including what was rejected and why. */
  inspected: StorageCapability[]
  /** The honest sentence explaining the verdict. */
  detail: string
  /** What an administrator would have to do, when the answer is no. */
  remediation: string | null
}

function summariseStorages(storages: StorageCapability[]): string {
  if (!storages.length) return "none"
  return storages
    .map((storage) => `${storage.name} (${storage.type || "unknown type"}${storage.freeBytes !== null ? `, ${formatBytes(storage.freeBytes)} free` : ""})`)
    .join(", ")
}

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return "unknown"
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TiB`
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

/**
 * Snapshot capability across a node's storage.
 *
 * Reports the full inspection, not just the verdict: when the answer is "no", the
 * administrator needs to see which storages were considered and why each one was
 * rejected, otherwise "no snapshot-capable storage found" is unactionable.
 */
/**
 * Snapshot capability across a node's storage.
 *
 * `disksByStorage` maps a storage name to the disk formats the VMs on this node
 * actually use there, read from their `scsiN`/`virtioN`/`sataN` volume
 * definitions. Supplying it is what lets the detector answer honestly for
 * file-backed storage instead of assuming the best case.
 *
 * Reports the full inspection, not just the verdict: when the answer is "no", the
 * administrator needs to see which storages were considered and why each one was
 * rejected, otherwise "no snapshot-capable storage found" is unactionable.
 */
export function assessSnapshotCapability(rows: ProxmoxStorageRow[], disksByStorage: Record<string, string[]> = {}): CapabilityVerdict {
  const inspected = rows.map((row) => describeStorageCapability(row, disksByStorage[String(row.storage)]))
  const usable = inspected.filter((storage) => storage.usable)
  const candidates = usable.filter((storage) => storage.acceptsVmDisks)
  const supported = candidates.filter((storage) => storage.supportsSnapshots === true)

  if (supported.length) {
    return {
      supported: true,
      storages: supported,
      inspected,
      detail: `Snapshot-capable storage: ${summariseStorages(supported)}.`,
      remediation: null,
    }
  }

  // The storage is fine, the disks on it are not. This is the case the old
  // detector could not express at all.
  const wrongFormat = candidates.filter((storage) => storage.supportsSnapshots === false)
  if (wrongFormat.length) {
    return {
      supported: false,
      storages: [],
      inspected,
      detail:
        `Storage that holds VM disks but cannot snapshot them: ${wrongFormat
          .map((storage) => `${storage.name} (disks are ${storage.observedDiskFormats.join(", ")})`)
          .join("; ")}. ` +
        `On these storage types Proxmox can only snapshot qcow2 images. Converting an existing disk would change its raw format and rewrite the volume, so this panel will not do it.`,
      remediation:
        "To enable snapshots without touching existing disks, add a storage whose type supports volume snapshots — LVM-thin (lvmthin), ZFS (zfspool), Ceph RBD (rbd) or Btrfs — and create new VM disks there. Those backends snapshot natively whatever the disk format. Existing VMs keep their disks and stay on the storage they are already on.",
    }
  }

  const rejected = inspected.filter((storage) => !storage.usable)
  if (rejected.length) {
    return {
      supported: false,
      storages: [],
      inspected,
      detail: `No usable storage was found. ${rejected.map((storage) => `${storage.name}: ${storage.unusableReason}`).join(" ")}`,
      remediation:
        "This is a Proxmox-side storage problem rather than a permission problem: the storage exists but is disabled, inactive, or full on this node. Fix it in the Proxmox UI under Datacenter → Storage.",
    }
  }

  return {
    supported: false,
    storages: [],
    inspected,
    detail: "No storage on this node is configured to hold VM images.",
    remediation:
      "This node has storage, but none of it accepts the `images` content type, so no VM disk can be created on it. Check the storage's Content column in the Proxmox UI.",
  }
}

/**
 * Backup capability across a node's storage.
 *
 * Accepts either backup content type, because a `vzdump` archive storage and a
 * Proxmox Backup Server datastore are both legitimate and both supported.
 */
export function assessBackupCapability(rows: ProxmoxStorageRow[]): CapabilityVerdict {
  const inspected = rows.map((row) => describeStorageCapability(row))
  const withBackupContent = inspected.filter((storage) => storage.backupContentType !== null)
  const supported = withBackupContent.filter((storage) => storage.usable)

  if (supported.length) {
    return {
      supported: true,
      storages: supported,
      inspected,
      detail: `Backup-capable storage: ${summariseStorages(supported)}.`,
      remediation: null,
    }
  }

  if (withBackupContent.length) {
    return {
      supported: false,
      storages: [],
      inspected,
      detail:
        `Storage declares a backup content type but is not usable for backups: ${withBackupContent
          .map((storage) => `${storage.name} (${storage.unusableReason ?? "not writable"})`)
          .join("; ")}.`,
      remediation:
        "Fix the named storage on the Proxmox host first — it is disabled, inactive or full. A content type on a storage that cannot be written to does not make it a backup target.",
    }
  }

  const bigEnough = inspected
    .filter((storage) => storage.usable)
    .filter((storage) => storage.freeBytes !== null && storage.freeBytes > 0)
    .sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))

  return {
    supported: false,
    storages: [],
    inspected,
    detail: bigEnough.length
      ? `No storage declares the \`vzdump\` or \`backup\` content type. ${summariseStorages(bigEnough.slice(0, 3))} could hold backups if it were enabled for them.`
      : "No storage declares the `vzdump` or `backup` content type.",
    remediation: bigEnough.length
      ? `On the Proxmox host, edit a storage's Content column and tick Backup, then apply. The panel will not make this change for you: it alters where production backups are written, and the correct target is an operational decision. Suggested by free space: ${bigEnough.slice(0, 3).map((storage) => `${storage.name} (${formatBytes(storage.freeBytes)} free)`).join(", ")}. Never point backups at a datastore holding customer VM disks without checking free space and operational safety.`
      : "No storage on this node has usable free space for backups. Add or extend a backup storage on the Proxmox host first, then re-run capability detection.",
  }
}

/** Every storage capability report a node detail page needs, in one call. */
export function assessStorageCapabilities(rows: ProxmoxStorageRow[], disksByStorage: Record<string, string[]> = {}) {
  return {
    storages: rows.map((row) => describeStorageCapability(row, disksByStorage[String(row.storage)])),
    snapshot: assessSnapshotCapability(rows, disksByStorage),
    backup: assessBackupCapability(rows),
  }
}

/**
 * Read the real disk formats off a set of VM configurations.
 *
 * A Proxmox volume definition looks like `local-lvm:vm-101-disk-0,size=32G` or
 * `local:101/vm-101-disk-0.qcow2,size=32G`, so the storage is the part before the
 * first colon and the format is the extension of the file part. This is what
 * turns "this storage is a dir" into "this storage holds raw disks".
 *
 * Only data disks are counted: CD-ROM entries and cloud-init drives are not
 * snapshotted and would otherwise make a storage look like it holds raw data.
 */
export function diskFormatsFromVmConfigs(configs: Array<Record<string, any>>): Record<string, string[]> {
  const byStorage = new Map<string, Set<string>>()
  for (const config of configs || []) {
    for (const [key, value] of Object.entries(config || {})) {
      if (!/^(scsi|virtio|sata|ide)\d+$/.test(key)) continue
      const definition = String(value || "")
      if (!definition || /media=cdrom|cloudinit/i.test(definition)) continue
      const separator = definition.indexOf(":")
      if (separator < 0) continue
      const storage = definition.slice(0, separator)
      const volume = definition.slice(separator + 1).split(",")[0]
      const match = volume.match(/\.(qcow2|raw|vmdk)$/i)
      const format = (match?.[1] || "raw").toLowerCase()
      if (!byStorage.has(storage)) byStorage.set(storage, new Set())
      byStorage.get(storage)!.add(format)
    }
  }
  return Object.fromEntries([...byStorage].map(([storage, formats]) => [storage, [...formats]]))
}