# Agent Notes

## Repo Contract

- Work in `/var/www/myrdphub`.
- Preserve existing dirty baseline unless the user explicitly asks to revert it.
- Use `pnpm` for installs, tests, builds, and scripts.
- Do not commit real secrets or generated runtime artifacts.
- Treat payment, invoice, auth, provisioning, backups, and WhatsApp as shared production contracts.

## Deployment Process

- Develop changes on a feature branch and stage only files that belong to the requested fix.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` before marking a change deployable.
- Production deploys are Docker-first through `docker compose up -d --build --remove-orphans`.
- Apply database migrations through the Compose `migrate` service; do not use ad hoc schema pushes in production.
- Do not add host Node.js, PM2, or manual Prisma setup to installer paths.

## Evolution API Setup

- WhatsApp delivery is Evolution API only.
- Required settings are Server URL, Global API Key, Instance ID, and Instance Token.
- The app generates the webhook URL as `/api/whatsapp/webhook`.
- The old `/api/webhooks/evolution` path is a temporary compatibility alias.
- All Evolution HTTP requests must go through `lib/whatsapp/evolution-client.ts`.
- Connection validation must check API reachability, API key, instance existence, connection state, local webhook reachability, and Evolution webhook registration.

## Database Architecture

- Prisma is the source of truth for schema shape.
- Runtime integration secrets are stored through `runtime_integrations` and encrypted by the integration config helpers.
- WhatsApp observability uses message lifecycle logs, delivery logs, session/runtime state, CRM conversation tables, and webhook event rows.
- Do not bypass shared lifecycle helpers when updating WhatsApp message or delivery state.

## Backup Architecture

- Backups are managed through the backup service, scheduler, detector, and merge tooling.
- Restore flows must be merge-first and create rollback metadata before production data changes.
- Backup storage can be local or remote depending on runtime integration configuration.
- Do not silently replace production data with uploaded backup artifacts.

## Migration Architecture

- Migrations must be additive or guarded unless a destructive change is explicitly approved.
- Existing production rows may contain legacy field names; code may read legacy keys for migration compatibility but must write current keys.
- Migration and repair scripts should be idempotent and safe to rerun.
- Keep installer and updater behavior aligned with the runtime architecture.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
