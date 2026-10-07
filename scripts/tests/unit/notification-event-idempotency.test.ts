import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { whatsappEventKey } from "@/lib/whatsapp/event-key"

describe("whatsapp event keys", () => {
  it("builds a deterministic key from the event, with no timestamp", () => {
    assert.equal(whatsappEventKey(["order", "ABC", "paid"]), "order:ABC:paid")
    assert.equal(whatsappEventKey(["vps", "XYZ", "active"]), "vps:XYZ:active")
    assert.equal(whatsappEventKey(["backup", "123", "completed"]), "backup:123:completed")
  })

  it("is stable across calls, so a repeat event produces the same key", () => {
    const first = whatsappEventKey(["reinstall", "456", "completed"])
    const second = whatsappEventKey(["reinstall", "456", "completed"])
    assert.equal(first, second)
  })

  it("drops empty parts rather than producing empty segments", () => {
    assert.equal(whatsappEventKey(["vps", null, undefined, "active"]), "vps:active")
    assert.equal(whatsappEventKey([]), "")
  })

  it("distinguishes different states of the same entity", () => {
    assert.notEqual(whatsappEventKey(["vps", "XYZ", "active"]), whatsappEventKey(["vps", "XYZ", "failed"]))
  })
})

describe("durable claim behaviour", () => {
  const source = readFileSync(join(process.cwd(), "lib/whatsapp/event-key.ts"), "utf8")

  it("backs the claim with a unique index, not a read-then-write", () => {
    // The claim is only durable if the database refuses the second insert. A
    // findFirst followed by a create is a race between processes.
    const migration = readFileSync(
      join(process.cwd(), "prisma/migrations/20261006120000_notification_event_idempotency/migration.sql"),
      "utf8",
    )
    assert.ok(
      migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS \"notification_delivery_logs_event_key_uniq\""),
      "a unique index on (rule_key, event_type, channel) is required",
    )
    assert.ok(
      /unique|duplicate key/i.test(source.slice(source.indexOf("catch (error)")))
      , "a unique violation must be read as 'already claimed', not as a failure",
    )
  })

  it("fails open so a lost message cannot become a dropped message", () => {
    assert.ok(source.includes('return "unavailable"'), "an unreachable database must not block delivery")
  })

  it("records the outcome after sending", () => {
    assert.ok(source.includes("completeWhatsAppEvent"), "delivery outcome must be recorded")
    assert.ok(source.includes('status: "delivered"'))
  })
})

describe("cloud-init stays out of guest management", () => {
  const client = readFileSync(join(process.cwd(), "lib/proxmox.ts"), "utf8")

  it("exposes no cloud-init mutation or dump verb", () => {
    for (const verb of ["updateCloudInit", "setCloudInit", "dumpCloudInit"]) {
      assert.equal(client.includes(`async ${verb}(`), false, `${verb} must not exist on the Proxmox client`)
    }
    assert.ok(client.includes("cloudinit update"), "the removal must stay documented so it is not reintroduced")
  })
})
