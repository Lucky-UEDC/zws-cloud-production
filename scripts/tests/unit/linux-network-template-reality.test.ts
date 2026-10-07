import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_GUEST_TEMPLATES } from "@/lib/guest-automation/default-templates"

/**
 * Every one of these failures was found by provisioning a real clone of a
 * production Linux template, not by reading the code.
 */
describe("Debian ifupdown network template", () => {
  const debianProfile = DEFAULT_GUEST_TEMPLATES.find((template) => template.slug === "debian-12")
  assert.ok(debianProfile, "the Debian 12 guest profile must exist in the seed")

  const op = (name: string) => {
    const found = (debianProfile!.operations as any[]).find((operation) => operation.operation === name)
    assert.ok(found, `${name} must be seeded on the Debian 12 profile`)
    return found as any
  }

  it("creates /etc/network/interfaces.d before writing into it", () => {
    for (const name of ["set_ip", "set_gateway"]) {
      const command = String(op(name).command)
      assert.ok(command.includes("mkdir -p"), `${name} must create its target directory before writing into it`)
      const firstWrite = command.search(/>>?\s*"/)
      assert.ok(firstWrite > -1, `${name} must actually write a file`)
      assert.ok(command.indexOf("mkdir -p") < firstWrite, `${name} must create the directory before its first write`)
    }
  })

  it("creates that directory on the rollback path too", () => {
    const rollback = String(op("set_ip").rollbackCommand || "")
    assert.ok(rollback.includes("mkdir -p"), "rollback must not depend on the directory already existing")
  })

  it("rewrites the gateway stanza wholesale instead of appending to it", () => {
    const command = String(op("set_gateway").command)
    assert.ok(!command.includes("sed -i"), "set_gateway must not edit a line it does not own")
    assert.ok(command.includes('> "$F"'), "set_gateway must write the whole stanza")
  })

  it("tolerates an image that names its network unit differently", () => {
    for (const name of ["set_ip", "set_gateway"]) {
      const command = String(op(name).command)
      assert.ok(command.includes("|| true"), `${name} must not hard-fail on a missing network unit`)
      assert.ok(command.includes("netplan apply") && command.includes("ifup {{NIC}}"), `${name} must try both the netplan and ifupdown paths`)
    }
  })

  it("proves the nameserver actually landed instead of assuming it did", () => {
    const command = String(op("set_dns").command)
    assert.ok(command.includes("resolvectl dns"), "set_dns must configure systemd-resolved where present")
    assert.ok(
      command.includes("grep '{{DNS1}}'") || command.includes("grep -q '{{DNS1}}'"),
      "set_dns must read the resolver back, so an unconfigured DNS step cannot report success",
    )
    assert.equal(op("set_dns").verificationParser, "exit-code", "verification stays on a parser that exists")
  })

  it("never asks a Linux profile to run a Windows shell", () => {
    for (const operation of debianProfile!.operations as any[]) {
      assert.ok(!String(operation.shell || "").startsWith("windows-"), `${operation.operation} must not use a Windows shell on a Linux profile`)
    }
  })
})

describe("Windows guest automation profiles", () => {
  it("leaves the Windows profiles on PowerShell and untouched", () => {
    const windowsProfiles = DEFAULT_GUEST_TEMPLATES.filter((template) => template.engine === "windows")
    assert.ok(windowsProfiles.length > 0, "there must be Windows profiles to protect")
    for (const template of windowsProfiles) {
      for (const operation of template.operations as any[]) {
        if (operation.commandType === "guest-native") continue
        assert.ok(String(operation.shell || "").startsWith("windows-"), `${template.name}/${operation.operation} must stay on a Windows shell`)
      }
    }
  })
})

describe("Ubuntu netplan network template", () => {
  const op = (slug: string, name: string) => {
    const profile = DEFAULT_GUEST_TEMPLATES.find((template) => template.slug === slug)
    assert.ok(profile, `the ${slug} guest profile must exist in the seed`)
    const found = (profile!.operations as any[]).find((operation) => operation.operation === name)
    assert.ok(found, `${name} must be seeded on ${slug}`)
    return found as any
  }

  it("configures every Ubuntu image through netplan, not ifupdown", () => {
    for (const slug of ["ubuntu-2004-2204", "ubuntu-24-04"]) {
      for (const name of ["set_ip", "set_gateway", "set_dns"]) {
        assert.ok(String(op(slug, name).command).includes("/etc/netplan"), `${slug}/${name} must configure the guest through netplan`)
        assert.ok(!String(op(slug, name).command).includes("/etc/network/interfaces"), `${slug}/${name} must not write an ifupdown file on a netplan image`)
      }
    }
  })

  it("keeps Debian on ifupdown", () => {
    for (const slug of ["debian-11", "debian-12"]) {
      assert.ok(String(op(slug, "set_ip").command).includes("/etc/network/interfaces.d"), `${slug}/set_ip must keep using ifupdown, which is what Debian ships`)
    }
  })

  it("writes valid netplan YAML, with no stray backslash before a newline", () => {
    const stray = ["\\", "\\", "n"].join("")
    for (const slug of ["ubuntu-2004-2204", "ubuntu-24-04"]) {
      for (const name of ["set_ip", "set_gateway"]) {
        const command = String(op(slug, name).command)
        assert.ok(!command.includes(stray), `${slug}/${name} must not emit a literal backslash before a newline`)
        assert.ok(command.includes("chmod 600"), `${slug}/${name} must keep netplan's 0600 requirement`)
      }
    }
  })

  it("never lets set_dns overwrite the address document", () => {
    for (const slug of ["ubuntu-2004-2204", "ubuntu-24-04"]) {
      const command = String(op(slug, "set_dns").command)
      assert.ok(!command.includes("dhcp4: true"), `${slug}/set_dns must not switch the interface back to DHCP`)
      assert.ok(!command.includes("99-zws.yaml"), `${slug}/set_dns must never touch the address document`)
      assert.ok(command.includes("98-zws-dns.yaml"), `${slug}/set_dns must own a separate document that netplan merges with the address`)
    }
  })

  it("reads the applied netplan configuration back before claiming success", () => {
    for (const slug of ["ubuntu-2004-2204", "ubuntu-24-04"]) {
      assert.ok(String(op(slug, "set_dns").command).includes("netplan get"), `${slug}/set_dns must confirm the nameserver landed in the rendered configuration`)
    }
  })
})

const provisionSource = readFileSync(join(process.cwd(), "lib/provision.ts"), "utf8")

describe("Windows guest network evidence", () => {
  it("stays on PowerShell and keeps the fixed single-quoted form", () => {
    assert.ok(provisionSource.includes("Get-NetIPConfiguration"), "the Windows evidence read must still be there")
    assert.ok(!provisionSource.includes('"$ip = @'), "the mid-line here-string must not come back: it is a ParserError")
    assert.ok(provisionSource.includes(`"$ip = '" + String(expectedIp || "").replace(`), "the IP must be interpolated as a plain quoted string, with the quote character stripped")
  })

  it("keeps the adapter selection order that was proven against a real guest", () => {
    const expectedIpAt = provisionSource.indexOf("Get-NetIPConfiguration | Where-Object { $ip -and")
    const hardwareAt = provisionSource.indexOf("Get-NetAdapter | Where-Object { $_.HardwareInterface")
    const gatewayAt = provisionSource.indexOf("Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway }")
    assert.ok(expectedIpAt > -1 && hardwareAt > expectedIpAt && gatewayAt > hardwareAt, "adapter selection must stay: expected IP, then Up hardware adapter, then default-gateway adapter")
  })
})