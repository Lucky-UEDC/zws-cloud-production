import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const page = readFileSync(join(process.cwd(), "app/client-area/vps/[id]/page.tsx"), "utf8")

describe("customer service state vocabulary", () => {
  it("does not render transport-state badges on the metric cards", () => {
    // The ResourceCard used to print fresh.state verbatim, so every card said
    // CURRENT / STALE / UNAVAILABLE next to a perfectly healthy server.
    const card = page.slice(page.indexOf("function ResourceCard"), page.indexOf("function MiniChart"))
    for (const badge of ["fresh.state", "freshness.state"]) {
      assert.equal(card.includes(badge), false, `${badge} must not be printed to the customer`)
    }
  })

  it("uses plain service words instead", () => {
    for (const label of ['return "Active"', 'return "Setting up"', 'return "Suspended"', 'return "Needs attention"']) {
      assert.ok(page.includes(label), `missing service label: ${label}`)
    }
  })

  it("never says a server is offline just because a sample is missing", () => {
    assert.equal(page.includes('"Server offline"'), false, "a stale sample is not an offline server")
  })

  it("never says Preparing server on a metric card", () => {
    const cards = page.slice(page.indexOf('<ResourceCard title="CPU"'), page.indexOf('<VpsLiveUsageCharts'))
    assert.equal(cards.includes('"Preparing server"'), false, "metric cards must not claim provisioning")
  })

  it("says Not collected once, rather than inventing a zero", () => {
    assert.ok(page.includes('"Not collected yet"'), "an unmeasured metric must say so")
    assert.equal(page.includes('"Usage unavailable"'), false, "replaced by an explicit not-collected message")
  })
})

describe("service state precedence", () => {
  it("evaluates active/running before any provisioning label", () => {
    const stateOf = page.slice(page.indexOf("function stateOf"), page.indexOf("function stateLabel"))
    const activeIndex = stateOf.indexOf('raw === "ACTIVE"')
    const provisioningIndex = stateOf.indexOf("provisioningStates.has(prov)")
    assert.ok(activeIndex > 0 && provisioningIndex > activeIndex, "an active server must not read as provisioning")
  })

  it("does not consult telemetry to decide service state", () => {
    const stateOf = page.slice(page.indexOf("function stateOf"), page.indexOf("function stateLabel"))
    for (const metricKey of ["metricsFreshness", "diskUsage", "cpuPercent", "diskPercent"]) {
      assert.equal(stateOf.includes(metricKey), false, `${metricKey} must not influence service state`)
    }
  })
})

describe("disk card is guest truth", () => {
  it("shows the measured sample with its own timestamp", () => {
    assert.ok(page.includes("Last recorded"), "a last-known disk sample must be labelled as such")
    assert.ok(page.includes("Last recorded before shutdown"), "a stopped server keeps its last sample")
  })

  it("keeps used, total and free from the same sample", () => {
    assert.ok(page.includes("free of"), "the card must present used against the same sample's total")
  })

  it("never shows a 0% disk for a server with no sample", () => {
    const card = page.slice(page.indexOf('title="Disk"'), page.indexOf('title="Network"'))
    assert.ok(card.includes("Not collected yet"))
    assert.equal(/progress=\{hasSample \? du\?\.percent : null\}/.test(card), true, "progress must be null when there is no sample")
  })
})
