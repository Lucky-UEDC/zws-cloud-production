# Proxmox node setup and permissions

How to give the ZWS Cloud panel exactly the Proxmox access it needs, and no more.

Everything here was read out of the running Proxmox's own API schema at
`/pve-docs/api-viewer/apidoc.js`. `pnpm verify:proxmox:permissions -- --host <host:8006>`
re-checks that table against any Proxmox you point it at, so if an upgrade changes
what an endpoint requires, the check fails loudly instead of producing a
confident wrong answer in production.

---

## 1. Create the API token

Create a dedicated user and give it a token. The panel authenticates as this user
and nothing else.

```bash
# On the Proxmox host
pveum user add zws@pve
pveum role add ZwsCloudPanel -privs "<see section 3>"
pveum aclmod / -user zws@pve -role ZwsCloudPanel

pveum user token add zws@pve panel --privsep 1
```

Two things that are deliberate:

- **The user is scoped to this role.** It is not `root@pam`, and the panel never
  asks for the root password.
- **`--privsep 1` stays on.** With privilege separation on, a token can never hold
  more privilege than the user it belongs to. Turning it off is not a fix for a
  permission problem, and the panel will not suggest it.

Record the printed secret value. The panel stores it encrypted and never returns
it from any endpoint.

---

## 2. What the panel asks for, and why

| Feature | Privilege | ACL scope | Without it |
|---|---|---|---|
| Node discovery | *(none)* | — | Nothing is discovered |
| Cluster + node telemetry | `Sys.Audit` | `/`, `/nodes/{node}` | Nodes are still manageable; CPU/RAM/uptime are not shown |
| VM inspection | `VM.Audit` | `/vms/{vmid}` | No VM inventory, no per-VM console metrics |
| VNC console | `VM.Console` | `/vms/{vmid}` | Graphical console returns a clear permission error |
| Serial console | `VM.Console` | `/vms/{vmid}` | Same privilege as VNC; Proxmox does not separate them |
| Power control | `VM.PowerMgmt` | `/vms/{vmid}` | Start/stop/reboot are refused |
| VM configuration | `VM.Config.*` | `/vms/{vmid}` | No cloning or reconfiguration |
| Snapshots | `VM.Snapshot` | `/vms/{vmid}` | Snapshots are refused |
| Backup | `VM.Backup` + `Datastore.AllocateSpace` | `/vms/{vmid}`, `/storage/{storage}` | Backups cannot be written |
| Guest agent (read) | `VM.GuestAgent.Audit` | `/vms/{vmid}` | Cannot query the guest for OS, disks or network |
| Guest agent (execute) | `VM.GuestAgent.Unrestricted` | `/vms/{vmid}` | Cannot run guest-exec; provisioning cannot configure a server |
| Storage | `Datastore.Audit` | `/storage/{storage}` | Storage inventory and capability detection are blind |

### Endpoints that need no explicit privilege

These are Proxmox's `{"user":"all"}` endpoints — open to any authenticated user.
They still *filter themselves* by what the caller may see:

- `GET /nodes` — but `GET /nodes/{node}/qemu` returns only the VMs the caller
  holds `VM.Audit` on. A node can therefore be visible with an empty VM list.
- `GET /cluster/resources` — filtered the same way.
- `GET /nodes/{node}/storage` — returns only storages the caller holds
  `Datastore.Audit` or `Datastore.AllocateSpace` on.

That asymmetry is why "the node list works but the VM list is empty" is a
permission-shaped result, not an empty cluster. The panel reports it as such.

---

## 3. Role definitions

### Read-only inventory and telemetry

Enables discovery, the node dashboard and VM inspection. No writes of any kind.

```bash
pveum role add ZwsCloudRead -privs "VM.Audit Sys.Audit Datastore.Audit"
pveum aclmod / -user zws@pve -role ZwsCloudRead
```

### Full panel operations

Everything the panel does. Still no `Sys.Modify`, no `VM.Allocate` on arbitrary
VMIDs, no `root@pam`.

```bash
pveum role add ZwsCloudPanel -privs "\
VM.Audit,VM.Backup,VM.Clone,VM.Config.CPU,VM.Config.Disk,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.Console,VM.GuestAgent.Audit,VM.GuestAgent.Unrestricted,VM.PowerMgmt,VM.Snapshot,\
Datastore.AllocateSpace,Datastore.Audit,\
Sys.Audit"
pveum aclmod / -user zws@pve -role ZwsCloudPanel
```

Grant per node when you do not want cluster-wide visibility:

```bash
pveum aclmod /nodes/m2-v2 -user zws@pve -role ZwsCloudPanel
```

### The Proxmox ACLs are never changed by the panel

Every remediation the panel displays is a `pveacl` line to print and run yourself,
on the Proxmox host, as an administrator. There is no button that applies one.

---

## 4. Reading a permission failure

The panel reports, for every denied call:

- the endpoint that was refused,
- the HTTP status,
- the capability that endpoint serves,
- the privilege and ACL scope Proxmox evaluates for it,
- a remediation line.

Proxmox's own 403 carries no detail — the body is `{"data":null}` — so the mapping
from endpoint to privilege is what makes an explanation possible.

A node whose status call is refused is reported as **inaccessible**, not as
missing. It came back from `/nodes`, so it exists; this token simply may not read
it. That distinction is preserved deliberately.

---

## 5. Storage prerequisites

### Snapshots

A Proxmox snapshot is a snapshot of the *volume*. On a `dir` or NFS/CIFS storage
the volume is a file, and only a **qcow2** image can be snapshotted without being
converted. A raw disk on file-backed storage cannot be.

| Storage type | Snapshots |
|---|---|
| `lvmthin`, `zfspool`, `zfs`, `rbd`, `ceph`, `cephfs`, `btrfs` | Native, any disk format |
| `dir`, `nfs`, `cifs` | qcow2 volumes only |
| `lvm` | No — thick volumes cannot be snapshotted while the guest runs |

The panel reads the actual disk formats from each VM's volume definitions and
reports what it finds. It will not convert a disk, because converting rewrites
the volume and changes its format.

To enable snapshots without touching existing disks: add an `lvmthin` or `zfspool`
storage and create new disks there. Existing VMs stay where they are.

### Backups

A storage is a backup target when it is **enabled**, **active on the node**, has
free space, and its `content` lists `vzdump` or `backup`.

- `vzdump` — an ordinary storage receiving `.tar.zst` archives.
- `backup` — a Proxmox Backup Server datastore.

Both are valid. The panel accepts either and reports both consistently.

To enable a backup target, edit the storage's **Content** column in the Proxmox
UI and tick **Backup**, then apply. The panel will not do this for you: it changes
where production backups are written, and that is an operational decision.

---

## 6. Console access

VNC and serial consoles are both `VM.Console` on `/vms/{vmid}`. Proxmox does not
separate them.

The panel probes a real running guest with `POST /nodes/{node}/qemu/{vmid}/vncproxy`
and `POST /nodes/{node}/qemu/{vmid}/termproxy` and reports what actually came
back. With no running guest there is nothing to probe, and the result is reported
as **not measured** rather than as unavailable.

`vncwebsocket` is not a Proxmox endpoint — it answers "not implemented"
everywhere. The panel calls `vncproxy`, which is what noVNC actually uses.

---

## 7. Guest agent

The agent belongs **inside the guest image**. Nothing is installed on the
hypervisor for it.

Linux:

```bash
# Debian / Ubuntu / Kali
apt-get update && apt-get install -y qemu-guest-agent
systemctl enable --now qemu-guest-agent

# RHEL / Alma / Rocky / Oracle / Fedora
dnf install -y qemu-guest-agent && systemctl enable --now qemu-guest-agent

# openSUSE / SLES
zypper -n in qemu-guest-agent && systemctl enable --now qemu-guest-agent

# Arch
pacman -S --noconfirm qemu-guest-agent && systemctl enable --now qemu-guest-agent

# Alpine
apk add qemu-guest-agent
rc-update add qemu-guest-agent && rc-service qemu-guest-agent start
```

Windows: run `virtio-win-guest-tools.exe` from the VirtIO guest tools ISO, then
set the **QEMU Guest Agent** service to Automatic and start it.

Then enable the VM's agent channel (`agent=1`). Proxmox applies this on the next
power cycle for a running VM.

### The agent cannot install the agent

Every remote path into a guest runs through `POST .../agent/exec`, which *is* the
agent's own channel. When the agent is not answering, that endpoint is
unavailable — so "install it with guest-exec" fails at exactly the moment it is
needed.

When the guest agent is unavailable, the panel's preparation plan names a
mechanism that works without it: an authorized SSH or WinRM session, or installing
the agent in the template once so every clone inherits it.

Readiness is reported as one of five distinct states:

| State | Meaning | Fix |
|---|---|---|
| `available` | The guest answers | none |
| `installed_but_disabled` | Package present, service inactive | enable the service |
| `enabled_not_responding` | Channel open, nothing answers | start the agent; check the virtio device |
| `not_installed` | No agent in the image | install it |
| `unsupported_or_inaccessible` | No channel to ask through | grant `VM.GuestAgent.Audit`, or supply SSH/WinRM |

Only `available` grants capability. The agent is never marked healthy until a real
query returns.

---

## 8. TLS

Certificate verification is on by default and the panel does not offer to turn it
off silently.

For a private CA, install the CA certificate on the container rather than
disabling verification:

```bash
COPY certs/your-ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates
```

If a node is stored with `allowInsecureTls` enabled, the connection test says so
in plain words: *"TLS handshake succeeded with certificate verification
disabled"*.

The panel also refuses to connect to a URL pointing at a cloud instance metadata
service (`169.254.169.254` and friends), a non-HTTP scheme, or a URL carrying
embedded credentials.

---

## 9. Verifying a setup

```bash
# Check the panel's permission table against this Proxmox.
pnpm verify:proxmox:permissions -- --host pve.example.com:8006

# Confirm the transport works and the token is rejected when it should be.
npx tsx scripts/live-proxmox-transport-check.ts pve.example.com:8006
```

Both are read-only. Neither modifies anything on the Proxmox host.