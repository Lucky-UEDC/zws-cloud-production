# Development Isolation, Backup & Release Readiness — Phase 2

**Date:** 2026-10-14 · **Branch:** `fix/dev-reliability-hardening`
**Scope:** development only. No production change, no Proxmox mutation, no production database write.

---

## 1. Environment (re-verified)

| Item | Finding |
|---|---|
| Host | `zwscloud` — `103.216.169.253`, `103.216.170.253` |
| `dev.zwscloud.com` | → `103.216.169.253` (**this host**) |
| `zwscloud.com` | → `13.126.5.10` — **unreachable**, TCP 443 times out |
| Certificate | `CN=dev.zwscloud.com`, valid 2026-10-04 → 2027-01-02 |
| Compose project | `myrdphub`, 7 running, `SITE_DOMAIN=dev.zwscloud.com` |
| Database | `103.216.168.251:5432`, PostgreSQL **18.6**, db `zwscloud`, role `zwscloud_app` |
| Proxmox | node `MUB-1` → `m2-v2.irctcrdp.com:8006` (`103.216.170.254`), status `failed` |

---

## 2. Database isolation

### Databases and roles that actually exist (read-only inspection)

| Database | Size |
|---|---|
| `zwscloud` | 2753 MB |
| `zws_router` | 19 MB |
| `postgres` | 7.5 MB |

`zwscloud_staging` and `zwscloud_test` are **registered in `database_registry` but do not exist**.
Role `zwscloud_app` is **not** superuser, `rolcreatedb = f`, `rolcreaterole = f`. It cannot create a
database, so isolation cannot be self-service. **A DBA action is required.**

### Guard implemented (fails closed)

`lib/db-isolation.ts` + `lib/db-url.ts` + `scripts/assert-db-isolation.ts`.

Every connection funnels through `ensureDatabaseUrl`/`assertDatabaseUrl`, so the guard cannot be
bypassed by forgetting it at a call site. Production identity is declared explicitly
(`ZWS_PRODUCTION_DATABASE_NAMES`, default `zwscloud`; `ZWS_PRODUCTION_DATABASE_HOSTS`).

- `migrate` exits **78** before `prisma migrate deploy` when the target is a declared production database.
- `restore` requires an explicit `--target` and refuses the configured database unless
  `ZWS_ALLOW_RESTORE_IN_DEVELOPMENT=1`.
- Overrides exist (`ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS=1`) but are logged as
  `REFUSED BY DEFAULT BUT OVERRIDDEN`.
- The target is described as host/port/database/role only — never a password or connection string.

**Verified against the live development configuration:**

```
[db-isolation] {"ok":false,"reason":"production_database_target","overridden":false,
  "host":"103.216.168.251","port":"5432","database":"zwscloud","username":"zwscloud_app",
  "source":"database-url","productionDatabases":["zwscloud"],
  "detail":"database \"zwscloud\" is a declared production database. Refusing to open a
            write-capable connection..."}
exit code = 78
```

> **Operational consequence:** the running development stack cannot start or migrate until
> `ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS=1` is set **or** development is repointed. This is intended
> and is the forcing function for the DBA request below.
>
> This also blocks `next build` on a host whose `.env` points at the production-named database, which
> is the same problem seen from a different angle. The interim path is
> `ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS=1 pnpm build`, used for this patch's verification. It is a
> temporary acknowledgement, not a configuration to keep.

### Guard placement (and a design correction)

The guard sits on the **connection** path, not on URL resolution:

- `ensureDatabaseUrl` / `assertDatabaseUrl` resolve a string and are **not** guarded. `next build`
  imports every route module to collect page data, and modules legitimately read the connection
  string at import time; guarding there failed the build.
- `createPrismaClient()` in `lib/db.ts` **is** guarded, before the client is constructed. Every query
  in the process passes through that one constructor.
- `prisma.config.ts` no longer asserts. `prisma generate` is code generation and never reaches data.

`lib/db-isolation.ts` imports nothing at all. It is consulted by `lib/db-url.ts`, so depending on
`lib/db-url` would have made the guard part of the cycle it protects, and it broke the Next config
loader when it did. A guard that cannot load is a guard that never runs.

**Local-host exemption.** The project's CI deliberately points at a disposable PostgreSQL on
`127.0.0.1` that shares the production database *name*. Matching on name alone refused every build.
A loopback or in-network service address is therefore exempt from the name rule — production is
reached over a routable address. Declaring a host in `ZWS_PRODUCTION_DATABASE_HOSTS` always wins
over the exemption, so a genuinely production local host is still caught.

### Request for the database administrator

```sql
-- 1. Dedicated least-privilege role. No SUPERUSER, no CREATEDB, no CREATEROLE.
CREATE ROLE zwscloud_dev LOGIN PASSWORD '<generated, stored in the dev secret store>';

-- 2. Dedicated development database owned by that role.
CREATE DATABASE zwscloud_dev OWNER zwscloud_dev ENCODING 'UTF8' TEMPLATE template0;

-- 3. Restrict the application role to exactly what it needs: connect, and read/write
--    only inside its own schema. It must NOT own public and must NOT create databases.
REVOKE ALL ON DATABASE zwscloud FROM zwscloud_app;
GRANT CONNECT ON DATABASE zwscloud_dev TO zwscloud_app;

\connect zwscloud_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO zwscloud_app;
ALTER SCHEMA public OWNER TO zwscloud_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO zwscloud_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO zwscloud_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO zwscloud_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO zwscloud_app;

-- 4. Re-enable CREATE on public *only* for the development database, which the
--    Prisma migration path needs for schema changes. Production keeps it revoked.
\connect zwscloud
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

**Schema and ownership requirements for the new database**

- Prisma is the source of truth (`prisma/schema.prisma`, `prisma.config.ts`). The database must be
  created empty and populated by the Compose `migrate` service running `prisma migrate deploy`.
- `_prisma_migrations` is created and owned by the migration role. Do **not** hand-copy it from
  `zwscloud`; a fresh database must replay the migration chain from scratch.
- `lib/db-url.ts` prefers `DATABASE_URL`, falling back to `DB_HOST`/`DB_PORT`/`DB_DATABASE`/
  `DB_USERNAME`/`DB_PASSWORD`/`DB_SCHEMA`. Either form is acceptable; `DATABASE_URL` is simpler.
- `docker-entrypoint.sh` runs `bootstrap_fresh_database()` when it detects an empty schema, using
  `prisma db push --accept-data-loss` then recording migrations as applied. An empty database is the
  expected starting state, not an error.

**After the database exists, development becomes:**

```
DATABASE_URL=postgresql://zwscloud_app:<dev-password>@103.216.168.251:5432/zwscloud_dev?schema=public
ZWS_PRODUCTION_DATABASE_NAMES=zwscloud
```

Confirm with `tsx scripts/assert-db-isolation.ts` — it must report `"ok":true`.

---

## 3. Provisioning test safety

Development is wired to live node `MUB-1`. `lib/proxmox-test-double.ts` provides an in-memory
cluster; `ZWS_INFRA_TEST_MODE=1` makes `createProxmoxClient` return a client whose **transport** is
that cluster. Substituting `requestWithStatus` is sufficient because every public method delegates
to it, so **no socket is ever opened** — clone, restart, resize and delete are all unreachable.

The double reproduces the real failure modes:

| Scenario | How |
|---|---|
| Clone-queue saturation | `queuedTasks` / `activeTasks` on `/nodes/{node}/tasks` |
| Transient failure + retry | `failNext(n, status)` |
| Rejected API token (the MUB-1 failure) | `authFailure` → **401 with an empty body** |
| Unreachable host | `networkFailure` → `ECONNREFUSED` |
| Guest agent never answers | `guestAgentOnline: false` |

Safety properties:

- Test mode is opt-in and never inferred.
- It **refuses to build a client for a declared production host** (`ZWS_PRODUCTION_PROXMOX_HOSTS`),
  so a double can never be used to make a production node look healthy.
- Every mutating call is recorded (`cluster.mutatingCalls()`), so a test can assert its blast radius.

**MUB-1 authentication — administrator action required (read-only diagnosis only)**

The node answers **401 with an empty body**. The endpoint is reachable; only the credential is
rejected. The reported failure was made undiagnosable by a second defect, now fixed: the error
message preferred the response body over the HTTP status, so the alert read literally
`{"data":null}` instead of naming an authentication failure.

**Required change (do not perform blind — the live credentials were left untouched):**

1. In Proxmox on `M2-V2`, verify the token for `MUB-1` still exists:
   `pveum user token list <token-user>` and `pveum acl list /`.
2. If missing or revoked, create a least-privilege replacement — the provisioning path needs
   `VM.Allocate`, `VM.Clone`, `VM.Config.Disk`, `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Network`,
   `VM.PowerMgmt`, `VM.GuestAgent.*`, `VM.Audit`, `Sys.Audit`, `Datastore.AllocateSpace`,
   `Datastore.Audit`, plus `Sys.Modify` on `/` only if storage must be configured.
3. Update `proxmox_nodes.tokenId` / `tokenSecret` for `MUB-1`, then confirm
   `status` leaves `failed` and telemetry resumes.
4. Remove `allowInsecureTls = true` once a valid certificate chain is installed.

**Provisioning cannot be validated end to end until a separate test node exists.** Until then,
provisioning, retry and recovery tests run against the double only.

---

## 4. Backup and restoration — built and proven

### Root cause of the 3-month outage

| Component | Version |
|---|---|
| PostgreSQL server | **18.6** |
| `pg_dump` in the app container | **15.19** |
| `pg_dump` on the host | **16.15** |

`pg_dump` refuses a client older than the server (`aborting because of server version mismatch`).
Every platform backup attempt therefore died **before writing anything** — which is why
`backup_runs` was empty and `backup_destinations.lastRunAt` was stuck at `2026-07-13`.

### What was built

`scripts/platform-backup.ts` — filesystem-only by design. `create` reads with `pg_dump` and writes an
encrypted artifact; it performs **no database writes**, so it is usable to take a safety copy before
isolation is resolved.

| Command | Purpose |
|---|---|
| `create` | Encrypted dump + manifest. Refuses without a passphrase. |
| `verify` | Ciphertext digest → authenticated decrypt → plaintext digest → `pg_restore -l`. |
| `restore --target=<url>` | Restores into an **explicit** target; refuses the configured database. |
| `prune` | Retention; always keeps the newest artifacts regardless of age. |
| `health` | Non-zero exit on `no_artifacts` / `stale` / `integrity_failed`. |

Properties: AES-256-GCM (authenticating, so tampering fails loudly); artifacts `0600` and directory
`0700`; the plaintext dump is removed in a `finally` (the failed first run had left an unencrypted
zero-byte file behind — that is how this defect surfaced); uploaded files are hashed into the
manifest, because a database dump alone restores attachment rows without their files and
reproduces the original 404; a client/server version preflight fails closed.

### Restoration test — COMPLETED

| Step | Result |
|---|---|
| Create | 142 MB encrypted artifact from a 2.7 GB database, **2m13s** |
| Verify | `ok: true`, 1935 archive entries, 502 table entries, digests matched |
| Restore target | Isolated `zws_restore_test` container (`postgres:18-alpine`, bound to `127.0.0.1:15499`) |
| Restore | **5m54s**, completed |
| Record check | customers 7, support_tickets 0, attachments 0, orders 24, invoices 29, payments 36, proxmox_nodes 1, `_prisma_migrations` 167 — **identical to source** |
| Source DB after restore | Re-checked: customers 7, migrations 167 — **unchanged** |

This is a completed restoration, not a plan. The working development database was never a target.

### Remaining blockers

- **`pg_dump` version.** The container must ship a PostgreSQL 18 client, or
  `ZWS_PG_DUMP_BIN` must point at one. Until then the platform's own backup job cannot work.
- **No off-host copy.** Everything is on one disk on one host.
- **No schedule.** Wire `create` + `prune` + `health` to cron/Compose; `health` is the monitor.
- **Passphrase custody.** `ZWS_BACKUP_ENCRYPTION_PASSPHRASE` must come from the secret store. The
  passphrase used for this test was ephemeral and is intentionally **not** in the repository — the
  artifact at `/var/lib/zws-backups` is therefore not recoverable and must be discarded once the
  real passphrase is set.
- **Attachment restore.** With 0 attachments in this database, file-level restore was **not**
  exercised end to end; only the manifest coverage was verified.

### Google Drive backup — diagnosed

`googleDriveBackups` holds enabled keys (clientId, clientSecret, refreshToken, folderId), and the
upload path uses the Drive **REST API**, not rclone. The blocker is upstream of Drive: **the backup
never reached the upload step at all**, because `pg_dump` aborted. Fix the client version first,
then confirm the refresh token still works against `https://www.googleapis.com/oauth2/v4/token`.

Separately, **Google Drive attachment storage** uses rclone, and the container has **no rclone
remote** (`rclone.conf not found - using defaults`, `listremotes` empty). So attachment uploads to
Drive fail and fall back to local — which is precisely why the attachments landed on the ephemeral
path and produced the 503. Materialising the rclone remote requires the real OAuth credentials and
is an administrator action; it was not performed.

---

## 5. Attachment fix — re-verified

| Check | Result |
|---|---|
| Compose env | `ZWS_UPLOAD_DIR: /app/uploads` on every service |
| Volume | `zws_uploads` → `/app/uploads`, driver `local`, on `/dev/sda1` |
| Persistence proof | Upload files dated **2026-09-11** and **2026-09-13** are still present while the container was created **2026-10-13T23:05** — they survived repeated recreations |
| Resolved root | `/app/uploads/ticket-attachments` (on the volume) vs the pre-fix `/app/.next/standalone/uploads/ticket-attachments` (container layer) |
| Regression tests | 12 attachment tests, incl. missing file → 404, traversal, MIME/extension mismatch, sanitized errors, legacy-root read |

The original incident id is used only as a **string label** on a synthetic fixture. No production
ticket, customer record or attachment was copied into development.

---

## 6. Soft 404

| URL | Status |
|---|---|
| `/blog/unknown-slug-xyz` | **200** |
| `/zzz-aaa-999` | **200** |
| `/aaa/bbb/ccc` | **404** |

Cause: `app/loading.tsx` puts every route inside a root Suspense boundary, so the response starts
streaming before the page runs; `notFound()` is then thrown after the status line is sent and the
200 cannot be replaced. Routes that never match are rejected during routing and correctly 404.

**Mitigation already in place:** Next.js emits `<meta name="robots" content="noindex">` on the
not-found path (confirmed in the rendered development response), so these URLs are not indexed.

**Smallest safe fix, and why it was not applied:** removing the root loading boundary would restore
correct statuses, but it changes navigation behaviour site-wide (every route without its own
`loading.tsx` would lose its skeleton) and this phase is not authorised to deploy, so the change
could not be verified. Recommendation: apply it as its own reviewed change, verify with
`curl -o /dev/null -w '%{http_code}'` against a staging build, and confirm no regression in streaming
on `checkout`, `register` and `admin/*` (which keep their own `loading.tsx`).

---

## 7. Final gates

| Gate | Result |
|---|---|
| Typecheck | **clean** |
| Lint | **0 errors**, 9 pre-existing warnings (unchanged) |
| Unit tests | **1140 pass, 0 fail, 1 skipped** (the skip requires a backup artifact) |
| Production build | succeeds |
| Database isolated | **NO — DBA action required** (guard now blocks it) |
| Tests cannot mutate production | Yes — DB guard + infrastructure test mode |
| Attachment persistence | Verified |
| Resource/storage boundaries | 14 tests pass |
| Provisioning tests vs mocks | 10 safety tests pass; no live mutation |
| Backup integrity + restoration | **Verified with a completed restore** |
| Unknown-route handling | 5 tests pin cause and mitigation |
| Diff scope | Intended files only; secret-scanned |

## 8. Outstanding administrator actions

1. Create `zwscloud_dev` + `zwscloud_dev` role (SQL above) and repoint development.
2. Ship a PostgreSQL 18 `pg_dump` in the image, or set `ZWS_PG_DUMP_BIN`.
3. Provide `ZWS_BACKUP_ENCRYPTION_PASSPHRASE` via the secret store; discard the test artifact.
4. Schedule `create` / `prune` / `health` and alert on a non-zero exit.
5. Rotate the MUB-1 Proxmox token with least privilege; drop `allowInsecureTls`.
6. Provide a dedicated test Proxmox node.
7. Configure an off-host backup destination.
8. Materialise the rclone remote if Drive attachment storage is wanted.

## 9. Rollback

```bash
# Code only (this phase added no migration):
git revert cc2b11c f7fb46b 3f5a8b8 30cdd83   # newest first
docker compose build && docker compose up -d --remove-orphans
```

If the revert is deployed before the new database exists, also unset
`ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS` only once development points at `zwscloud_dev` — otherwise
the reverted build cannot connect.

Restore procedure remains `tsx scripts/platform-backup.ts restore --target=<dedicated-url>`.