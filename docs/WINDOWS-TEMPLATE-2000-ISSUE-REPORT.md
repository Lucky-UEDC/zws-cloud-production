# Windows Template 2000 — Issue Report

Status: **functional**. QGA: **PASS**. Real clone: **PASS**.

This report is record-only. The application fix in this release did **not**
modify VM 2000 in any way: no reinstall, no network change, no disk change, no
QGA change, and no removal of the Cloud-Init fields. Template cleanup is being
handled manually and separately.

## Identity

| Field | Value |
|---|---|
| VMID | 2000 |
| Name | `UEDC-Windows` |
| OS | Windows Server 2022 |
| Node | `m2-v2` |
| Template flag | set |
| Base disk | `local-lvm:base-2000-disk-0` |

## Verified: QGA

The guest agent is healthy. Verified on a **real full clone** of the template
(VMID 9001, disposable, destroyed after testing):

| Step | Result |
|---|---|
| `qmclone 2000 → 9001` | `stopped OK` |
| start | `running` |
| QGA ping at ~30s | not yet running (expected during boot) |
| **QGA ping at ~45s** | **ready** |

Observed QGA readiness: **approximately 45 seconds**, far inside the
10-minute provisioning budget.

Native verbs, all responding:

| Verb | Method | Result |
|---|---|---|
| `ping` | POST | ok |
| `get-osinfo` | GET | Windows Server 2022 Datacenter Evaluation |
| `get-host-name` | GET | `UEDC-WINDOWS` |
| `get-fsinfo` | GET | `C:\ NTFS total=21367877632 used=19781869568` |
| `get-users` | GET | `[]` |
| `get-time` | GET | ok |
| `guest-exec hostname` | POST + status | `UEDC-Windows` |

Real Windows guest operations verified on that clone: adapter discovery,
`New-NetIPAddress`, `Get-NetIPAddress`, `New-NetRoute`, `Get-NetRoute`,
`Set-DnsClientServerAddress`, `Get-DnsClientServerAddress`, `Set-LocalUser`,
`net user`, and `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"`.

**VM 2000 is not QGA-broken.**

## Known stale template configuration

The template still carries legacy Cloud-Init metadata, IP-specific and
customer-adjacent:

| Key | Value |
|---|---|
| `ciuser` | `Administrator` |
| `cipassword` | present (redacted) |
| `ipconfig0` | `ip=103.216.170.210/24,gw=103.216.170.1` |
| Old IP | `103.216.170.210` |
| Old gateway | `103.216.170.1` |
| `nameserver` | `8.8.8.8 1.1.1.1` |
| `cicustom` | `user=nvme1:snippets/windows-user.yaml` |

Impact: a fresh clone **inherits** these values. In testing, the clone came up
holding `103.216.170.210/24` from the stale `ipconfig0`, alongside an APIPA
address.

## Application dependency on those values: NONE

The panel does not read, write or depend on `ciuser`, `cipassword`,
`ipconfig0`, `nameserver` or `cicustom` for guest management. Verified in code:

- `lib/proxmox.ts` exposes no `updateCloudInit`, `setCloudInit` or
  `dumpCloudInit` method, so no `qm cloudinit update` path exists.
- `lib/guest-automation/first-boot.ts` builds only the host-side config
  (`name`, `description`) plus `net0` via `net0Value()`.
- All guest configuration is Proxmox API + QEMU guest agent + OS-native
  commands, engine-separated.
- A regression test (`windows-gqa-contract.test.ts`) pins that no
  Linux-only disk command appears in any Windows collector and that the guest
  verb contract is ping=POST / read verbs=GET.

Network state is therefore established by the guest agent inside Windows, not
by the template's stale Cloud-Init fields.

## What the application actually fixed

The real defect was in panel code, in the Windows guest-evidence read:

```
$ip = @'10.10.10.10'
```

That is not valid PowerShell. A here-string header must be followed by a line
break, so the whole command failed with
`UnexpectedCharactersAfterHereStringHeader`, exit code 1 and **empty stdout**.
The provisioning hard gate then concluded "no gateway, no DNS" on a guest that
was configured correctly — surfacing as
`provisioning_hard_gate_failed: guestGatewayApplied, guestDnsApplied`.

The expected IPv4 is now interpolated into a plain single-quoted string. On the
same clone, the corrected command returned `exit=0`,
`ADAPTER=Ethernet`, `GW=10.10.10.1`, `DNS=8.8.8.8,1.1.1.1`.

A second, earlier fix in the same area replaced enumeration-order adapter
selection (`Get-NetIPConfiguration | Select -First 1`, which resolves to a
disconnected or APIPA interface) with an explicit selection order.

## Manual cleanup required: YES

Recommended operator steps, **not performed by this release**:

1. Clear the Cloud-Init keys from template 2000:
   `ciuser`, `cipassword`, `ipconfig0`, `nameserver`, `searchdomain`,
   `cicustom`.
2. Confirm the guest agent service inside the image is `Automatic` and
   `Running`, and that the virtio-serial channel is present.
3. Re-verify with `qm agent 2000 ping` after a reboot.
4. Take a fresh clone and confirm it comes up with no inherited IP.

None of these steps are required for correctness today — the panel does not read
those values — but they remove a stale-IP foot-gun from future clones.
