/**
 * Output parsers for guest operations.
 *
 * Every parser here is OS-specific and carries an explicit cross-OS guard: a
 * Windows payload is never interpreted as `df` output and vice versa. The
 * normalized result shape is identical for both engines, which is what lets the
 * frontend stay completely OS agnostic.
 *
 * Normalized disk result:
 *   { filesystem, totalBytes, usedBytes, freeBytes, usedPercent, volumes[] }
 *
 * There is no random or synthetic path in this file. A parse that cannot be
 * trusted returns `ok: false` with a machine-readable code, and the caller
 * keeps showing the last known good value.
 */

import type { GuestErrorCode } from "./constants"

export type ParsedVolume = {
  /** Mount point on Linux, drive letter on Windows. */
  name: string
  filesystem?: string | null
  device?: string | null
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usedPercent: number
  /** True for the root/system volume that should drive the headline number. */
  system?: boolean
}

export type ParsedDiskUsage = {
  ok: true
  volumes: ParsedVolume[]
  selected: ParsedVolume | null
  collector: string
}

export type ParseFailure = { ok: false; errorCode: GuestErrorCode; error: string }
export type ParseResult = ParsedDiskUsage | ParseFailure

/**
 * Pseudo filesystems that must never be treated as customer storage.
 * Including these is how a naive `df` collector ends up reporting `overlay` or
 * `squashfs` as "the root filesystem" with nonsense sizes.
 */
const LINUX_IGNORED_FILESYSTEM_TYPES = new Set([
  "proc",
  "sysfs",
  "devtmpfs",
  "devpts",
  "tmpfs",
  "cgroup",
  "cgroup2",
  "overlay",
  "squashfs",
  "efivarfs",
  "securityfs",
  "pstore",
  "bpf",
  "debugfs",
  "tracefs",
  "fusectl",
  "configfs",
  "mqueue",
  "hugetlbfs",
  "autofs",
  "binfmt_misc",
  "nsfs",
  "ramfs",
  "rpc_pipefs",
])

const LINUX_IGNORED_MOUNT_PREFIXES = ["/proc", "/sys", "/dev", "/run", "/snap"]

function bytes(value: unknown): number {
  const parsed = Number(String(value ?? "").trim())
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function percent(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const value = (used / total) * 100
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
}

/**
 * `used + free` must reconcile with `total`, otherwise the row is untrustworthy.
 *
 * `df` prints Available, not Free. ext2/3/4 and XFS hold blocks back for root,
 * so on any stock Debian or Ubuntu root `used + available` falls short of
 * `1-blocks` by that reserve: a real Debian 11 root clone reported
 * 1114353664 + 710397952 against a 1942188032 total, a 6.05% gap. That reserve
 * belongs to the filesystem, not to the parse, so the Linux caller passes the
 * Use% column df printed and the row is instead required to agree with df's own
 * arithmetic. That is a strictly stronger alignment check than a size
 * tolerance, and it is what proves the numbers came from the right columns.
 *
 * The Windows callers derive `used` from the same reported numbers
 * (`total - freeSpace`), so their rows reconcile exactly and keep the strict
 * size check. Only `df` needs the reserved-block form.
 */
function rowIsConsistent(total: number, used: number, free: number, dfUsePercent?: number): boolean {
  if (!(total > 0)) return false
  if (used < 0 || free < 0) return false
  if (used > total) return false
  if (free > total) return false
  const pool = used + free
  if (dfUsePercent === undefined) {
    return Math.abs(total - pool) <= total * 0.05
  }
  // df computes Use% as ceil(100 * used / (used + available)). A row whose
  // offsets were misread cannot reproduce it, and the sum of the two reported
  // columns can never exceed the total it was derived from.
  if (pool <= 0 || pool > total) return false
  return Math.abs(Math.ceil((used / pool) * 100) - dfUsePercent) <= 1
}

function selectLinuxRoot(volumes: ParsedVolume[]): ParsedVolume | null {
  if (!volumes.length) return null
  const root = volumes.find((volume) => volume.name === "/")
  if (root) return root
  // The mount that backs `/` when `/` itself is a bind/overlay we filtered out.
  const backing = volumes.find((volume) => volume.name.startsWith("/") && !LINUX_IGNORED_MOUNT_PREFIXES.some((p) => volume.name.startsWith(p)))
  if (backing) return backing
  return [...volumes].sort((a, b) => b.totalBytes - a.totalBytes)[0] ?? null
}

/**
 * Parse `df -B1 -P` output.
 *
 * `-B1` gives bytes and `-P` guarantees one line per filesystem, but a mount
 * point may still contain spaces, so the numeric fields are located relative to
 * the `Use%` column rather than from either edge. That is what makes a
 * positional parse safe.
 *
 * The percentage handed to the panel is computed from the byte counts rather
 * than copied out of `df`, because `df` prints whole percent and the panel has
 * to be able to show `usedBytes / totalBytes` exactly. `df`'s own percentage is
 * still read: it is the value the row is reconciled against, so a misaligned
 * read is rejected instead of being turned into a plausible-looking volume.
 */
export function parseLinuxDf(output: string): ParseResult {
  const text = String(output || "")
  if (!text.trim()) return { ok: false, errorCode: "PARSE_FAILED", error: "df produced no output" }

  // Cross-OS guard: a Windows payload here means the wrong command ran.
  if (/^\s*DeviceID\s*=/m.test(text) || /LogicalDisk/i.test(text) || /^\s*DriveType\s*[:=]/m.test(text)) {
    return { ok: false, errorCode: "PARSE_FAILED", error: "Windows volume payload received by the df parser" }
  }

  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim())
  if (!lines.length) return { ok: false, errorCode: "PARSE_FAILED", error: "df produced no usable lines" }

  const headerIndex = lines.findIndex((line) => /^filesystem\b/i.test(line.trim()))
  if (headerIndex === -1) {
    // `df` without a recognised header: refuse rather than guess positions.
    return { ok: false, errorCode: "PARSE_FAILED", error: "df output has no recognizable header" }
  }

  const volumes: ParsedVolume[] = []
  let rejected = 0
  let ignoredCount = 0
  for (const line of lines.slice(headerIndex + 1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) continue

    // Anchor on the Use% column: it is the only field with a `%` suffix.
    const capacityIndex = fields.findIndex((field) => /^\d{1,3}%$/.test(field))
    if (capacityIndex < 4 || capacityIndex + 1 >= fields.length) {
      rejected++
      continue
    }
    const total = bytes(fields[capacityIndex - 3])
    const used = bytes(fields[capacityIndex - 2])
    const free = bytes(fields[capacityIndex - 1])
    const mountPoint = fields.slice(capacityIndex + 1).join(" ") || "/"
    const device = fields.slice(0, capacityIndex - 3).join(" ")

    const dfUsePercent = Number(fields[capacityIndex].slice(0, -1))
    if (!rowIsConsistent(total, used, free, dfUsePercent)) {
      rejected++
      continue
    }
    // Pseudo filesystems are dropped here, not filtered later, so a caller
    // iterating `volumes` can never pick up `overlay` or `tmpfs` as root.
    if (
      LINUX_IGNORED_FILESYSTEM_TYPES.has(String(device).split("/").pop()?.toLowerCase() || "") ||
      LINUX_IGNORED_MOUNT_PREFIXES.some((prefix) => mountPoint === prefix || mountPoint.startsWith(`${prefix}/`))
    ) {
      ignoredCount++
      continue
    }
    volumes.push({
      name: mountPoint,
      device,
      // POSIX df reports no filesystem type; `df -B1 -P` has no such column, so
      // this stays null rather than being guessed from the device name.
      filesystem: null,
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      // Derived from the byte counts, not from df's rounded Use% column: df
      // prints whole percent, so 1.57% is reported as "2%". The panel must be
      // able to show usedBytes / totalBytes exactly.
      usedPercent: percent(used, total),
      system: mountPoint === "/",
    })
  }

  if (!volumes.length) {
    return {
      ok: false,
      errorCode: ignoredCount ? "DISK_DATA_INVALID" : "PARSE_FAILED",
      error: ignoredCount
        ? "every reported filesystem was a pseudo filesystem"
        : `no reconcilable df rows (${rejected} rejected)`,
    }
  }

  const selected = selectLinuxRoot(volumes)
  if (!selected) return { ok: false, errorCode: "DISK_DATA_INVALID", error: "no selectable root filesystem" }
  return { ok: true, volumes, selected, collector: "linux_df" }
}

function isIgnoredWindowsDriveType(value: unknown): boolean {
  // DriveType: 0 unknown, 1 no root dir, 2 removable, 3 fixed, 4 network,
  // 5 cdrom, 6 ramdisk. We only accept fixed (3) and ramdisk-free local media.
  const type = Number(value)
  if (!Number.isFinite(type)) return true
  return type !== 3
}

function selectWindowsDrive(volumes: ParsedVolume[]): ParsedVolume | null {
  if (!volumes.length) return null
  const c = volumes.find((volume) => volume.name.toUpperCase() === "C:")
  if (c) return c
  return [...volumes].sort((a, b) => b.totalBytes - a.totalBytes)[0] ?? null
}

/**
 * Parse the JSON emitted by `Get-CimInstance Win32_LogicalDisk ... |
 * ConvertTo-Json -Compress`. Accepts a single object or an array (PowerShell
 * unwraps a 1-element array when the pipeline yields one item).
 */
export function parseWindowsLogicalDiskJson(output: string): ParseResult {
  const text = String(output || "").trim()
  if (!text) return { ok: false, errorCode: "PARSE_FAILED", error: "PowerShell produced no output" }
  // Cross-OS guard: this is `df` output, not a Windows volume payload.
  if (/^filesystem\s+\d+\s+\d+/im.test(text) && !/DeviceID|FreeSpace/i.test(text)) {
    return { ok: false, errorCode: "PARSE_FAILED", error: "df payload received by the Windows parser" }
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, errorCode: "PARSE_FAILED", error: "PowerShell output was not valid JSON" }
  }

  const rows = Array.isArray(payload) ? payload : [payload]
  const volumes: ParsedVolume[] = []
  let sawIrrelevant = 0
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    if (isIgnoredWindowsDriveType(record.DriveType)) {
      sawIrrelevant++
      continue
    }
    const deviceId = String(record.DeviceID ?? record.DeviceId ?? "").trim()
    if (!/^[A-Za-z]:$/.test(deviceId)) continue
    const total = bytes(record.Size)
    const free = bytes(record.FreeSpace)
    if (!rowIsConsistent(total, bytes(record.Size) - free, free)) continue
    const used = total - free
    volumes.push({
      name: deviceId,
      device: deviceId,
      filesystem: record.FileSystem ? String(record.FileSystem) : null,
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usedPercent: percent(used, total),
      system: deviceId.toUpperCase() === "C:",
    })
  }

  if (!volumes.length) {
    return {
      ok: false,
      errorCode: sawIrrelevant ? "DISK_DATA_INVALID" : "PARSE_FAILED",
      error: sawIrrelevant ? "only removable/CD/network drives were reported" : "no fixed volumes with valid sizes",
    }
  }
  const selected = selectWindowsDrive(volumes)
  if (!selected) return { ok: false, errorCode: "DISK_DATA_INVALID", error: "no selectable Windows volume" }
  return { ok: true, volumes, selected, collector: "windows_cim" }
}

/**
 * Parse `wmic logicaldisk get DeviceID,Size,FreeSpace /format:list`.
 * Used only as the legacy fallback when `Get-CimInstance` is unavailable.
 */
export function parseWindowsWmicList(output: string): ParseResult {
  const text = String(output || "")
  if (!text.trim()) return { ok: false, errorCode: "PARSE_FAILED", error: "wmic produced no output" }
  if (/^filesystem\s+\d+/im.test(text)) {
    return { ok: false, errorCode: "PARSE_FAILED", error: "df payload received by the wmic parser" }
  }

  const records: Array<Record<string, string>> = []
  let current: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      if (Object.keys(current).length) records.push(current)
      current = {}
      continue
    }
    const separator = line.indexOf("=")
    if (separator === -1) continue
    current[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  if (Object.keys(current).length) records.push(current)

  const volumes: ParsedVolume[] = []
  for (const record of records) {
    const deviceId = String(record.deviceid ?? "").trim()
    if (!/^[A-Za-z]:$/.test(deviceId)) continue
    const total = bytes(record.size)
    const free = bytes(record.freespace)
    if (!rowIsConsistent(total, total - free, free)) continue
    const used = total - free
    volumes.push({
      name: deviceId,
      device: deviceId,
      filesystem: record.filesystem || null,
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usedPercent: percent(used, total),
      system: deviceId.toUpperCase() === "C:",
    })
  }
  if (!volumes.length) return { ok: false, errorCode: "PARSE_FAILED", error: "no fixed volumes in wmic output" }
  const selected = selectWindowsDrive(volumes)
  if (!selected) return { ok: false, errorCode: "DISK_DATA_INVALID", error: "no selectable Windows volume" }
  return { ok: true, volumes, selected, collector: "windows_wmic" }
}

/**
 * Parse `fsutil volume diskfree C:` for the legacy Windows fallback.
 *
 * `fsutil` reports human-readable units ("100 GB"). Those are ambiguous across
 * locales and unit systems, so a payload we cannot read as a raw byte count is
 * REJECTED rather than converted with an assumed factor — a wrong number here
 * would silently misreport a customer's disk.
 */
export function parseWindowsFsutil(output: string, drive = "C:"): ParseResult {
  const text = String(output || "")
  if (!text.trim()) return { ok: false, errorCode: "PARSE_FAILED", error: "fsutil produced no output" }
  if (/^filesystem\s+\d+/im.test(text)) {
    return { ok: false, errorCode: "PARSE_FAILED", error: "df payload received by the fsutil parser" }
  }
  // The label alternation must be grouped, otherwise only the first branch
  // carries the capture group and the value silently comes back undefined.
  const pick = (label: RegExp) => {
    const match = text.match(new RegExp(`(?:${label.source})\\s*[:=]\\s*([0-9][0-9, ]*?)\\s*(bytes|byte)?\\s*$`, "im"))
    if (!match) return 0
    return bytes(match[1].replace(/[,\s]/g, ""))
  }
  const free = pick(/Free\s*Space|Free\s*Bytes|Available/)
  const total = pick(/Total\s*Space|Total\s*Bytes|Size/)
  if (!total || !free) {
    return { ok: false, errorCode: "PARSE_FAILED", error: "fsutil reported human-readable units, not bytes" }
  }
  if (!rowIsConsistent(total, total - free, free)) {
    return { ok: false, errorCode: "DISK_DATA_INVALID", error: "fsutil values did not reconcile" }
  }
  const used = total - free
  const volume: ParsedVolume = {
    name: drive,
    device: drive,
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usedPercent: percent(used, total),
    system: true,
  }
  return { ok: true, volumes: [volume], selected: volume, collector: "windows_fsutil" }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type ParsedInterface = {
  name: string
  mac?: string | null
  ipv4: string[]
  ipv6: string[]
  /** True for the interface carrying the default route. */
  primary: boolean
  up: boolean
}

export type ParsedNetwork = {
  interfaces: ParsedInterface[]
  primary: ParsedInterface | null
}

/**
 * Normalise `agent/network-get-interfaces`. We never assume `eth0` / `ens18` /
 * `Ethernet`: the interface actually holding the guest address is selected.
 */
/**
 * Names that are, by construction, not the interface the hypervisor gave a
 * customer.
 *
 * A guest running Docker, Kubernetes or libvirt reports its bridges alongside
 * its real NIC, and the bridge is frequently the one with the tidiest address —
 * `docker0` at `172.17.0.1`, `br-<id>` at `172.18.0.1`. Sorting by "which
 * interface looks most usable" picked the bridge, and a customer IP configured
 * onto `docker0` takes the container network down with it.
 *
 * This is the fallback. The authoritative signal is the MAC the hypervisor
 * assigned, passed in as `hypervisorMacs` — a bridge can be named anything, but
 * it never carries the MAC Proxmox put in `net0`.
 */
const VIRTUAL_INTERFACE_PATTERNS = [
  /^(docker|br-|veth|virbr|vmnet|tun|tap|utun|ppp|lo|lo\d)/i,
  /^(kube|cni|flannel|cali|weave|cilium|antrea|docker0)/i,
  /^(dummy|ifb|gre|gretap|ipip|wg)/i,
  /^(lxc|veth|nbd)/i,
  /[:.]$/,
]

export function isVirtualInterfaceName(name: string): boolean {
  return VIRTUAL_INTERFACE_PATTERNS.some((pattern) => pattern.test(name))
}

/** MACs Proxmox assigned to this VM, from `net0`..`netN` in the VM config. */
export function hypervisorMacsFromConfig(config: Record<string, any> | null | undefined): string[] {
  if (!config) return []
  const macs: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/i.test(key)) continue
    const match = String(value ?? "").match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)
    if (match) macs.push(match[1].toLowerCase())
  }
  return macs
}

export function parseNativeInterfaces(payload: unknown, options: { hypervisorMacs?: string[] } = {}): ParsedNetwork {
  const hypervisorMacs = (options.hypervisorMacs || []).map((mac) => mac.toLowerCase())
  const raw = unwrapAgentPayload(payload)
  const interfaces: ParsedInterface[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, any>
    if (record["name"] === "lo" || record["hardware-address"] === "00:00:00:00:00:00") continue
    const name = String(record["name"] ?? "").trim()
    if (!name) continue
    const ipv4: string[] = []
    const ipv6: string[] = []
    for (const address of Array.isArray(record["ip-addresses"]) ? record["ip-addresses"] : []) {
      // The agent reports the family as the string "ipv4"/"ipv6" in practice.
      // Reading it as a number and comparing to 4 silently collects nothing, and
      // the result is an interface list with no addresses on it — which looks
      // like a network problem rather than a parsing one.
      const rawType = address?.["ip-address-type"]
      const type = typeof rawType === "number" ? rawType : Number(String(rawType ?? "").replace(/[^0-9]/g, ""))
      const value = String(address?.["ip-address"] ?? "").trim()
      if (!value) continue
      if (type === 4 || /ipv4/i.test(String(rawType ?? ""))) ipv4.push(value)
      else if (type === 6 || /ipv6/i.test(String(rawType ?? ""))) ipv6.push(value)
    }
    interfaces.push({
      name,
      mac: record["hardware-address"] ? String(record["hardware-address"]) : null,
      ipv4,
      ipv6,
      primary: false,
      up: ipv4.length > 0,
    })
  }
  // Exactly one primary.
  //
  // Ranked, most authoritative first:
  //   1. carries a MAC the hypervisor assigned to this VM — a fact, not a guess
  //   2. is not a known virtual interface and has an IPv4 — the usual answer when
  //      no config was passed
  //   3. anything else with an address
  //   4. anything else at all
  //
  // An interface matching (1) always wins, even with no address: it is the NIC the
  // customer was sold, and it is the one the address belongs on even if the guest
  // has not brought it up yet.
  const rank = (entry: ParsedInterface) => {
    const assigned = Boolean(entry.mac) && hypervisorMacs.includes(String(entry.mac).toLowerCase())
    if (assigned) return 0
    if (!isVirtualInterfaceName(entry.name) && entry.ipv4.length > 0) return 1
    if (isVirtualInterfaceName(entry.name)) return 3
    return 2
  }
  const sorted = [...interfaces].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    if (a.ipv4.length !== b.ipv4.length) return b.ipv4.length - a.ipv4.length
    if (a.up !== b.up) return a.up ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  if (sorted[0]) sorted[0].primary = true
  return { interfaces: sorted, primary: sorted[0] ?? null }
}

/** Parse a `hostname -I`-style flat IP list (used by simple templates). */
export function parseIpLines(output: string): string[] {
  return String(output || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value))
}

/** Parse a single-value expectation, e.g. `hostname`. */
export function parseSingleLine(output: string): string {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? ""
}

export function parseNativeOsInfo(payload: unknown): { osId: string | null; name: string | null; version: string | null; kernel: string | null } {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
  const id = record.id ? String(record.id) : null
  return {
    osId: id,
    name: record.name ? String(record.name) : null,
    version: record["version-id"] ? String(record["version-id"]) : (record.version ? String(record.version) : null),
    kernel: record["kernel-release"] ? String(record["kernel-release"]) : null,
  }
}

/**
 * The `get-host-name` payload.
 *
 * The agent reports `host-name`, hyphenated, on both engines. Reading a flat
 * `name` yields an empty string, and an empty hostname is not cosmetic: every
 * change-driven plan then believes a rename is needed, because it cannot prove
 * the server already has the name it was asked for.
 */
export function parseHostname(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const record = payload as Record<string, any>
  return String(record["host-name"] ?? record.name ?? "").trim()
}

/**
 * The `get-timezone` payload.
 *
 * The key is `zone`, not `timezone`. Reading the wrong one reports every server
 * as having no timezone set, which makes a timezone change look un-applied every
 * time it is checked.
 */
export function parseTimezone(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const record = payload as Record<string, any>
  return String(record.zone ?? record.timezone ?? "").trim()
}

export function parseNativeUsers(payload: unknown): Array<{ name: string; uid?: number | null; shell?: string | null; home?: string | null }> {
  const raw = unwrapAgentPayload(payload)
  const users: Array<{ name: string; uid?: number | null; shell?: string | null; home?: string | null }> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, any>
    // Windows reports `user`; Linux builds vary between `user` and `name`.
    const name = String(record.name ?? record.user ?? "").trim()
    if (!name) continue
    users.push({
      name,
      uid: Number.isFinite(Number(record.uid)) ? Number(record.uid) : null,
      shell: record.shell ? String(record.shell) : null,
      home: record.home ? String(record.home) : null,
    })
  }
  return users
}

/**
 * `get-fsinfo` payload shape, as the agent actually sends it.
 *
 * ```
 * { result: [ { mountpoint, type, name,
 *                total-bytes, used-bytes,
 *                disk: [ { dev, serial, bus, ... } ] } ] }
 * ```
 *
 * The sizes live on the **filesystem** entry. The `disk` array is a list of
 * backing devices and carries identity only — no sizes at all. Reading
 * `total-bytes` off the disk object, which is the obvious reading, finds
 * nothing and produces an empty filesystem list on every guest, which presents
 * as "this server reports no disks" rather than as a parsing fault.
 */
export function parseNativeFsInfo(payload: unknown): Array<{ name: string; mountpoint: string | null; totalBytes: number; usedBytes: number; freeBytes: number; type: string | null }> {
  const raw = unwrapAgentPayload(payload)
  const out: Array<{ name: string; mountpoint: string | null; totalBytes: number; usedBytes: number; freeBytes: number; type: string | null }> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, any>
    const total = bytes(record["total-bytes"])
    const used = bytes(record["used-bytes"])
    if (!(total > 0)) continue
    const remainingRaw = record["remaining-bytes"]
    const remaining = Number.isFinite(Number(remainingRaw)) ? bytes(remainingRaw) : 0
    // The device name when the agent gives one, else the filesystem's own name.
    // `/dev/sda1` is more useful to a human than `sda1`, and it is what the
    // disk templates interpolate as {{NIC}}-adjacent values elsewhere.
    const backing = Array.isArray(record.disk) ? record.disk[0] : Array.isArray(record.disks) ? record.disks[0] : null
    const device = backing?.dev ? String(backing.dev) : null
    out.push({
      name: device || String(record.name ?? record.alias ?? ""),
      mountpoint: record.mountpoint ? String(record.mountpoint) : null,
      totalBytes: total,
      usedBytes: used,
      freeBytes: remaining || Math.max(0, total - used),
      type: record.type ? String(record.type) : (Array.isArray(record["fs-type"]) ? (record["fs-type"] as string[]).join(",") : record["fs-type"] ? String(record["fs-type"]) : null),
    })
  }
  return out
}

/**
 * Accept either the payload itself or the `{ result: payload }` wrapper.
 *
 * Every `agent/<verb>` response is wrapped. Callers that reach a parser
 * through `guestNative` get the unwrapped payload; a caller holding a raw
 * response does not. Both should work, because a parser that only accepts one
 * of them fails silently on the other.
 */
function unwrapAgentPayload(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, any>
    if (Array.isArray(record.result)) return record.result
    if (Array.isArray(record.data)) return record.data
    if (record.data && typeof record.data === "object" && Array.isArray(record.data.result)) return record.data.result
  }
  return []
}
