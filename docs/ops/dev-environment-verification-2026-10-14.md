# Development Environment Verification & Release Readiness
**Date:** 2026-10-14 · **Branch:** `fix/dev-reliability-hardening` · **Base:** `main` @ `546c8ce`
**Scope:** development-only investigation. No production change was made or attempted.

---

## 1. Environment verification

| Item | Finding |
|---|---|
| Hostname | `zwscloud` (public IPs `103.216.169.253`, `103.216.170.253`) |
| App directory | `/var/www/myrdphub` |
| `dev.zwscloud.com` | resolves to `103.216.169.253` — **this host** |
| `zwscloud.com` | resolves to `13.126.5.10` — **a different host**, unreachable from here |
| Git branch / commit | `fix/dev-reliability-hardening` from `main` @ `546c8ce` |
| Working tree | clean at session start |
| Compose project | `myrdphub`, 7 containers running, image `zws-cloud:latest` |
| `SITE_DOMAIN` | `dev.zwscloud.com` |
| TLS certificate | `CN=dev.zwscloud.com`, valid 2026-10-04 → 2027-01-02 |
| App URL / NextAuth URL | `https://dev.zwscloud.com` |
| Database | **external**, `103.216.168.251:5432`, database `zwscloud`, role `zwscloud_app` |
| Redis | in-network `redis://redis:6379/0` |

**Conclusion: this host is the development environment.** It is not production.

### Did the earlier `git push origin main` / `docker compose up -d --force-recreate` touch production?

- **Docker Compose — development only.** The stack on this host is configured with
  `SITE_DOMAIN=dev.zwscloud.com` and the `dev.zwscloud.com` certificate. It serves
  `dev.zwscloud.com` only. No production container exists on this host.
- **Git push — shared repository, no auto-deploy.** `origin/main` is shared, so the
  push did publish to the branch production builds from. However `.github/workflows/ci.yml`
  runs only `validate` (typecheck/lint/test/build) and a Docker image build with
  `push: false`. **There is no deploy job.** The update centre
  (`lib/updates/releases.ts`) polls GitHub *Releases*, not `main`. So no automatic
  production deployment was triggered.
- **Recommendation:** do not commit directly to `main`. Use a feature branch and a
  reviewed PR, so CI validation runs without publishing to the production build branch.

---

## 2. Open risk: the development database is the `main`-role database

This is the single most important finding and it is **unresolved**.

- `database_registry` defines three roles — `main` → `zwscloud`, `staging` → `zwscloud_staging`,
  `test` → `zwscloud_test`.
- The development stack is pointed at the **`main`** role database, `zwscloud`.
- `zwscloud_staging` and `zwscloud_test` **do not exist** on `103.216.168.251`
  (only `postgres`, `zws_router`, `zwscloud` exist).
- The application role `zwscloud_app` is **not** superuser and lacks `CREATEDB`/`CREATEROLE`,
  so a development database cannot be created from this connection.

Evidence that production is *currently* not using this database:

- `pg_stat_activity` shows all 37 connections to `zwscloud` originate from
  `103.216.169.253` (this development host). No connection from `13.126.5.10`.
- The reported production attachment `cmuw8p8by06lepj07mn7ot4c1` does **not** exist here,
  and `support_tickets` / `support_ticket_attachments` are both **0 rows**.

Risk that remains: production is currently unreachable, so this cannot be treated as
proof. If production is pointed at the same host and database when it returns, any
migration or data write performed from development becomes a production change.

**Required action before any database work:** a DBA creates `zwscloud_test` (or
`zwscloud_staging`) on `103.216.168.251` and development is repointed at it. Until then,
development must stay on code-only changes with no migrations and no data writes.

### Development is also wired to real infrastructure

`proxmox_nodes` contains one node, `MUB-1` → `https://m2-v2.irctcrdp.com:8006`
(`103.216.170.254`), with live credentials stored in the database. Provisioning,
telemetry and VM lifecycle work executed from development therefore acts on real
virtual machines. A separate test node is required before provisioning changes can be
exercised end to end.

---

## 3. Backup and disaster recovery

### Verified current state

| Check | Result |
|---|---|
| Backup volume `myrdphub_zws_backups` | mounted, driver `local`, on persistent `/dev/sda1` — **durable across restarts** |
| Contents of the backup volume | **empty (0 files)** |
| `backup_runs` rows | **0** |
| `backup_restore_tests` rows | **0** |
| `backup_destinations.lastRunAt` | **2026-07-13** — ~3 months stale |
| Host cron for database backups | none installed |
| Application backup tooling | present and complete |

There is **no recoverable backup of this database on this host.** Any migration,
schema change or storage change performed now has no rollback artifact. This blocks
promotion to production and must be resolved first.

Note: `backup_plans` holds *customer-facing products to sell* (e.g. "Demo Backup", ₹199).
It is not the platform's own backup configuration — that is `backup_destinations`.

### Available tooling (already implemented, not yet exercised)

`scripts/docker-backup.ts` provides three commands:

```bash
pnpm docker:backup  -- create a backup artifact          # writes backup_runs
pnpm docker:backup retention                            # prune expired artifacts
pnpm docker:backup restore -- --file=<artifact> --dry-run   # DRY_RUN, no data change
pnpm docker:backup restore -- --file=<artifact> --confirm=<token>  # MERGE_RESTORE
```

Restore is **merge-first** and requires an explicit confirmation token, so an accidental
restore cannot silently overwrite production data. Related tooling:
`scripts/detect-backup-artifact.ts`, `scripts/merge-backup-artifact.ts`,
`scripts/backup-scheduler.ts`, `scripts/rclone-backup.ts`.

### Restoration test — NOT performed

A restoration test was **not** carried out in this session, for three reasons:

1. `createBackup` writes a `backup_runs` row — a database write, which was out of scope.
2. No database writes were authorized on a database shared with the `main` role.
3. There are currently **zero backup artifacts** to restore from.

Procedure once writes are authorized (development only):

```bash
# 1. Create a baseline artifact.
pnpm docker:backup -- triggerType=docker scope=database

# 2. Prove the artifact is readable and structurally intact.
pnpm docker:backup restore -- --file=<artifact-path> --dry-run

# 3. Restore into a scratch database, never over the live one.
createdb zws_restore_test
psql "postgresql://…/zws_restore_test" -f <artifact-path>
psql "postgresql://…/zws_restore_test" -c "SELECT count(*) FROM customers;"

# 4. Record the outcome.
#    INSERT INTO backup_restore_tests (...)  -- record pass/fail and timing
```

A backup is only considered verified once step 3 returns a usable database and the row
counts match the source. A job reporting `completed` is **not** evidence.

### Proposed retention (needs approval)

| Data | Retention | Rationale |
|---|---|---|
| Database, daily full | 14 days | Covers the realistic "bad release discovered late" window |
| Database, weekly full | 8 weeks | Survives a month-end billing dispute |
| Database, monthly full | 12 months | Annual financial/audit window |
| Ticket attachments | 90 days | Mirrors the database window plus a month |
| VM backups (Proxmox) | per existing backup platform policy | Not modified by this patch |

**Assumptions:** single-site deployment; no regulatory retention obligation has been
confirmed for this business; RPO 24h and RTO 4h are *proposed*, not agreed. Indian
DPDP obligations and any sector-specific retention rules require legal review before
these numbers are adopted.

### Gaps that must close before production

1. **No verified backup exists.** Highest priority.
2. **No off-host copy.** Everything is on one disk on one host. The `local` destination
   gives no protection against host or provider loss.
3. **Backups stopped on 2026-07-13** with no alert having surfaced it. Backup freshness
   must be monitored and must raise an alert, not merely be recorded.
4. **The Google Drive backup destination has never produced a run.** The failure was not
   reproduced in this session because exercising it would require a database write.
   It needs separate diagnosis against the `google_drive` integration config.
5. **Retention is configured (30 days) but never applied**, because no run has occurred.
6. No scheduled restoration test exists.

---

## 4. Production deployment and rollback procedure

### Preconditions (all must hold)

1. A verified, restorable backup exists and a restoration test has passed.
2. Development and production are on **separate databases**, confirmed by
   `SELECT client_addr, count(*) FROM pg_stat_activity WHERE datname='zwscloud'`.
3. A dedicated test Proxmox node exists, so provisioning changes never touch production VMs.
4. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` are green.
5. The change has been reviewed as a PR rather than pushed to `main` directly.

### Deploy

```bash
git checkout main && git pull --ff-only origin main
docker compose build
docker compose up -d --remove-orphans     # applies migrations via the `migrate` service
docker compose ps                          # every service must report healthy
```

Never use `prisma db push` or ad hoc SQL in production; migrations go through the
Compose `migrate` service only.

### Verify after deploy

```bash
curl -fsS https://zwscloud.com/api/health
curl -fsSI https://zwscloud.com/            # 200, correct CSP and security headers
docker compose logs -f --tail=200 app      # watch for errors during the first minutes
```

Then manually confirm: login, a paid order reaching fulfilment, a ticket upload with a
successful inline preview and download, and the admin node-capacity screen.

### Rollback

**Code-only rollback (no migration):**

```bash
git revert <merge-sha>
docker compose build && docker compose up -d --remove-orphans
```

**Rollback requiring a schema change:** Prisma migrations are additive and guarded, so
the safe path is a forward fix. Do not drop columns to "roll back". If a forward fix is
impossible, restore from the verified pre-change artifact — this is a data-affecting
operation and must be scheduled, not improvised.

---

## 5. Outstanding risks

| # | Risk | Severity |
|---|---|---|
| 1 | Development is pointed at the `main`-role database; no separate dev DB exists | **Critical** |
| 2 | No verified backup of that database exists | **Critical** |
| 3 | Development is wired to real Proxmox node `MUB-1` | High |
| 4 | `MUB-1` API token is rejected (HTTP 401) — telemetry has been failing since ~2026-10-13 14:14 | High |
| 5 | Backups stopped 2026-07-13 with no alerting | High |
| 6 | Work was committed directly to `main` and pushed | Medium |
| 7 | Unknown URLs return HTTP 200 (soft 404); mitigated by `noindex` meta | Medium |
| 8 | Guest network configuration may not be idempotent — **uninvestigated** | Unknown |