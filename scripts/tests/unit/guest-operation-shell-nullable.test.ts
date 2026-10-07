import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8")
const migration = readFileSync(
  join(process.cwd(), "prisma/migrations/20261007120000_guest_operation_shell_nullable/migration.sql"),
  "utf8",
)
const adminTemplates = readFileSync(join(process.cwd(), "lib/guest-automation/admin-templates.ts"), "utf8")

/**
 * Every shipped guest profile carries four `guest-native` operations
 * (detect_os, detect_network, detect_filesystem, guest_health). The admin
 * editor stores a NULL shell for those, because a guest-native verb runs no
 * shell and an inert shell value would read as though it constrained
 * something.
 *
 * The column was NOT NULL, so every save through the admin editor failed with
 * "Argument `template` is missing" -- a Prisma message that points at the
 * required relation and has nothing to do with the shell that was actually
 * null. Found while trying to push a corrected Linux network command to the
 * live templates; the editor could not save at all.
 */
describe("guest operation template shell nullability", () => {
  it("lets the column accept a null shell", () => {
    assert.ok(
      /shell\s+String\?\s+@default\("linux-sh"\)/.test(schema),
      "GuestOperationTemplate.shell must be nullable, because guest-native operations have no shell",
    )
  })

  it("drops the NOT NULL constraint with a guarded, additive migration", () => {
    assert.ok(
      migration.includes('ALTER TABLE "guest_operation_templates" ALTER COLUMN "shell" DROP NOT NULL'),
      "the migration must widen the column rather than rewrite rows",
    )
    assert.ok(
      !/DROP\s+(TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+\S+\s+SET/i.test(migration),
      "widening a column to nullable must not drop or rewrite data",
    )
  })

  it("still stores a null shell for guest-native operations", () => {
    assert.ok(
      adminTemplates.includes('operation.commandType === "guest-native" ? null'),
      "a guest-native operation must not be given a shell",
    )
  })

  it("falls back to an engine default wherever the shell is read", () => {
    const verification = readFileSync(join(process.cwd(), "lib/guest-automation/verification.ts"), "utf8")
    const validation = readFileSync(join(process.cwd(), "lib/guest-automation/validation.ts"), "utf8")
    assert.ok(
      verification.includes('(input.shell as any) || (input.engine === "windows" ? "windows-powershell" : "linux-sh")'),
      "verification must not assume a shell is present",
    )
    assert.ok(
      validation.includes('draft.shell ?? (engine === "windows" ? "windows-powershell" : "linux-sh")'),
      "template validation must not assume a shell is present",
    )
  })

  it("keeps the cross-OS guard able to reject a mismatched shell", () => {
    const guest = readFileSync(join(process.cwd(), "lib/guest-automation/proxmox-guest.ts"), "utf8")
    assert.ok(
      guest.includes("assertShellMatchesEngine"),
      "a null shell must still go through the engine gate rather than bypassing it",
    )
  })
})