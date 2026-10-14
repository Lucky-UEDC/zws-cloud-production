# syntax=docker/dockerfile:1.7

# ============================================================
# Toolchain + locked dependencies
# ============================================================
FROM node:22-bookworm AS deps
ARG DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production \
    ZWS_RUNTIME=docker \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PUPPETEER_SKIP_DOWNLOAD=true \
    COREPACK_HOME=/tmp/corepack \
    XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make openssl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# ============================================================
# Build
# ============================================================
FROM deps AS build
COPY . .
ARG BUILD_DATABASE_URL=postgresql://zwscloud_app:zwscloud_app@127.0.0.1:5432/zwscloud?schema=public
ARG APP_VERSION=1.2.0
ARG APP_COMMIT=""
ARG APP_SOURCE_DATE=""
ENV APP_VERSION=${APP_VERSION} \
    NEXT_PUBLIC_APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${APP_COMMIT} \
    BUILD_DATABASE_URL=${BUILD_DATABASE_URL} \
    DATABASE_URL=${BUILD_DATABASE_URL} \
    ZWS_SKIP_SETTINGS_DB_DURING_BUILD=1
# Immutable build identity: when APP_COMMIT is not supplied (no git here), a
# deterministic source fingerprint is computed from the build context instead.
RUN APP_COMMIT_VALUE="${APP_COMMIT:-$(find /app -path /app/node_modules -prune -o -type f -print | sort | xargs sha256sum | sha256sum | cut -c1-12)}" \
    && APP_SOURCE_DATE_VALUE="${APP_SOURCE_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
    && printf '{"version":"%s","commit":"%s","builtAt":"%s","image":"zws-cloud"}\n' "${APP_VERSION:-unknown}" "$APP_COMMIT_VALUE" "$APP_SOURCE_DATE_VALUE" > /app/runtime-info.json \
    && pnpm build \
    && rm -rf /app/.next/cache \
    && pnpm prune --prod

# ============================================================
# Runner
# ============================================================
FROM node:22-bookworm AS runner
ARG DEBIAN_FRONTEND=noninteractive
ARG APP_VERSION=1.2.0
ARG APP_COMMIT=""
ARG APP_SOURCE_DATE=""
LABEL org.opencontainers.image.title="ZWS Cloud" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT:-unset}" \
      org.opencontainers.image.created="${APP_SOURCE_DATE:-unknown}" \
      org.opencontainers.image.vendor="ZWS Cloud" \
      org.opencontainers.image.description="ZWS Cloud control panel (app/worker/scheduler)"
ENV NODE_ENV=production \
    ZWS_RUNTIME=docker \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    COREPACK_HOME=/tmp/corepack \
    XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       chromium \
       curl \
       dumb-init \
       gnupg \
       openssl \
       rclone \
       redis-tools \
       tini \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 zws

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build --chown=zws:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=zws:nodejs /app/.next/standalone ./.next/standalone
COPY --from=build --chown=zws:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=zws:nodejs /app/public ./public
COPY --from=build --chown=zws:nodejs /app/prisma ./prisma
COPY --from=build --chown=zws:nodejs /app/runtime-info.json ./runtime-info.json
COPY --from=build --chown=zws:nodejs /app/scripts ./scripts
COPY --from=build --chown=zws:nodejs /app/workers ./workers
COPY --from=build --chown=zws:nodejs /app/lib ./lib
COPY --from=build --chown=zws:nodejs /app/app ./app
COPY --from=build --chown=zws:nodejs /app/components ./components
COPY --from=build --chown=zws:nodejs /app/next.config.mjs /app/tsconfig.json /app/prisma.config.ts ./
COPY --chown=zws:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
ENV ZWS_PG_DUMP_BIN=/usr/lib/postgresql/18/bin/pg_dump \
    ZWS_PG_RESTORE_BIN=/usr/lib/postgresql/18/bin/pg_restore \
    ZWS_PSQL_BIN=/usr/lib/postgresql/18/bin/psql
RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/logs /app/backups /app/deployment-reports /app/uploads \
    && chown -R zws:nodejs /app/logs /app/backups /app/deployment-reports /app/uploads

USER zws
EXPOSE 3000 3001 3100 3101
ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["app"]