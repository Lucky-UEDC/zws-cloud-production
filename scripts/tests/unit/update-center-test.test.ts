import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseSemver, compareSemver, getBuildInfo } from "@/lib/build-info"
import { validateReleaseManifest, isValidDigest, isValidMigrationName } from "@/lib/updates/releases"

function read(path: string) {
  return readFileSync(path, "utf8")
}

const SOURCE = { repo: "zws-cloud/zws-cloud", token: null, imagePrefix: "zws-cloud", enabled: true }

// ------------- Problem D: compact multi-stage build + immutable tags -------------

test("PART33 Dockerfile keeps the 3-stage multi-stage layout with no full-source runner copy", () => {
  const dockerfile = read("Dockerfile")
  assert.match(dockerfile, /FROM node:22-bookworm AS deps/)
  assert.match(dockerfile, /FROM deps AS build/)
  assert.match(dockerfile, /FROM node:22-bookworm AS runner/)
  // The runner must NOT receive the full source tree.
  assert.ok(!/COPY \. \./.test(dockerfile.split("FROM node:22-bookworm AS runner")[1] ?? ""))
})

test("PART33 build bakes immutable identity (version/commit/date) + image labels", () => {
  const dockerfile = read("Dockerfile")
  // The default must track package.json. Pinning a literal here meant every
  // release bump failed a test that is only about the build wiring.
  const version = (JSON.parse(read("package.json")) as { version: string }).version
  assert.match(dockerfile, new RegExp(`ARG APP_VERSION=${version.replace(/\./g, "\\.")}`))
  assert.match(dockerfile, /ARG APP_COMMIT/)
  assert.match(dockerfile, /ARG APP_SOURCE_DATE/)
  assert.match(dockerfile, /runtime-info\.json/)
  assert.match(dockerfile, /org\.opencontainers\.image\.version/)
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/)
  assert.match(dockerfile, /COPY --from=build .*\/app\/runtime-info\.json/)
})

test("PART33 compose passes build metadata args", () => {
  const compose = read("docker-compose.yml")
  const version = (JSON.parse(read("package.json")) as { version: string }).version
  assert.match(compose, new RegExp(`APP_VERSION: \\$\\{APP_VERSION:-${version.replace(/\./g, "\\.")}\\}`))
  assert.match(compose, /APP_COMMIT: \$\{APP_COMMIT:-\}/)
})

test("PART33 dockerignore excludes audits, reports, uploads, logs", () => {
  const ignore = read(".dockerignore")
  for (const entry of ["audits", "reports", "uploads", "node_modules", "*.log"]) {
    assert.ok(ignore.split("\n").map((l) => l.trim()).includes(entry), `.dockerignore must contain ${entry}`)
  }
})

// ------------- Part 13: versioning -------------

test("PART13 package.json version matches the Dockerfile default", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string }
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "version must be semver")
  const dockerfile = read("Dockerfile")
  assert.match(dockerfile, new RegExp(`APP_VERSION=${pkg.version}`))
})

test("PART13 version endpoint exists and is cache-free", () => {
  const route = read("app/api/runtime/version/route.ts")
  assert.match(route, /getBuildInfo\(\)/)
  assert.match(route, /Cache-Control.*no-store/)
  assert.match(route, /force-dynamic/)
})

test("PART13 semver helpers parse and compare correctly", () => {
  assert.deepEqual(parseSemver("1.1.0"), { major: 1, minor: 1, patch: 0 })
  assert.equal(parseSemver("latest"), null)
  assert.equal(parseSemver("1.1"), null)
  assert.ok(compareSemver("1.2.0", "1.1.9") > 0)
  assert.ok(compareSemver("1.1.0", "1.1.0") === 0)
  assert.ok(compareSemver("1.0.0", "1.1.0") < 0)
})

test("PART13 build info resolves a default identity", () => {
  const info = getBuildInfo()
  assert.equal(info.version, "1.1.0")
  assert.equal(info.image, "zws-cloud")
  assert.ok(["runtime-info", "env", "package"].includes(info.source))
})

// ------------- Problem E: Update Center -------------

test("PART34 digest and migration validators are strict", () => {
  assert.ok(isValidDigest("sha256:" + "a".repeat(64)))
  assert.ok(!isValidDigest("sha256:abc"))
  assert.ok(!isValidDigest("md5:" + "a".repeat(64)))
  assert.ok(isValidMigrationName("20260925_add_deployments"))
  assert.ok(!isValidMigrationName("../../etc/passwd"))
  assert.ok(!isValidMigrationName("DROP TABLE backups"))
  assert.ok(!isValidMigrationName(""))
})

test("PART34 manifest validation rejects untrusted images and mismatched tags", () => {
  const validManifest = {
    version: "1.2.0",
    image: "zws-cloud:1.2.0",
    digest: "sha256:" + "a".repeat(64),
    migrations: ["20260925_add_deployments"],
    minVersion: "1.1.0",
  }
  assert.equal(validateReleaseManifest(validManifest, "v1.2.0", SOURCE), null)

  assert.ok(validateReleaseManifest({ ...validManifest, image: "evil-registry/zws-cloud:1.2.0" }, "v1.2.0", SOURCE))
  assert.ok(validateReleaseManifest({ ...validManifest, image: "zws-cloud:1.2.0" }, "v1.3.0", SOURCE))
  assert.ok(validateReleaseManifest({ ...validManifest, digest: "sha256:not-a-digest" }, "v1.2.0", SOURCE))
  assert.ok(validateReleaseManifest({ ...validManifest, version: "not-semver" }, "v1.2.0", SOURCE))
})

test("PART34 apply path accepts only semver versions and never executes free-form input", () => {
  const apply = read("lib/updates/apply.ts")
  assert.match(apply, /UPDATE_APPLY_SCRIPT/)
  assert.match(apply, /^[^]*spawn\(script, \[version, imageRef, deploymentId, adminEmail\]/m)
  assert.match(apply, /scripts\/apply-release\.sh/)
  assert.match(apply, /update:running/)
})

test("PART34 apply-release.sh is fixed, validates args, snapshots DB before migrate", () => {
  const script = read("scripts/apply-release.sh")
  assert.match(script, /apply-release\.sh <version> <imageRef>/)
  assert.match(script, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/)
  assert.match(script, /pg_dump/)
  assert.match(script, /gzip -t/)
  assert.match(script, /run --rm migrate/)
  assert.match(script, /runtime\/version/)
  assert.ok(script.startsWith("#!/usr/bin/env bash"))
})

test("PART34 Deployment model is additive in the Prisma schema", () => {
  const schema = read("prisma/schema.prisma")
  assert.match(schema, /model Deployment \{/)
  assert.match(schema, /@@map\("deployments"\)/)
  const migration = read("prisma/migrations/20260925000000_add_deployments/migration.sql")
  assert.match(migration, /CREATE TABLE "deployments"/)
  assert.ok(!/DROP TABLE/.test(migration))
})

test("PART34 Update Center reads its source ONLY from environment, never admin input", () => {
  const releases = read("lib/updates/releases.ts")
  assert.match(releases, /process\.env\.UPDATE_GITHUB_REPO/)
  assert.match(releases, /process\.env\.UPDATE_GITHUB_TOKEN/)
  const apply = read("lib/updates/apply.ts")
  assert.match(apply, /getUpdateSource\(\)/)
  assert.ok(!/request\.body\.repo|body\.repo|body\.script/.test(apply + releases))
})

test("PART34 admin updates API is role-guarded", () => {
  const route = read("app/api/admin/system/updates/route.ts")
  assert.match(route, /getAdminFromCookies\(\)/)
  assert.match(route, /canAccessAdminApi\(admin\.role\)/)
  assert.match(route, /Unauthorized/)
  const detail = read("app/api/admin/system/updates/[id]/route.ts")
  assert.match(detail, /Deployment not found/)
})

test("PART34 no secrets leak into release payloads", () => {
  const route = read("app/api/admin/system/updates/route.ts")
  // The API never returns GitHub tokens or admin credentials — only release
  // metadata. Guard against accidental inclusion of literal secret values.
  assert.ok(!/token[:=]|secret[:=]|password[:=]/.test(route), "no literal secret value may appear")
})