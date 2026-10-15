import assert from "node:assert/strict"
import test from "node:test"
import {
  assessGuestAgentReadiness,
  prepareGuestAgent,
  PREPARABLE_READINESS,
  GUEST_AGENT_READINESS_LABELS,
  type GuestAgentEvidence,
} from "../../../lib/guest-automation/guest-agent-readiness"

/**
 * The guest-agent state machine and the safety rules around preparing a guest.
 *
 * The rule being pinned here is the one that is easy to get wrong under
 * pressure: the QEMU Guest Agent cannot install the QEMU Guest Agent. Every
 * remote path to a guest — `agent/exec` included — runs through the agent's own
 * channel, so when the agent is not answering, the plan "run the install command
 * through guest-exec" fails at exactly the moment it is needed while looking
 * like the remedy.
 *
 * These tests are pure: no Proxmox call, no socket, no guest touched.
 */

const NONE: GuestAgentEvidence = {
  agentFlag: null,
  configChannelEnabled: false,
  osInfoResponded: false,
  reportedNotRunning: false,
  reportedInstalledButDisabled: false,
  unsupportedGuest: false,
  inaccessible: false,
}

test("a guest that answers is available, whatever its config says", () => {
  // The config flag is a request; the answer is a fact. A working channel is
  // never downgraded because `agent=1` is missing from the VM config.
  const assessment = assessGuestAgentReadiness({
    ...NONE,
    agentFlag: 1,
    configChannelEnabled: false,
    osInfoResponded: true,
  })
  assert.equal(assessment.readiness, "available")
  assert.equal(assessment.usableMechanism, "guest_exec")
  assert.equal(assessment.remedy, null, "a working agent needs no remedy")
  assert.ok(assessment.basis.some((line) => /does not show agent=1/.test(line)), "the mismatch is still reported")
})

test("all five readiness states are reachable and distinct", () => {
  const states = new Set<string>()
  states.add(assessGuestAgentReadiness({ ...NONE, osInfoResponded: true }).readiness)
  states.add(assessGuestAgentReadiness({ ...NONE, reportedInstalledButDisabled: true }).readiness)
  states.add(assessGuestAgentReadiness({ ...NONE, configChannelEnabled: true, reportedNotRunning: true }).readiness)
  states.add(assessGuestAgentReadiness({ ...NONE, configChannelEnabled: false }).readiness)
  states.add(assessGuestAgentReadiness({ ...NONE, inaccessible: true }).readiness)
  assert.equal(states.size, 5, `expected five distinct states, got ${[...states].join(", ")}`)
  assert.equal(new Set(Object.values(GUEST_AGENT_READINESS_LABELS)).size, 5, "every state needs its own label")
})

test("an agent installed but disabled is its own state, not 'not installed'", () => {
  // The difference is the whole point: one needs `systemctl enable`, the other
  // needs an install. Sending an operator to install something already present is
  // how a template stays broken.
  const assessment = assessGuestAgentReadiness({ ...NONE, reportedInstalledButDisabled: true })
  assert.equal(assessment.readiness, "installed_but_disabled")
  assert.match(assessment.remedy ?? "", /enable --now qemu-guest-agent/i)
  assert.match(assessment.basis.join(" "), /cannot report this about itself/i)
})

test("a panel with no channel reports 'inaccessible', never 'not installed'", () => {
  // The distinction that matters: the remedy is a grant or a channel, not an
  // install. Reporting "not installed" sends an operator into a guest they cannot
  // reach, to install something that may already be installed and working.
  const assessment = assessGuestAgentReadiness({ ...NONE, inaccessible: true })
  assert.equal(assessment.readiness, "unsupported_or_inaccessible")
  assert.match(assessment.remedy ?? "", /VM\.GuestAgent\.Audit/)
  assert.equal(assessment.usableMechanism, "none")
})

test("an unsupported guest is not asked to carry a QEMU agent", () => {
  const assessment = assessGuestAgentReadiness({ ...NONE, unsupportedGuest: true })
  assert.equal(assessment.readiness, "unsupported_or_inaccessible")
  assert.match(assessment.remedy ?? "", /LXC/)
})

test("the agent channel being enabled but silent is a different state from missing", () => {
  const enabled = assessGuestAgentReadiness({ ...NONE, configChannelEnabled: true, agentFlag: 0 })
  assert.equal(enabled.readiness, "enabled_not_responding")
  assert.match(enabled.remedy ?? "", /VirtIO serial channel/, "the fix names the actual cause")

  const missing = assessGuestAgentReadiness({ ...NONE, configChannelEnabled: false })
  assert.equal(missing.readiness, "not_installed")
  assert.notEqual(enabled.readiness, missing.readiness)
})

test("preparing a guest never proposes guest-exec to install the agent", () => {
  for (const readiness of ["not_installed", "installed_but_disabled", "enabled_not_responding"] as const) {
    const plan = prepareGuestAgent({ readiness, guestFamily: "debian" })
    assert.notEqual(plan.mechanism, "guest_exec", `${readiness} must not use the agent's own channel to install it`)
    assert.ok(["ssh", "winrm"].includes(plan.mechanism), `${readiness} must plan a channel that works without the agent`)
    const text = `${plan.steps.join(" ")} ${plan.commands.join(" ")}`.toLowerCase()
    assert.equal(/agent\/exec|guest exec|guest-exec/.test(text), false, `${readiness} must not reference guest-exec as its mechanism`)
  }
})

test("preparing an unavailable guest is refused without a channel, and asks for nothing secret", () => {
  const plan = prepareGuestAgent({ readiness: "unsupported_or_inaccessible", guestFamily: "debian" })
  assert.equal(plan.permitted, false)
  assert.match(plan.refusal ?? "", /will not collect a guest password/i)
  assert.equal(plan.mechanism, "none")
  assert.deepEqual(plan.commands, [])
})

test("preparing a guest that already works is a no-op, not a change", () => {
  const plan = prepareGuestAgent({ readiness: "available", guestFamily: "debian", guestOsName: "Debian 12" })
  assert.equal(plan.permitted, true)
  assert.equal(plan.mechanism, "guest_exec")
  assert.match(plan.steps.join(" "), /already answering/i)
})

test("install commands are family-specific and fall back honestly", () => {
  const debian = prepareGuestAgent({ readiness: "not_installed", guestFamily: "debian" })
  assert.match(debian.commands.join(" "), /apt-get install -y qemu-guest-agent/)

  const windows = prepareGuestAgent({ readiness: "not_installed", guestFamily: "windows" })
  assert.equal(windows.mechanism, "winrm")
  assert.match(windows.commands.join(" "), /virtio-win-guest-tools/i)

  // An unknown family must not silently claim an exact match.
  const unknown = prepareGuestAgent({ readiness: "not_installed", guestFamily: "plan9" })
  assert.match(unknown.steps.join(" "), /best match/i)
})

test("every plan states what it will not touch", () => {
  for (const readiness of ["not_installed", "available", "unsupported_or_inaccessible"] as const) {
    const plan = prepareGuestAgent({ readiness, guestFamily: "debian" })
    assert.ok(plan.preserves.length >= 4, `${readiness} must list what it preserves`)
    assert.ok(plan.preserves.some((line) => /VMID/.test(line)))
    assert.ok(plan.preserves.some((line) => /network/i.test(line)))
  }
})

test("every plan defines what will be checked afterwards", () => {
  // Marking the agent healthy before communication is proven is the failure this
  // whole module exists to prevent, so a plan with no verification step is a bug.
  for (const readiness of ["not_installed", "installed_but_disabled", "enabled_not_responding"] as const) {
    const plan = prepareGuestAgent({ readiness, guestFamily: "debian" })
    assert.ok(plan.verification.length > 0, `${readiness} must state how it will be verified`)
    assert.match(plan.verification.join(" "), /get-osinfo|guest_exec/i)
  }
})

test("a template is prepared once rather than per customer VM", () => {
  const plan = prepareGuestAgent({ readiness: "not_installed", guestFamily: "ubuntu", isTemplate: true })
  assert.match(plan.steps.join(" "), /every clone inherits it/i)
})

test("a stopped guest is called out before anything else", () => {
  const plan = prepareGuestAgent({ readiness: "not_installed", guestFamily: "debian", isRunning: false })
  assert.match(plan.steps.join(" "), /Start the VM first/i)
})

test("only genuinely fixable states are marked preparable", () => {
  assert.equal(PREPARABLE_READINESS.has("available"), false, "never modify a guest that already works")
  assert.equal(PREPARABLE_READINESS.has("unsupported_or_inaccessible"), false)
  assert.equal(PREPARABLE_READINESS.size, 3)
})