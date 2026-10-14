#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[docker-entrypoint] %s\n' "$*"; }
fail() { printf '[docker-entrypoint] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_database_url() {
  local mode="${DATABASE_MODE:-external}"
  case "$mode" in
    local)
      export DATABASE_URL="${LOCAL_DATABASE_URL:-postgresql://${POSTGRES_USER:-zwscloud_app}:${POSTGRES_PASSWORD:-CHANGE_ME}@postgres:5432/${POSTGRES_DB:-zwscloud}?schema=public}"
      ;;
    external)
      export DATABASE_URL="${EXTERNAL_DATABASE_URL:-${DATABASE_URL:-}}"
      if [[ -z "${DATABASE_URL:-}" && -n "${DATABASE_PASSWORD:-${POSTGRES_PASSWORD:-}}" ]]; then
        local password="${DATABASE_PASSWORD:-${POSTGRES_PASSWORD:-}}"
        export DATABASE_URL="postgresql://${DATABASE_USER:-zwscloud_app}:${password}@${DATABASE_HOST:-db-tunnel}:${DATABASE_PORT:-${DATABASE_TUNNEL_PORT:-15432}}/${DATABASE_NAME:-zwscloud}?schema=${DATABASE_SCHEMA:-public}&sslmode=${DATABASE_SSLMODE:-require}"
      fi
      if [[ "${ZWS_RUNTIME:-}" == "docker" && -n "${DATABASE_URL:-}" ]]; then
        export DATABASE_URL="$(node -e '
          const url = new URL(process.argv[1]);
          if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
            url.hostname = "host.docker.internal";
            url.port = process.env.HOST_DATABASE_PROXY_PORT || "15432";
          }
          process.stdout.write(url.toString());
        ' "$DATABASE_URL")"
      fi
      ;;
    *)
      fail "DATABASE_MODE must be external or local"
      ;;
  esac
  [[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL could not be resolved"
}

wait_for_database() {
  local attempts="${DB_WAIT_ATTEMPTS:-60}"
  local readiness_url
  # pg_isready understands libpq parameters but not Prisma's schema selector.
  # Keep DATABASE_URL untouched for Prisma and strip only that parameter here.
  readiness_url="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
  log "waiting for PostgreSQL"
  for ((i=1; i<=attempts; i++)); do
    if pg_isready -d "$readiness_url" >/dev/null 2>&1; then
      log "PostgreSQL is reachable"
      return
    fi
    sleep 2
  done
  fail "PostgreSQL is unreachable"
}

wait_for_redis() {
  [[ -n "${REDIS_URL:-}" ]] || fail "REDIS_URL is required"
  local attempts="${REDIS_WAIT_ATTEMPTS:-60}"
  log "waiting for Redis"
  for ((i=1; i<=attempts; i++)); do
    if redis-cli -u "$REDIS_URL" ping 2>/dev/null | grep -q PONG; then
      log "Redis is reachable"
      return
    fi
    sleep 2
  done
  fail "Redis is unreachable"
}

prisma_generate() {
  log "running prisma generate"
  ./node_modules/.bin/prisma generate
}

prisma_validate_migrations() {
  log "validating Prisma migration state"
  ./node_modules/.bin/tsx scripts/validate-migrations.ts
}

# True when the target database holds no application tables, i.e. a fresh
# install. Detected from the data itself rather than a flag, so it can never
# trigger against a populated database.
database_is_fresh() {
  local url count
  url="${DATABASE_URL%%\?*}"   # psql rejects the ?schema= query string
  count=$(psql "$url" -tAc \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations';" \
    2>/dev/null | tr -d '[:space:]' || echo "")
  [[ "$count" == "0" ]]
}

# A fresh install cannot replay migrations in order: the earliest ones
# (e.g. 0_multi_disk_storage) reference tables that a later migration creates,
# so `migrate deploy` dies with "relation does not exist". Create the current
# schema from schema.prisma instead, then record every existing migration as
# already applied so _prisma_migrations stays consistent for future deploys.
bootstrap_fresh_database() {
  log "Fresh database detected - creating schema from prisma/schema.prisma"

  ./node_modules/.bin/prisma db push --accept-data-loss --skip-generate

  local migrations=0
  local name
  while read -r name; do
    [[ -n "$name" ]] || continue
    ./node_modules/.bin/prisma migrate resolve --applied "$name" >/dev/null 2>&1 || true
    migrations=$((migrations + 1))
  done < <(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)

  log "Recorded ${migrations} existing migration(s) as applied"
}

strict_integrations() {
  if [[ "${ZWS_STARTUP_STRICT:-1}" == "1" ]]; then
    ./node_modules/.bin/tsx scripts/docker-strict-integrations.ts
  else
    log "strict integration validation disabled"
  fi
}

validate_environment() {
  log "validating critical environment variables"
  ./node_modules/.bin/tsx scripts/validate-env.ts
}

prepare_runtime() {
  resolve_database_url
  wait_for_database
  wait_for_redis
  prisma_generate
  validate_environment
}

seed_uploads() {
  local src="/app/public/uploads"
  local dst="${ZWS_UPLOAD_DIR:-/app/uploads}"
  [ -d "$src" ] || return 0
  [ -d "$dst" ] || mkdir -p "$dst"
  local sub
  for sub in branding os-icons cms; do
    if [ ! -d "$dst/$sub" ] || [ -z "$(ls -A "$dst/$sub" 2>/dev/null)" ]; then
      if [ -d "$src/$sub" ] && [ -n "$(ls -A "$src/$sub" 2>/dev/null)" ]; then
        log "seeding uploads: $sub"
        mkdir -p "$dst/$sub"
        cp -a "$src/$sub"/. "$dst/$sub/"
      fi
    fi
  done
}

case "${1:-app}" in
  migrate)
    prepare_runtime
    # Refuse to run schema changes when this host is not pointed at a database
    # that is explicitly not production. A migration executed from a
    # development host against the shared `main` database is unrecoverable
    # without a verified backup, which is why this runs before anything else.
    ./node_modules/.bin/tsx scripts/assert-db-isolation.ts "prisma migrate deploy" || exit 78
    if database_is_fresh; then
      bootstrap_fresh_database
    fi
    log "deploying Prisma migrations"
    ./node_modules/.bin/prisma migrate deploy
    prisma_validate_migrations
    ./node_modules/.bin/tsx scripts/database-registry.ts seed-defaults
    ;;
  app)
    prepare_runtime
    seed_uploads
    prisma_validate_migrations
    ./node_modules/.bin/tsx scripts/database-registry.ts validate
    strict_integrations
    exec node .next/standalone/server.js
    ;;
  worker)
    export ZWS_HEALTH_PORT="${WORKER_HEALTH_PORT:-3100}"
    export CONSOLE_PROXY_EMBEDDED="${CONSOLE_PROXY_EMBEDDED:-1}"
    prepare_runtime
    prisma_validate_migrations
    ./node_modules/.bin/tsx scripts/database-registry.ts validate
    strict_integrations
    exec node --import tsx workers/zws-worker.ts
    ;;
  scheduler)
    export ZWS_HEALTH_PORT="${SCHEDULER_HEALTH_PORT:-3101}"
    prepare_runtime
    prisma_validate_migrations
    ./node_modules/.bin/tsx scripts/database-registry.ts validate
    strict_integrations
    exec node --import tsx workers/zws-scheduler.ts
    ;;
  backup)
    shift
    prepare_runtime
    exec node --import tsx scripts/docker-backup.ts "${@:-backup}"
    ;;
  restore|retention)
    prepare_runtime
    exec node --import tsx scripts/docker-backup.ts "$@"
    ;;
  self-test)
    prepare_runtime
    prisma_validate_migrations
    ./node_modules/.bin/tsx scripts/database-registry.ts validate
    strict_integrations
    exec node --import tsx scripts/docker-self-test.ts
    ;;
  *)
    exec "$@"
    ;;
esac
