/**
 * Guest-agent readiness: what state is this VM's guest channel actually in, and
 * what can safely be done about it.
 *
 * ## The five states, and why each one is separate
 *
 * "Guest agent unavailable" collapsed four different situations into one word,
 * and each needs a different fix:
 *
 * | State                      | Evidence                                   | Fix                          |
 * |----------------------------|--------------------------------------------|------------------------------|
 * | `not_installed`            | Guest answers, reports no agent            | install in the image         |
 * | `installed_but_disabled`   | Package present, service inactive/disabled  | enable the service           |
 * | `enabled_not_responding`   | Service enabled, channel silent            | check the virtio device      |
 * | `available`                | Agent answers a real query                 | none                         |
 * | `unsupported_or_inaccessible` | No channel to ask through               | a grant, or an unsupported guest |
 *
 * The last one matters most. It is the only state in which the panel has no way
 * to find out — and it must never be reported as "not installed", because the
 * remedy is completely different.
 *
 * ## The rule this module exists to enforce
 *
 * **The QEMU Guest Agent cannot install the QEMU Guest Agent.**
 *
 * Every remote path to a guest runs through `POST /nodes/{node}/qemu/{vmid}/agent/exec`,
 * which is the agent's own channel. If the agent is not answering, that endpoint
 * is unavailable — and "run the install command through guest-exec" is a plan that
 * fails at exactly the moment it is needed, having been presented as the remedy.
 *
 * `prepareGuestAgent()` therefore refuses to offer guest-exec unless the channel
 * has been *proven working first*, and otherwise hands back the mechanisms that
 * do work without a guest agent: an authorized SSH or WinRM channel, or
 * preparing a template offline.
 *
 * ## What this never does
 *
 * - It never collects or stores a guest password to make a check pass.
 * - It never downloads an installer from a URL it has not verified.
 * - It never modifies a disk, a VMID or a network configuration.
 * - It never runs against a guest that has not been named explicitly by an
 *   administrator.
 */

import { guestAgentInstallCommands } from "./default-templates"

/**
 * Guest-agent readiness for one VM.
 *
 * `available` is the only state that grants capability. Everything else is a
 * description, and nothing in the panel may treat a description as a capability.
 */
export type GuestAgentReadiness =
  | "available"
  | "enabled_not_responding"
  | "installed_but_disabled"
  | "not_installed"
  | "unsupported_or_inaccessible"

export const GUEST_AGENT_READINESS_LABELS: Record<GuestAgentReadiness, string> = {
  available: "Agent available and responding",
  enabled_not_responding: "Enabled in the VM config but not responding",
  installed_but_disabled: "Installed in the guest but disabled",
  not_installed: "Not installed in the guest",
  unsupported_or_inaccessible: "Unsupported guest, or no authorized way to ask",
}

export type GuestAgentEvidence = {
  /** Proxmox's `agent` flag from the VM list. 1 means the channel answered. */
  agentFlag: number | null
  /** `agent: 1` present in the VM configuration. */
  configChannelEnabled: boolean | null
  /** The guest answered `get-osinfo`. The strongest evidence available. */
  osInfoResponded: boolean
  /** The guest answered but said the agent is not running. */
  reportedNotRunning: boolean
  /**
   * An out-of-band check found the agent package installed but its service
   * inactive or disabled.
   *
   * This one cannot come from the guest agent — a disabled agent cannot report
   * that it is disabled. It requires a channel that works without it (SSH or
   * WinRM), which is exactly why the panel will not try to reach this state with
   * `agent/exec`.
   */
  reportedInstalledButDisabled: boolean
  /** The guest is a container or other type that cannot carry a QEMU agent. */
  unsupportedGuest: boolean
  /** The panel has no authorized channel to ask the guest anything. */
  inaccessible: boolean
  /**
   * The guest's own OS family, when something has already established it.
   *
   * Used only to pick which channel to recommend for acting on the guest. It is
   * never used to assume the guest has an agent — that is what the state above
   * is for.
   */
  guestFamilyHint?: string | null
}

export type GuestAgentAssessment = {
  readiness: GuestAgentReadiness
  label: string
  /** What was actually established, so an operator can check the reasoning. */
  basis: string[]
  /** The single next action, or null when there is nothing to do. */
  remedy: string | null
  /** The mechanism that may be used to act, never assumed. */
  usableMechanism: "guest_exec" | "ssh" | "winrm" | "image_rebuild" | "none"
}

/**
 * Decide the readiness state from evidence.
 *
 * The order of the checks is the policy. A guest that answers is available,
 * full stop — even if its config flag says otherwise, because the config is a
 * request and the answer is a fact. And a panel with no way to ask never gets to
 * say "not installed".
 */
export function assessGuestAgentReadiness(evidence: GuestAgentEvidence): GuestAgentAssessment {
  const basis: string[] = []

  if (evidence.osInfoResponded) {
    basis.push("The guest answered get-osinfo through the QEMU guest agent channel.")
    if (evidence.agentFlag === 1) basis.push("Proxmox also reports agent=1 for this VM.")
    if (!evidence.configChannelEnabled) {
      basis.push("The VM configuration does not show agent=1, which is worth reconciling even though the channel is working.")
    }
    return {
      readiness: "available",
      label: GUEST_AGENT_READINESS_LABELS.available,
      basis,
      remedy: null,
      usableMechanism: "guest_exec",
    }
  }

  if (evidence.unsupportedGuest) {
    basis.push("This guest is not a QEMU virtual machine that can carry the guest agent.")
    return {
      readiness: "unsupported_or_inaccessible",
      label: GUEST_AGENT_READINESS_LABELS.unsupported_or_inaccessible,
      basis,
      remedy: "Use a Linux or Windows image with a guest agent. LXC containers use a different channel and cannot take a QEMU guest agent.",
      usableMechanism: "image_rebuild",
    }
  }

  if (evidence.inaccessible) {
    basis.push("The panel has no authorized channel to ask this guest anything, so its agent state is unknown rather than absent.")
    return {
      readiness: "unsupported_or_inaccessible",
      label: GUEST_AGENT_READINESS_LABELS.unsupported_or_inaccessible,
      basis,
      remedy:
        "Grant VM.GuestAgent.Audit on /vms/{vmid} to let the panel read the guest's OS information, or supply an authorized SSH or WinRM channel. Until one exists, this VM's agent state cannot be determined.",
      usableMechanism: "none",
    }
  }

  if (evidence.reportedInstalledButDisabled) {
    basis.push("An out-of-band check found qemu-guest-agent installed in the guest with its service inactive or disabled.")
    basis.push("The agent cannot report this about itself, so it was established over a channel that does not depend on the agent.")
    return {
      readiness: "installed_but_disabled",
      label: GUEST_AGENT_READINESS_LABELS.installed_but_disabled,
      basis,
      remedy:
        "Enable and start the service inside the guest: `systemctl enable --now qemu-guest-agent` on Linux, or set the QEMU Guest Agent service to Automatic and start it on Windows. No installation is needed and no disk needs to change.",
      usableMechanism: evidence.guestFamilyHint === "windows" ? "winrm" : "ssh",
    }
  }

  if (evidence.reportedNotRunning) {
    basis.push("The guest answered and reported that the QEMU guest agent is not running.")
    if (evidence.configChannelEnabled) {
      basis.push("The VM configuration enables agent=1, so the hypervisor side is ready.")
      return {
        readiness: "enabled_not_responding",
        label: GUEST_AGENT_READINESS_LABELS.enabled_not_responding,
        basis,
        remedy:
          "The agent channel is enabled but nothing answers. Inside the guest, check that qemu-guest-agent is running and that the VirtIO serial channel device is present; also confirm the VM was not started before the channel was enabled.",
        usableMechanism: "ssh",
      }
    }
    return {
      readiness: "not_installed",
      label: GUEST_AGENT_READINESS_LABELS.not_installed,
      basis,
      remedy: "Install qemu-guest-agent in this image using the commands for its distribution, then enable the VM's agent channel.",
      usableMechanism: "ssh",
    }
  }

  if (evidence.configChannelEnabled && evidence.agentFlag !== 1) {
    basis.push("The VM configuration enables agent=1 but Proxmox reports no agent on the VM.")
    return {
      readiness: "enabled_not_responding",
      label: GUEST_AGENT_READINESS_LABELS.enabled_not_responding,
      basis,
      remedy:
        "The hypervisor channel is open and nothing answers. Inside the guest, install and start qemu-guest-agent, and confirm the VirtIO serial channel device is present and that the VM was not started before the channel was enabled.",
      usableMechanism: "ssh",
    }
  }

  basis.push("No guest query was answered and the VM configuration does not enable the agent channel.")
  return {
    readiness: "not_installed",
    label: GUEST_AGENT_READINESS_LABELS.not_installed,
    basis,
    remedy: "Install qemu-guest-agent in this image and enable the VM's agent channel.",
    usableMechanism: "ssh",
  }
}

export type GuestAgentPreparation = {
  /** Whether the panel may act on this guest at all. */
  permitted: boolean
  /** Why not, when `permitted` is false. */
  refusal: string | null
  /** The mechanism this preparation would use. */
  mechanism: GuestAgentAssessment["usableMechanism"]
  /** The steps, in order, for a human or an automation to carry out. */
  steps: string[]
  /** Commands for the guest, when the family is known. */
  commands: string[]
  /** What will be checked afterwards to decide it worked. */
  verification: string[]
  /** What this will not touch. */
  preserves: string[]
}

/**
 * Plan an administrator-triggered guest-agent preparation.
 *
 * The plan is returned, not executed. There is no code path here that installs
 * anything; the caller decides whether to hand the steps to a human, to an
 * existing provisioning workflow, or to a template build.
 *
 * `readiness` decides the mechanism, and the agent's own channel is offered only
 * when it has been proven to work. Using it to install the agent would be the
 * circular case, and it is refused explicitly rather than attempted.
 */
export function prepareGuestAgent(input: {
  readiness: GuestAgentReadiness
  guestFamily: string | null
  guestOsName?: string | null
  isTemplate?: boolean
  isRunning?: boolean
}): GuestAgentPreparation {
  const preserves = [
    "the VM's disks and their contents",
    "the VMID",
    "the VM's network configuration",
    "the VM's CPU, memory and disk sizing",
  ]

  if (input.readiness === "available") {
    return {
      permitted: true,
      refusal: null,
      mechanism: "guest_exec",
      steps: [
        `The guest agent on this VM is already answering (${input.guestOsName || "guest OS not reported"}).`,
        "No preparation is needed. The channel can be used for disk usage, IP discovery and guest commands.",
      ],
      commands: [],
      verification: ["Re-run the capability measurement; guest_exec should report a pid and an exit code."],
      preserves,
    }
  }

  if (input.readiness === "unsupported_or_inaccessible") {
    return {
      permitted: false,
      refusal:
        "The panel cannot determine or change this guest's agent state. It has no authorized execution mechanism into the guest, and it will not collect a guest password or open a channel just to make the check pass.",
      mechanism: "none",
      steps: [
        "Grant VM.GuestAgent.Audit on /vms/{vmid} so the panel can read the guest's OS information, or",
        "Provide an authorized SSH (Linux) or WinRM (Windows) channel for this VM, or",
        "Prepare a template image that already carries the agent, and clone from it.",
      ],
      commands: [],
      verification: ["After any of the above, re-measure: the guest must answer get-osinfo before the agent counts as available."],
      preserves,
    }
  }

  // The guest agent cannot install itself. Everything below plans a mechanism
  // that works without the agent already running.
  const install = guestAgentInstallCommands(input.guestFamily)
  const mechanism: GuestAgentAssessment["usableMechanism"] = input.guestFamily === "windows" ? "winrm" : "ssh"
  const needsChannelEnabled = input.readiness === "not_installed"

  return {
    permitted: true,
    refusal: null,
    mechanism,
    steps: [
      `The guest agent is ${GUEST_AGENT_READINESS_LABELS[input.readiness].toLowerCase()}. It is installed inside the guest image, not on the hypervisor.`,
      input.isRunning === false
        ? "Start the VM first: the agent cannot be installed or verified against a stopped guest."
        : `Use an authorized ${mechanism === "winrm" ? "WinRM" : "SSH"} session into this guest. This plan does not carry credentials and does not open a channel on its own.`,
      `Install and enable the agent with the ${install.family} commands below${install.exact ? "" : " (best match for this family; confirm before running)"}.`,
      needsChannelEnabled
        ? "After the guest is answering, enable the VM's agent channel. Proxmox requires a powered-off or rebooted VM for this to take effect."
        : "The VM's agent channel is already enabled; no configuration change is needed.",
      input.isTemplate
        ? "Because this is a template, install the agent here once and every clone inherits it. Do this on the template rather than on each customer VM."
        : "This is a running VM. Install on the template it came from instead, so future clones inherit a working agent.",
    ],
    commands: install.commands,
    verification: [
      "Inside the guest, confirm the service is active (systemctl status qemu-guest-agent, or the Windows Services console).",
      "Re-run the capability measurement. The guest agent is only healthy when get-osinfo returns a real OS record and guest_exec returns a pid that exits 0.",
    ],
    preserves,
  }
}

/**
 * The states a caller may act on without further authorisation.
 *
 * Deliberately excludes `available`. Preparing a guest that already works would
 * be an unnecessary change to a running production VM.
 */
export const PREPARABLE_READINESS: ReadonlySet<GuestAgentReadiness> = new Set<GuestAgentReadiness>([
  "not_installed",
  "installed_but_disabled",
  "enabled_not_responding",
])