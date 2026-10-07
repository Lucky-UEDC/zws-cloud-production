/**
 * Built-in OS profiles.
 *
 * These are seeded into `guest_os_templates` + `guest_operation_templates` so a
 * fresh install has working automation for the common distributions, and so an
 * admin has a concrete example to copy when adding a new OS. An admin-created
 * template is an ordinary database row: nothing here is referenced by id from
 * application code, which is what keeps "add an OS" a configuration task.
 *
 * Two hard rules are encoded in every profile:
 *  1. The shell must match the engine. Linux profiles use `linux-sh` /
 *     `linux-bash`; Windows profiles use `windows-powershell` / `windows-cmd`.
 *  2. The collector is the canonical one for the engine: `df -B1 -P` on Linux,
 *     `Get-CimInstance Win32_LogicalDisk` on Windows.
 */

import type { GuestEngine } from "./constants"

export type SeedOperation = {
  operation: string
  enabled?: boolean
  commandType?: "guest-native" | "guest-exec"
  /**
   * Only meaningful for `guest-exec`. A `guest-native` operation is dispatched
   * to the agent as a verb name with no shell involved, so the seed omits it and
   * the column falls back to the engine default.
   */
  shell?: string
  command: string | null
  timeoutSeconds: number
  requiresRunning?: boolean
  requiresStopped?: boolean
  requiresGuestAgent?: boolean
  rebootRequired?: boolean
  dangerLevel?: "safe" | "caution" | "dangerous"
  requiresConfirmation?: boolean
  supportsRollback?: boolean
  verificationRequired?: boolean
  verificationCommand?: string | null
  verificationParser?: string | null
  verificationArgs?: Record<string, unknown>
  successCondition?: string | null
  rollbackCommand?: string | null
  rollbackArguments?: unknown[] | null
  stateKey?: string | null
  notes?: string | null
  fallbacks?: Array<{ command: string; notes?: string; verificationParser?: string | null; shell?: string }>
}

/**
 * The OS ids each family actually reports from `get-osinfo`.
 *
 * These are the strings templates are matched on, so they have to be the strings
 * the agent emits — not the names a vendor uses on its website. Two families
 * were wrong before this was checked against real guests:
 *
 * - Windows reports `mswindows`. A template claiming only `windows` matches no
 *   real Windows guest, so every Windows server said "this operating system is
 *   not yet supported" while the platform appeared correctly configured.
 * - The RHEL family list contained a duplicated entry, which matched nothing
 *   but made the stored `osIds` array look wrong in the editor.
 */
const WINDOWS_OS_IDS = [
  "mswindows", "windows", "win32", "win64", "winnt", "win",
  "microsoft-windows", "windows-server", "srv",
]

const RHEL_OS_IDS = ["rhel", "redhat", "rocky", "rocky-linux", "almalinux", "centos", "centos-stream", "ol", "oracle", "fedora"]

const RHEL_OS_IDS_WITHOUT_CENTOS = RHEL_OS_IDS.filter((id) => id !== "centos" && id !== "centos-stream")

export type SeedTemplate = {
  slug: string
  name: string
  family: string
  engine: GuestEngine
  osIds: string[]
  versionPattern?: string | null
  priority: number
  description: string
  enabled: boolean
  operations: SeedOperation[]
}

/**
 * The canonical disk collector for each engine. Both are `guest-exec` because
 * the QGA has no portable per-filesystem-usage verb, but the command and parser
 * are strictly engine-specific.
 */
const LINUX_DISK_OPERATIONS: SeedOperation[] = [
  {
    operation: "disk_usage",
    shell: "linux-sh",
    command: "df -B1 -P",
    timeoutSeconds: 30,
    verificationRequired: true,
    verificationCommand: "df -B1 -P",
    verificationParser: "df-posix",
    successCondition: "exit-code-0",
    stateKey: "disk.usage",
    notes: "Byte-exact, one line per filesystem.",
  },
  {
    operation: "disk_usage_all",
    shell: "linux-sh",
    command: "df -B1 -P",
    timeoutSeconds: 30,
    verificationRequired: true,
    verificationCommand: "df -B1 -P",
    verificationParser: "df-posix",
    successCondition: "exit-code-0",
    notes: "All real filesystems; pseudo filesystems are filtered by the parser.",
  },
]

const WINDOWS_DISK_OPERATIONS: SeedOperation[] = [
  {
    operation: "disk_usage",
    shell: "windows-powershell",
    command:
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,DriveType,Size,FreeSpace,FileSystem,VolumeName | ConvertTo-Json -Compress',
    timeoutSeconds: 45,
    verificationRequired: true,
    verificationCommand: null,
    verificationParser: "win-logicaldisk",
    successCondition: "exit-code-0",
    stateKey: "disk.usage",
    notes: "CIM/WMI. Fixed drives only, so CD and removable media are excluded.",
    fallbacks: [
      { command: 'fsutil volume diskfree C:', notes: "Legacy Windows without Get-CimInstance.", verificationParser: "fsutil-list" },
    ],
  },
  {
    operation: "disk_usage_all",
    shell: "windows-powershell",
    command:
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,DriveType,Size,FreeSpace,FileSystem,VolumeName | ConvertTo-Json -Compress',
    timeoutSeconds: 45,
    verificationRequired: true,
    verificationParser: "win-logicaldisk",
    successCondition: "exit-code-0",
    notes: "All fixed volumes; the system drive is selected for the headline figure.",
    fallbacks: [
      { command: "wmic logicaldisk get DeviceID,Size,FreeSpace /format:list", notes: "Legacy wmic collector.", verificationParser: null },
    ],
  },
]

/** Native verbs, shared by both engines. */
/**
 * Verbs the QEMU Guest Agent implements directly. These are shared verbatim by
 * every Linux and Windows template: no shell is involved, so no engine-specific
 * network tooling is duplicated and the agent's own implementation stays the
 * single source of truth.
 */
const NATIVE_OPERATIONS: SeedOperation[] = [
  { operation: "detect_os", commandType: "guest-native", command: "get-osinfo", timeoutSeconds: 15, verificationRequired: true, verificationCommand: "get-osinfo", verificationParser: "native-osinfo", notes: "Authoritative OS discovery." },
  { operation: "detect_network", commandType: "guest-native", command: "network-get-interfaces", timeoutSeconds: 15, verificationRequired: true, verificationCommand: "network-get-interfaces", verificationParser: "native-interfaces", notes: "Never assume eth0/ens18/Ethernet." },
  { operation: "detect_filesystem", commandType: "guest-native", command: "get-fsinfo", timeoutSeconds: 15, verificationRequired: true, verificationCommand: "get-fsinfo", verificationParser: "native-fsinfo", notes: "Mountpoints and filesystem types." },
  { operation: "guest_health", commandType: "guest-native", command: "get-time", timeoutSeconds: 15, verificationRequired: true, verificationCommand: "get-time", verificationParser: "native-json", notes: "Agent round-trip proves the channel is alive." },
]

/**
 * Apply whatever the guest actually offers, in the order Debian and Ubuntu
 * have historically offered it.
 *
 * The chain ends in `|| true` on purpose: the image decides which of these
 * exists (ifupdown, netplan, neither), and a missing one is not a failure of
 * this operation. What decides success is the verification read that follows --
 * `network-get-interfaces` plus the expected address -- so a config that was
 * written but never applied still fails the step instead of being reported as
 * done. Failing the command here instead would fail images that simply name
 * the unit differently.
 */
const DEBIAN_APPLY_NETWORK =
  "systemctl reload-or-restart networking 2>/dev/null || systemctl restart networking 2>/dev/null || ifup {{NIC}} 2>/dev/null || netplan apply 2>/dev/null || true"

/** Debian/Ubuntu family network configuration via ifupdown (Ubuntu 20.04/22.04). */
const DEBIAN_NETWORK: SeedOperation[] = [
  {
    operation: "set_ip",
    shell: "linux-sh",
    // `mkdir -p` is load-bearing, not tidiness: on a netplan image
    // /etc/network/interfaces.d does not exist, and writing into a missing
    // directory is a hard exit 2 that fails the whole first-boot chain. Found
    // on a real clone of template 1002 (Ubuntu-22-04), which is exactly the
    // image this profile claims.
    command:
      "set -e; D=/etc/network/interfaces.d; mkdir -p \"$D\"; printf 'auto {{NIC}}\\niface {{NIC}} inet static\\n    address {{IP}}/{{PREFIX}}\\n    gateway {{GATEWAY}}\\n' > \"$D/{{NIC}}\"; " +
      DEBIAN_APPLY_NETWORK,
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    requiresConfirmation: false,
    supportsRollback: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    rollbackCommand:
      "set -e; D=/etc/network/interfaces.d; mkdir -p \"$D\"; printf 'auto {{NIC}}\\niface {{NIC}} inet dhcp\\n' > \"$D/{{NIC}}\"; " +
      DEBIAN_APPLY_NETWORK,
    stateKey: "network.ipv4",
    notes: "Static address on the discovered interface. Verified through the guest agent.",
  },
  {
    operation: "set_gateway",
    shell: "linux-sh",
    command:
      "set -e; D=/etc/network/interfaces.d; mkdir -p \"$D\"; F=\"$D/{{NIC}}\"; printf 'auto {{NIC}}\\niface {{NIC}} inet static\\n    address {{IP}}/{{PREFIX}}\\n' > \"$F\"; printf '    gateway {{GATEWAY}}\\n' >> \"$F\"; " +
      DEBIAN_APPLY_NETWORK,
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    stateKey: "network.gateway",
    // Rewrites the whole stanza rather than sed-ing one line out of it: a
    // second pass must not accumulate duplicate gateway lines, and a missing
    // file must not depend on one already existing.
    notes: "Gateway stanza is rewritten wholesale so repeated runs stay idempotent.",
  },
  {
    operation: "set_dns",
    shell: "linux-sh",
    // resolvectl first, because on a systemd-resolved image it is what actually
    // owns the setting and /etc/resolv.conf is only a stub symlink into /run.
    // The write covers ifupdown images, where that symlink does not exist.
    //
    // The last clause is the verification that counts: it asserts the
    // nameserver is actually readable back, through whichever mechanism owns it.
    // With no resolver configured the panel would have reported a DNS step as
    // succeeded while the guest could not resolve anything.
    command:
      "set -e; if command -v resolvectl >/dev/null 2>&1; then resolvectl dns {{NIC}} {{DNS1}} >/dev/null 2>&1 || true; fi; printf 'nameserver {{DNS1}}\\n' > /etc/resolv.conf; " +
      DEBIAN_APPLY_NETWORK +
      "; (resolvectl dns {{NIC}} 2>/dev/null || cat /etc/resolv.conf) | grep '{{DNS1}}'",
    timeoutSeconds: 60,
    dangerLevel: "safe",
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-time",
    verificationParser: "exit-code",
    stateKey: "network.dns",
    notes: "Nameserver written to both the resolver and /etc/resolv.conf, then read back to confirm it landed.",
  },
]

/** Ubuntu 24.04+ uses netplan rather than ifupdown. */
const UBUNTU_NETPLAN_NETWORK: SeedOperation[] = [
  {
    operation: "set_ip",
    shell: "linux-sh",
    command:
      "set -e; F=/etc/netplan/99-zws.yaml; printf 'network:\\n  version: 2\\n  ethernets:\\n    {{NIC}}:\\n      dhcp4: no\\n      addresses: [{{IP}}/{{PREFIX}}]\\n      routes:\\n        - to: default\\n          via: {{GATEWAY}}\\n' > \"$F\"; chmod 600 \"$F\"; netplan apply",
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    supportsRollback: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    rollbackCommand: "set -e; rm -f /etc/netplan/99-zws.yaml; netplan apply",
    stateKey: "network.ipv4",
    notes: "Netplan renderer; YAML is chmod 600 as netplan requires.",
  },
  {
    operation: "set_gateway",
    shell: "linux-sh",
    command:
    // Previously this used a separately escaped copy of the document that
    // emitted a literal backslash before each newline, so the YAML it wrote
    // was malformed. It now writes the same document as set_ip, which is
    // what the default route belongs to.
      "set -e; F=/etc/netplan/99-zws.yaml; printf 'network:\\n  version: 2\\n  ethernets:\\n    {{NIC}}:\\n      dhcp4: no\\n      addresses: [{{IP}}/{{PREFIX}}]\\n      routes:\\n        - to: default\\n          via: {{GATEWAY}}\\n' > \"$F\"; chmod 600 \"$F\"; netplan apply",
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    supportsRollback: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    rollbackCommand: "set -e; rm -f /etc/netplan/99-zws.yaml; netplan apply",
    stateKey: "network.gateway",
    notes: "The default route is written into netplan, then applied.",
  },
  {
    operation: "set_dns",
    shell: "linux-sh",
    // A separate document, and never the address document. Netplan merges
    // per key, so a nameserver-only file adds `nameservers` without touching
    // `addresses`. The previous version overwrote 99-zws.yaml with
    // `dhcp4: true` and no address, which silently undid the static address
    // that set_ip and set_gateway had just applied: a server that passed its
    // IP verification and then lost the address as soon as DNS was set.
    command:
      "set -e; D=/etc/netplan; mkdir -p \"$D\"; F=$D/98-zws-dns.yaml; printf 'network:\\n  version: 2\\n  ethernets:\\n    {{NIC}}:\\n      dhcp4: no\\n      nameservers:\\n        addresses: [{{DNS1}}]\\n' > \"$F\"; chmod 600 \"$F\"; netplan apply; (netplan get 2>/dev/null; resolvectl dns {{NIC}} 2>/dev/null; cat /etc/resolv.conf) | grep '{{DNS1}}'",
    timeoutSeconds: 60,
    requiresRunning: true,
    verificationRequired: true,
    rollbackCommand: "set -e; rm -f /etc/netplan/98-zws-dns.yaml; netplan apply",
    verificationCommand: "get-time",
    verificationParser: "exit-code",
    stateKey: "network.dns",
  },
]

/** RHEL family: network-scripts / NetworkManager. */
const RHEL_NETWORK: SeedOperation[] = [
  {
    operation: "set_ip",
    shell: "linux-sh",
    command:
      "set -e; F=/etc/sysconfig/network-scripts/ifcfg-{{NIC}}; printf 'DEVICE={{NIC}}\\nBOOTPROTO=none\\nIPADDR={{IP}}\\nPREFIX={{PREFIX}}\\nGATEWAY={{GATEWAY}}\\n' > \"$F\"; systemctl restart NetworkManager",
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    supportsRollback: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    rollbackCommand: "set -e; rm -f /etc/sysconfig/network-scripts/ifcfg-{{NIC}}; systemctl restart NetworkManager",
    stateKey: "network.ipv4",
    notes: "CentOS/Rocky/Alma 8-9 network-scripts layout.",
  },
  {
    operation: "set_gateway",
    shell: "linux-sh",
    command: "set -e; nmcli con mod {{NIC}} ipv4.gateway {{GATEWAY}}; nmcli con up {{NIC}}",
    timeoutSeconds: 60,
    dangerLevel: "caution",
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "network-get-interfaces",
    verificationParser: "native-interfaces",
    stateKey: "network.gateway",
  },
  {
    operation: "set_dns",
    shell: "linux-sh",
    command: "set -e; nmcli con mod {{NIC}} ipv4.dns '{{DNS1}}'; nmcli con up {{NIC}}",
    timeoutSeconds: 60,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-time",
    verificationParser: "exit-code",
    stateKey: "network.dns",
  },
]

/** Shared user + host operations for every Linux profile. */
const LINUX_ACCESS: SeedOperation[] = [
  {
    operation: "set_password",
    shell: "linux-sh",
    command: "read -r SECRET; printf '%s:%s\\n' '{{USERNAME}}' \"$SECRET\" | chpasswd",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
    stateKey: "access.password",
    notes: "Password arrives on stdin, never in argv. The template only reads it.",
  },
  {
    operation: "create_user",
    shell: "linux-sh",
    command: "read -r SECRET; id -u '{{USERNAME}}' >/dev/null 2>&1 || useradd -m -s /bin/bash '{{USERNAME}}'; printf '%s:%s\\n' '{{USERNAME}}' \"$SECRET\" | chpasswd",
    timeoutSeconds: 45,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
    stateKey: "access.user",
    notes: "Idempotent: an existing account is reused rather than recreated.",
  },
  {
    operation: "update_user",
    shell: "linux-sh",
    // Refuses rather than creates. An "update" that silently made a missing
    // account would hide the real problem — the customer asked to change an
    // account that is not there.
    command: "set -e; id -u '{{USERNAME}}' >/dev/null 2>&1 || { echo 'user {{USERNAME}} does not exist' >&2; exit 3; }; usermod -s /bin/bash '{{USERNAME}}'; passwd -l '{{USERNAME}}' >/dev/null 2>&1 || true; passwd -u '{{USERNAME}}' >/dev/null 2>&1 || true",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
    stateKey: "access.user",
    notes: "Refuses if the account does not exist. Re-enables a locked account and normalises its shell.",
  },
  {
    operation: "enable_user",
    shell: "linux-sh",
    command: "set -e; usermod -U '{{USERNAME}}' 2>/dev/null || passwd -u '{{USERNAME}}'",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
  },
  {
    operation: "disable_user",
    shell: "linux-sh",
    command: "set -e; passwd -l '{{USERNAME}}'",
    timeoutSeconds: 30,
    requiresRunning: true,
    dangerLevel: "dangerous",
    requiresConfirmation: true,
    supportsRollback: true,
    verificationRequired: false,
    rollbackCommand: "set -e; passwd -u '{{USERNAME}}'",
    stateKey: "access.enabled",
    notes: "Locks the account. Reversible via the rollback command.",
  },
  {
    operation: "delete_user",
    shell: "linux-sh",
    command: "set -e; userdel -r '{{USERNAME}}'",
    timeoutSeconds: 45,
    requiresRunning: true,
    dangerLevel: "dangerous",
    requiresConfirmation: true,
    verificationRequired: false,
    notes: "Irreversible. Never retried automatically.",
  },
  {
    operation: "set_hostname",
    shell: "linux-sh",
    command: "set -e; hostnamectl set-hostname '{{HOSTNAME}}'",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-host-name",
    verificationParser: "native-hostname",
    stateKey: "system.hostname",
  },
  {
    operation: "enable_ssh",
    shell: "linux-sh",
    command: "set -e; systemctl enable --now sshd 2>/dev/null || systemctl enable --now ssh",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "access.ssh",
  },
  {
    operation: "timezone",
    shell: "linux-sh",
    command: "set -e; timedatectl set-timezone '{{TIMEZONE}}' 2>/dev/null || ln -sf /usr/share/zoneinfo/{{TIMEZONE}} /etc/localtime",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-timezone",
    verificationParser: "native-json",
    stateKey: "system.timezone",
  },
  {
    operation: "firewall",
    shell: "linux-sh",
    command: "set -e; if command -v ufw >/dev/null 2>&1; then ufw --force enable; elif command -v firewall-cmd >/dev/null 2>&1; then systemctl enable --now firewalld; fi",
    timeoutSeconds: 45,
    requiresRunning: true,
    dangerLevel: "caution",
    requiresConfirmation: false,
    verificationRequired: false,
    stateKey: "security.firewall",
  },
  {
    operation: "filesystem_grow",
    shell: "linux-sh",
    command: "set -e; ROOT=$(findmnt -no SOURCE /); growpart $(lsblk -no PKNAME $ROOT 2>/dev/null || echo sda) 1 2>/dev/null || true; resize2fs $ROOT 2>/dev/null || xfs_growfs / 2>/dev/null || true",
    timeoutSeconds: 120,
    requiresRunning: true,
    dangerLevel: "caution",
    verificationRequired: false,
    rebootRequired: true,
    stateKey: "disk.filesystem",
    notes: "Grows the root filesystem after the virtual disk was enlarged.",
  },
  {
    operation: "disk_resize",
    shell: "linux-sh",
    command: "set -e; ROOT=$(findmnt -no SOURCE /); growpart $(lsblk -no PKNAME $ROOT 2>/dev/null || echo sda) 1 2>/dev/null || true; partprobe 2>/dev/null || true",
    timeoutSeconds: 60,
    requiresRunning: false,
    requiresStopped: true,
    dangerLevel: "caution",
    verificationRequired: false,
    stateKey: "disk.partition",
    notes: "Partition table grow. Performed with the VM stopped.",
  },
  {
    operation: "reboot",
    shell: "linux-sh",
    command: "nohup sh -c 'sleep 1' >/dev/null 2>&1 &",
    timeoutSeconds: 15,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "power",
    notes: "The Proxmox API issues the reboot; this step is a placeholder for templates that prefer a guest-side trigger.",
  },
  {
    operation: "shutdown",
    shell: "linux-sh",
    command: "nohup sh -c 'sleep 1' >/dev/null 2>&1 &",
    timeoutSeconds: 15,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "power",
  },
]

/** Windows access + host operations. Never contains a Linux token. */
const WINDOWS_ACCESS: SeedOperation[] = [
  {
    operation: "set_password",
    commandType: "guest-exec",
    shell: "windows-cmd",
    command: "net user {{USERNAME}} {{PASSWORD}}",
    timeoutSeconds: 45,
    requiresRunning: true,
    requiresGuestAgent: true,
    dangerLevel: "safe",
    requiresConfirmation: false,
    supportsRollback: false,
    verificationRequired: true,
    verificationCommand: "net user {{USERNAME}}",
    verificationParser: "cmd-output-contains",
    verificationArgs: { expected: "The command completed successfully" },
    successCondition: "exit-code-0",
    rollbackCommand: null,
    rollbackArguments: null,
    fallbacks: [
      {
        notes: "Fallback to PowerShell if cmd fails.",
        command: "net user {{USERNAME}} {{PASSWORD}}",
        shell: "windows-powershell",
      },
    ],
    stateKey: "access.password",
    notes: "Uses net user via guest-exec. Native QGA set-user-password verb is unreliable on Windows Server 2022. USERNAME defaults to Administrator.",
  },
  {
    operation: "create_user",
    shell: "windows-powershell",
    command:
      "$ErrorActionPreference='Stop'; $p = ConvertTo-SecureString -String $env:ZWS_SECRET -AsPlainText -Force; if (-not (Get-LocalUser -Name '{{USERNAME}}' -ErrorAction SilentlyContinue)) { New-LocalUser -Name '{{USERNAME}}' -Password $p -PasswordNeverExpires } else { Set-LocalUser -Name '{{USERNAME}}' -Password $p }; Add-LocalGroupMember -Group 'Administrators' -Member '{{USERNAME}}' -ErrorAction SilentlyContinue",
    timeoutSeconds: 60,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
    stateKey: "access.user",
    notes: "Idempotent: an existing account is updated instead of recreated.",
  },
  {
    operation: "update_user",
    shell: "windows-powershell",
    // Same rule as the Linux one: refuse a missing account rather than making it.
    command:
      "$ErrorActionPreference='Stop'; if (-not (Get-LocalUser -Name '{{USERNAME}}' -ErrorAction SilentlyContinue)) { Write-Error 'user {{USERNAME}} does not exist'; exit 3 }; Set-LocalUser -Name '{{USERNAME}}' -Enabled $true; Add-LocalGroupMember -Group 'Administrators' -Member '{{USERNAME}}' -ErrorAction SilentlyContinue",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
    stateKey: "access.user",
    notes: "Refuses if the account does not exist. Re-enables a disabled account and restores its group membership.",
  },
  {
    operation: "enable_user",
    shell: "windows-powershell",
    command: "Set-LocalUser -Name '{{USERNAME}}' -Enabled $true",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-users",
    verificationParser: "native-users",
  },
  {
    operation: "disable_user",
    shell: "windows-powershell",
    command: "Disable-LocalUser -Name '{{USERNAME}}'",
    timeoutSeconds: 30,
    requiresRunning: true,
    dangerLevel: "dangerous",
    requiresConfirmation: true,
    supportsRollback: true,
    verificationRequired: false,
    rollbackCommand: "Enable-LocalUser -Name '{{USERNAME}}'",
    stateKey: "access.enabled",
  },
  {
    operation: "delete_user",
    shell: "windows-powershell",
    command: "Remove-LocalUser -Name '{{USERNAME}}'",
    timeoutSeconds: 45,
    requiresRunning: true,
    dangerLevel: "dangerous",
    requiresConfirmation: true,
    verificationRequired: false,
    notes: "Irreversible.",
  },
  {
    operation: "set_hostname",
    shell: "windows-powershell",
    command: "Rename-Computer -NewName '{{HOSTNAME}}' -Force -Restart",
    timeoutSeconds: 60,
    requiresRunning: true,
    rebootRequired: true,
    dangerLevel: "caution",
    verificationRequired: false,
    stateKey: "system.hostname",
    notes: "Windows requires a restart for a hostname rename to take effect.",
  },
  {
    operation: "enable_rdp",
    shell: "windows-powershell",
    command: "Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name 'fDenyTSConnections' -Value 0; Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue",
    timeoutSeconds: 45,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "access.rdp",
  },
  {
    operation: "timezone",
    shell: "windows-powershell",
    command: "Set-TimeZone -Id '{{TIMEZONE}}'",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "get-timezone",
    verificationParser: "native-json",
    stateKey: "system.timezone",
  },
  {
    operation: "firewall",
    shell: "windows-powershell",
    command: "Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True",
    timeoutSeconds: 30,
    requiresRunning: true,
    dangerLevel: "caution",
    verificationRequired: false,
    stateKey: "security.firewall",
  },
  {
    operation: "filesystem_grow",
    shell: "windows-powershell",
    command: "Get-Volume | Where-Object DriveLetter | ForEach-Object { $d = 'D:' + $_.DriveLetter; Start-Process -NoNewWindow -Wait -FilePath 'diskpart' -ArgumentList \"/s `\\\"select volume $($_.DriveLetter):`\\\" / `\\\"extend`\\\"`\" }",
    timeoutSeconds: 120,
    requiresRunning: true,
    dangerLevel: "caution",
    verificationRequired: false,
    stateKey: "disk.filesystem",
    notes: "Extends fixed volumes after the virtual disk was enlarged.",
  },
  {
    operation: "disk_resize",
    shell: "windows-powershell",
    command: "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, Size, SizeRemaining",
    timeoutSeconds: 45,
    requiresRunning: false,
    requiresStopped: true,
    verificationRequired: true,
    verificationCommand: "get-fsinfo",
    verificationParser: "native-fsinfo",
    stateKey: "disk.partition",
    notes: "Read-only volume report used while the VM is stopped.",
  },
  {
    operation: "reboot",
    shell: "windows-powershell",
    command: "Restart-Computer -Force",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "power",
  },
  {
    operation: "shutdown",
    shell: "windows-powershell",
    command: "Stop-Computer -Force",
    timeoutSeconds: 30,
    requiresRunning: true,
    verificationRequired: false,
    stateKey: "power",
  },
]

/** Windows network configuration via PowerShell with dynamic adapter discovery.
 *  Each operation is separate to avoid QGA command length limits and ensure reliability. */
const WINDOWS_NETWORK: SeedOperation[] = [
  {
    operation: "set_ip",
    shell: "windows-powershell",
    command:
      '$ErrorActionPreference="Stop"; $a=(Get-NetAdapter|Where-Object{$_.Status -eq "Up" -and $_.HardwareInterface})|Select-Object -First 1 ifIndex,Name; if(-not $a){throw "WINDOWS_NETWORK_ADAPTER_NOT_FOUND"}; $idx=$a.ifIndex; $cur=(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object{$_.PrefixOrigin -ne "WellKnown"}).IPAddress; if($cur){Remove-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue}; New-NetIPAddress -InterfaceIndex $idx -IPAddress "{{IP}}" -PrefixLength {{PREFIX}}',
    timeoutSeconds: 60,
    requiresRunning: true,
    dangerLevel: "caution",
    supportsRollback: true,
    verificationRequired: true,
    verificationCommand: "Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 | Select-Object IPAddress,PrefixLength,InterfaceIndex | ConvertTo-Json -Compress",
    verificationParser: "native-json",
    rollbackCommand: "Remove-NetIPAddress -InterfaceIndex $idx -IPAddress '{{IP}}' -Confirm:$false -ErrorAction SilentlyContinue",
    stateKey: "network.ipv4",
    notes: "Interface discovered dynamically via Get-NetAdapter. Only IP address is configured here.",
  },
  {
    operation: "set_gateway",
    shell: "windows-powershell",
    command: '$ErrorActionPreference="Stop"; $a=(Get-NetAdapter|Where-Object{$_.Status -eq "Up" -and $_.HardwareInterface})|Select-Object -First 1 ifIndex,Name; if(-not $a){throw "WINDOWS_NETWORK_ADAPTER_NOT_FOUND"}; $idx=$a.ifIndex; Remove-NetRoute -InterfaceIndex $idx -DestinationPrefix "0.0.0.0/0" -Confirm:$false -ErrorAction SilentlyContinue; New-NetRoute -InterfaceIndex $idx -DestinationPrefix "0.0.0.0/0" -NextHop "{{GATEWAY}}"',
    timeoutSeconds: 60,
    requiresRunning: true,
    dangerLevel: "caution",
    verificationRequired: true,
    verificationCommand: "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -InterfaceIndex $idx | Select-Object NextHop,InterfaceIndex | ConvertTo-Json -Compress",
    verificationParser: "native-json",
    stateKey: "network.gateway",
  },
  {
    operation: "set_dns",
    shell: "windows-powershell",
    command: '$ErrorActionPreference="Stop"; $a=(Get-NetAdapter|Where-Object{$_.Status -eq "Up" -and $_.HardwareInterface})|Select-Object -First 1 ifIndex,Name; if(-not $a){throw "WINDOWS_NETWORK_ADAPTER_NOT_FOUND"}; $idx=$a.ifIndex; Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses "8.8.8.8","1.1.1.1"',
    timeoutSeconds: 45,
    requiresRunning: true,
    verificationRequired: true,
    verificationCommand: "Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4 | Select-Object InterfaceIndex,ServerAddresses | ConvertTo-Json -Compress",
    verificationParser: "native-json",
    stateKey: "network.dns",
  },
]

function linuxTemplate(input: Omit<SeedTemplate, "engine" | "operations"> & { operations: SeedOperation[] }): SeedTemplate {
  return { ...input, engine: "linux", operations: [...NATIVE_OPERATIONS, ...input.operations, ...LINUX_DISK_OPERATIONS, ...LINUX_ACCESS] }
}

function windowsTemplate(input: Omit<SeedTemplate, "engine" | "operations"> & { operations: SeedOperation[] }): SeedTemplate {
  return { ...input, engine: "windows", operations: [...NATIVE_OPERATIONS, ...input.operations, ...WINDOWS_DISK_OPERATIONS, ...WINDOWS_ACCESS] }
}

export const DEFAULT_GUEST_TEMPLATES: SeedTemplate[] = [
  // ---- Debian family (ifupdown) -------------------------------------------
  linuxTemplate({
    slug: "debian-11",
    name: "Debian 11",
    family: "debian",
    osIds: ["debian"],
    versionPattern: "^11(\\D|$)",
    priority: 300,
    description: "Debian 11 (bullseye) with ifupdown networking.",
    enabled: true,
    operations: DEBIAN_NETWORK,
  }),
  linuxTemplate({
    slug: "debian-12",
    name: "Debian 12",
    family: "debian",
    osIds: ["debian"],
    versionPattern: "^12(\\D|$)",
    priority: 310,
    description: "Debian 12 (bookworm) with ifupdown networking.",
    enabled: true,
    operations: DEBIAN_NETWORK,
  }),

  // ---- Ubuntu family ------------------------------------------------------
  linuxTemplate({
    slug: "ubuntu-2004-2204",
    name: "Ubuntu 20.04 / 22.04",
    family: "ubuntu",
    osIds: ["ubuntu"],
    versionPattern: "^(20|22)(\\D|$)",
    priority: 320,
    // Ubuntu has been netplan-by-default since 18.04. This profile previously
    // claimed ifupdown, which wrote /etc/network/interfaces.d -- a directory
    // that does not exist on these images, and a configuration nothing on them
    // reads. A real clone of template 1002 (Ubuntu 22.04) took set_ip through a
    // directory error, then failed verification with "Expected address
    // 103.216.170.238 was not reported by the guest" once the write succeeded:
    // the file was written and nothing ever applied it. Verification caught it,
    // which is the point of verifying.
    description: "Ubuntu 20.04/22.04 LTS with netplan networking.",
    enabled: true,
    operations: UBUNTU_NETPLAN_NETWORK,
  }),
  linuxTemplate({
    slug: "ubuntu-24-04",
    name: "Ubuntu 24.04 LTS",
    family: "ubuntu",
    osIds: ["ubuntu"],
    versionPattern: "^24(\\D|$)",
    priority: 340,
    description: "Ubuntu 24.04 LTS with netplan networking.",
    enabled: true,
    operations: UBUNTU_NETPLAN_NETWORK,
  }),

  // ---- RHEL family --------------------------------------------------------
  linuxTemplate({
    slug: "rhel-8",
    name: "RHEL / Rocky / Alma 8",
    family: "rhel",
    osIds: RHEL_OS_IDS,
    versionPattern: "^8(\\D|$)",
    priority: 300,
    description: "RHEL-compatible 8 using network-scripts and NetworkManager.",
    enabled: true,
    operations: RHEL_NETWORK,
  }),
  linuxTemplate({
    slug: "rhel-9",
    name: "RHEL / Rocky / Alma 9",
    family: "rhel",
    osIds: RHEL_OS_IDS,
    versionPattern: "^9(\\D|$)",
    priority: 310,
    description: "RHEL-compatible 9 using network-scripts and NetworkManager.",
    enabled: true,
    operations: RHEL_NETWORK,
  }),
  linuxTemplate({
    slug: "rhel-10",
    name: "RHEL / Rocky / Alma 10",
    family: "rhel",
    osIds: RHEL_OS_IDS_WITHOUT_CENTOS,
    versionPattern: "^10(\\D|$)",
    priority: 320,
    description: "RHEL-compatible 10.",
    enabled: true,
    operations: RHEL_NETWORK,
  }),
  linuxTemplate({
    slug: "centos-7",
    name: "CentOS 7",
    family: "centos",
    osIds: ["centos"],
    versionPattern: "^7(\\D|$)",
    priority: 200,
    description: "CentOS 7 (EOL) using network-scripts only.",
    enabled: true,
    operations: RHEL_NETWORK,
  }),

  // ---- Windows family -----------------------------------------------------
  windowsTemplate({
    slug: "windows-server-2019",
    name: "Windows Server 2019",
    family: "windows",
    osIds: WINDOWS_OS_IDS,
    versionPattern: "2019|10\\.0\\.17763",
    priority: 300,
    description: "Windows Server 2019 with PowerShell/CIM and netsh.",
    enabled: true,
    operations: WINDOWS_NETWORK,
  }),
  windowsTemplate({
    slug: "windows-server-2022",
    name: "Windows Server 2022",
    family: "windows",
    osIds: WINDOWS_OS_IDS,
    versionPattern: "2022|10\\.0\\.20348",
    priority: 310,
    description: "Windows Server 2022 with PowerShell/CIM and netsh.",
    enabled: true,
    operations: WINDOWS_NETWORK,
  }),
  windowsTemplate({
    slug: "windows-server-2025",
    name: "Windows Server 2025",
    family: "windows",
    osIds: WINDOWS_OS_IDS,
    versionPattern: "2025|10\\.0\\.26100",
    priority: 320,
    description: "Windows Server 2025 with PowerShell/CIM and netsh.",
    enabled: true,
    operations: WINDOWS_NETWORK,
  }),
]

/** Guest-agent install hints surfaced on the template page. */
/**
 * How to install the QEMU Guest Agent inside each supported image.
 *
 * Shown to an admin adding a node, because a node with no image carrying an
 * agent is a node we can create servers on but never configure. The agent belongs
 * in the VM image; nothing is installed on the hypervisor for it.
 *
 * The host-side counterpart — the `agent=1` channel on the VM config — is a
 * separate step and is applied by the "verify guest agent" template action.
 */
export const GUEST_AGENT_INSTALL_HINTS: Record<string, string[]> = {
  debian: ["apt-get update", "apt-get install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  ubuntu: ["apt-get update", "apt-get install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  kali: ["apt-get update", "apt-get install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  rhel: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  fedora: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  rocky: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  almalinux: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  oracle: ["dnf install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  "centos-7": ["yum install -y qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  suse: ["zypper -n in qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  arch: ["pacman -S --noconfirm qemu-guest-agent", "systemctl enable --now qemu-guest-agent"],
  alpine: ["apk add qemu-guest-agent", "rc-update add qemu-guest-agent", "rc-service qemu-guest-agent start"],
  windows: [
    "Mount the VirtIO guest tools ISO and run virtio-win-guest-tools.exe",
    "Enable the QEMU Guest Agent service (QEMU Guest Agent) and set it to start automatically",
  ],
}

/**
 * The install commands for a template's family, with a Linux default.
 *
 * A family with no exact entry falls back to the Debian instructions rather than
 * to nothing: a wrong-looking command an admin can correct is better than a blank
 * panel that reads as "no installation needed".
 */
export function guestAgentInstallCommands(family: string | null | undefined): { family: string; commands: string[]; exact: boolean } {
  const key = String(family || "").trim().toLowerCase()
  if (key && GUEST_AGENT_INSTALL_HINTS[key]) {
    return { family: key, commands: GUEST_AGENT_INSTALL_HINTS[key], exact: true }
  }
  if (/debian|ubuntu|kali|raspbian|mint/.test(key)) {
    return { family: key || "debian", commands: GUEST_AGENT_INSTALL_HINTS.debian, exact: true }
  }
  if (/rhel|centos|rocky|alma|oracle|fedora|redhat/.test(key)) {
    return { family: key, commands: GUEST_AGENT_INSTALL_HINTS.rhel, exact: true }
  }
  return { family: key || "debian", commands: GUEST_AGENT_INSTALL_HINTS.debian, exact: false }
}
