import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const bootstrap = readFileSync(join(process.cwd(), "install.sh"), "utf8")
const direct = readFileSync(join(process.cwd(), "installer/install-direct.sh"), "utf8")
const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8")

describe("installer asks only for domain and admin credentials", () => {
  it("prompts for exactly three things plus a confirmation", () => {
    const prompts = direct.match(/read_tty \w+|read_secret_tty \w+/g) || []
    const names = prompts.map((entry) => entry.split(/\s+/).pop())
    assert.deepEqual(names, ["DOMAIN", "ADMIN_EMAIL", "ADMIN_PASSWORD", "CONFIRM_PASSWORD"])
  })

  it("never asks for git, GitHub, a repository, a branch or a token", () => {
    // Comments may *name* the thing being avoided; only executable references
    // are forbidden, so strip comments before checking.
    const executable = direct
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
    for (const forbidden of ["git clone", "GITHUB_TOKEN", "github_token", "GITHUB_REPO", "gh auth"]) {
      assert.equal(executable.includes(forbidden), false, `installer must not execute ${forbidden}`)
    }
    // A prompt for these would show up as a read_* call naming them.
    for (const forbidden of ["read_tty REPO", "read_tty BRANCH", "read_tty GITHUB", "read_tty TOKEN", "read_secret_tty TOKEN"]) {
      assert.equal(direct.includes(forbidden), false, `installer must not prompt for ${forbidden}`)
    }
    // The bootstrap is allowed to *name* git in a comment that says it does
    // not use it; what matters is that it never executes it.
    const bootstrapExecutable = bootstrap
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
    assert.ok(bootstrap.includes("No GitHub, no git clone"), "the bootstrap must stay free of GitHub")
    assert.equal(bootstrapExecutable.includes("git clone"), false)
    assert.equal(bootstrapExecutable.includes("GITHUB_TOKEN"), false)
  })
})

describe("database is always local", () => {
  it("hardcodes local mode in both the declared and the generated env", () => {
    assert.ok(direct.includes('DATABASE_MODE="local"'), "the installer must declare local mode")
    assert.ok(direct.includes("DATABASE_MODE=local"), "the generated .env must set local mode")
  })

  it("always provisions the local postgres container", () => {
    assert.ok(direct.includes("postgres:5432"), "the app must point at the local postgres service")
    assert.ok(direct.includes("POSTGRES_PASSWORD="), "the local database password must be generated")
  })

  it("leaves the external-database variables empty rather than populated", () => {
    assert.ok(direct.includes("EXTERNAL_DATABASE_URL=\n"), "no external database URL may be generated")
    assert.ok(direct.includes("DOCKER_EXTERNAL_DATABASE_URL=\n"), "no external docker URL may be generated")
  })
})

describe("installer fetches a verified release artifact", () => {
  it("downloads an archive and verifies its checksum", () => {
    assert.ok(direct.includes("$INSTALL_API/release"), "the release archive is fetched over HTTP")
    assert.ok(direct.includes("release.sha256"), "a checksum is fetched")
    assert.ok(direct.includes("sha256sum"), "the checksum is computed")
  })

  it("aborts on a checksum mismatch", () => {
    assert.ok(direct.includes("checksum mismatch"), "a mismatch must abort, not warn")
  })

  it("refuses to continue when no checksum is published", () => {
    // Previously a missing checksum only produced a WARNING and the install
    // continued with an unverified archive. An unverifiable artifact is not
    // installable.
    assert.equal(
      direct.includes("WARNING: Could not verify checksum"),
      false,
      "an unverifiable archive must abort rather than warn",
    )
    assert.ok(direct.includes("No checksum available"), "an absent checksum must be a hard failure")
  })
})

describe("installer configures HTTPS", () => {
  it("installs a temporary certificate only so nginx can start", () => {
    assert.ok(direct.includes("temporary self-signed certificate"), "the temporary certificate must be documented as temporary")
  })

  it("requests Let's Encrypt through certbot", () => {
    assert.ok(direct.includes("certbot/certbot"), "certificates must come from certbot")
    assert.ok(direct.includes("--webroot"), "ACME must use the webroot challenge served by nginx")
  })
})

describe("installer is idempotent", () => {
  it("keeps an existing .env authoritative on reinstall", () => {
    assert.ok(
      direct.includes("On a reinstall an existing .env is authoritative"),
      "a reinstall must not regenerate the database password or encryption key",
    )
  })

  it("must never erase the database or uploads on a second run", () => {
    for (const danger of ["docker compose down -v", "rm -rf ./data", "DROP DATABASE", "docker volume rm"]) {
      assert.equal(direct.includes(danger), false, `installer must never run: ${danger}`)
    }
  })
})

describe("CI docker step is actually inspectable", () => {
  it("loads the built image into the runner daemon", () => {
    // The build ran inside buildx with push=false, so nothing was in the local
    // image store and `docker image inspect` failed on every commit. That is
    // why this workflow had never once been green.
    assert.ok(/load:\s*true/.test(ci), "build-push-action must set load: true")
  })

  it("uses a deterministic, obviously-inspectable tag", () => {
    assert.ok(ci.includes("zws-cloud:ci-${{ github.sha }}"), "the tag must be the commit SHA")
  })

  it("verifies the image exists before measuring it", () => {
    assert.ok(ci.includes("Verify the image exists locally"), "the inspect must be its own step")
    assert.ok(ci.includes("docker image inspect zws-cloud:ci-${{ github.sha }}"), "the same tag must be inspected")
  })

  it("still runs every quality gate", () => {
    for (const gate of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build"]) {
      assert.ok(ci.includes(gate), `CI must run ${gate}`)
    }
    // The Docker gate is build-push-action, not a literal `docker build`.
    assert.ok(ci.includes("docker/build-push-action"), "CI must build the Docker image")
    assert.ok(ci.includes("target: runner"), "CI must build the same target production runs")
    assert.ok(ci.includes("docker image inspect"), "CI must verify the image it built")
  })

  it("resolves the pnpm version from packageManager", () => {
    assert.equal(/pnpm\/action-setup[\s\S]{0,200}version:\s*\d/.test(ci), false, "a second pinned pnpm version must not conflict with packageManager")
  })
})
