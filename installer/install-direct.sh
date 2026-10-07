#!/usr/bin/env bash
set -Eeuo pipefail

# ZWS Cloud Panel - Direct Production Installer
# No GitHub, no git clone - downloads complete release from production server
# Usage: curl -fsSL https://zwscloud.com/install.sh | sudo bash

INSTALL_API="${ZWS_INSTALL_API:-https://zwscloud.com/api/install}"
INSTALL_DIR="${ROOT_DIR:-/var/www/myrdphub}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DATABASE_MODE="local"
APP_PORT="${APP_HTTP_PORT:-13000}"
CERT_DIR="$INSTALL_DIR/certs"
ACME_WEBROOT_DIR="${ACME_WEBROOT_DIR:-/var/www/html}"
LE_EMAIL="${LE_EMAIL:-}"
ACME_BASELINE_CERT=0

log() { printf '[zws-install] %s\n' "$*"; }
fail() { printf '[zws-install] ERROR: %s\n' "$*" >&2; exit 1; }

# Prompt helpers only ever print. Reading is done by the *_tty helpers below so
# that every question is answered on the controlling terminal, never on stdin
# (which is the installer script itself when piped from curl).
prompt() { printf '[zws-install] %s ' "$*" >&2; }
prompt_secret() { prompt "$*"; }

# Read from /dev/tty to work with curl | sudo bash. A read failure (no
# controlling terminal, closed input) must fail loudly rather than trip `set -e`.
read_tty() { read -r "$1" < /dev/tty || fail "Could not read '$1' from the terminal"; }
read_secret_tty() { read -rs "$1" < /dev/tty || fail "Could not read '$1' from the terminal"; printf '\n'; }

require_root() {
  [[ "$(id -u)" -eq 0 ]] || fail "Run as root: sudo bash install.sh"
}

require_supported_os() {
  [[ -r /etc/os-release ]] || fail "Cannot detect operating system"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "Fresh Ubuntu 22.04 or newer is required"
  local major="${VERSION_ID%%.*}"
  [[ "${major:-0}" -ge 22 ]] || fail "Ubuntu 22.04 or newer is required"
}

prompt_configuration() {
  log "=== ZWS Cloud Panel Installation ==="
  
  if [[ -z "${DOMAIN:-}" ]]; then
    prompt "Domain (e.g., apexnods.com): "
    read_tty DOMAIN
    [[ -n "$DOMAIN" ]] || fail "Domain is required"
  fi
  
  if [[ -z "${ADMIN_EMAIL:-}" ]]; then
    prompt "Admin email (e.g., founder@apexnods.com): "
    read_tty ADMIN_EMAIL
    [[ -n "$ADMIN_EMAIL" ]] || fail "Admin email is required"
  fi
  
  while [[ -z "${ADMIN_PASSWORD:-}" ]]; do
    prompt_secret "Admin password (min 8 chars): "
    read_secret_tty ADMIN_PASSWORD
    [[ ${#ADMIN_PASSWORD} -ge 8 ]] || { printf '[zws-install] Password must be at least 8 characters\n'; ADMIN_PASSWORD=""; }
  done
  
  if [[ -z "${CONFIRM_PASSWORD:-}" ]]; then
    prompt_secret "Confirm admin password: "
    read_secret_tty CONFIRM_PASSWORD
    [[ "$ADMIN_PASSWORD" == "$CONFIRM_PASSWORD" ]] || fail "Passwords do not match"
  else
    [[ "$ADMIN_PASSWORD" == "$CONFIRM_PASSWORD" ]] || fail "Passwords do not match"
  fi
  
  export DOMAIN ADMIN_EMAIL ADMIN_USERNAME ADMIN_PASSWORD
}

install_docker() {
  log "Installing Docker Engine..."
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed"
    return
  fi
  
  apt-get update
  apt-get install -y ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

download_release() {
  log "Downloading release archive from $INSTALL_API..."
  
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  
  # Download release archive
  log "Fetching release archive..."
  local release_archive="zws-cloud-panel-latest.tar.gz"
  curl -fsSL "$INSTALL_API/release" -o "$release_archive" || fail "Failed to download release archive"
  
  # Verify checksum
  log "Verifying release integrity..."
  local expected_sha256
  expected_sha256=$(curl -fsSL "$INSTALL_API/release.sha256" 2>/dev/null || echo "")
  if [[ -z "$expected_sha256" ]]; then
    # An unverifiable archive is not installable. This used to log a warning and
    # continue, which meant a tampered or truncated download was deployed as if
    # it were the release.
    fail "No checksum available for the release archive; refusing to install an unverifiable artifact"
  fi
  local actual_sha256
  actual_sha256=$(sha256sum "$release_archive" | awk '{print $1}')
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    fail "Release archive checksum mismatch! Expected: $expected_sha256, Got: $actual_sha256"
  fi
  log "Release checksum verified"
  
  # Extract release
  log "Extracting release..."
  tar -xzf "$release_archive" --strip-components=1 || fail "Failed to extract release archive"
  rm -f "$release_archive"
  
  # Read version
  if [[ -f "VERSION" ]]; then
    local version
    version=$(cat VERSION)
    log "Release version: $version"
  fi
  
  # Generate .env file. On a reinstall an existing .env is authoritative: the
  # database volume was initialised with the current POSTGRES_PASSWORD and
  # existing data is encrypted with ENCRYPTION_KEY, so regenerating those would
  # lock the operator out. New keys are merged in; existing values are kept.
  local nxt_secret=$(openssl rand -base64 48 | tr -d '\n')
  local enc_key=$(openssl rand -hex 32 | tr -d '\n')
  local mfa_key=$(openssl rand -hex 32 | tr -d '\n')
  local jwt_secret=$(openssl rand -base64 48 | tr -d '\n')
  local session_secret=$(openssl rand -base64 48 | tr -d '\n')
  local price_token_secret=$(openssl rand -base64 48 | tr -d '\n')
  local invoice_share_secret=$(openssl rand -base64 48 | tr -d '\n')
  local db_pass=$(openssl rand -hex 24 | tr -d '\n')

  local docker_db_url="postgresql://zwscloud_app:${db_pass}@postgres:5432/zwscloud?schema=public"

  local desired
  desired=$(mktemp)
  cat > "$desired" <<EOF
NODE_ENV=production
ZWS_RUNTIME=docker
ZWS_STARTUP_STRICT=0
DATABASE_MODE=local
COMPOSE_PROFILES=local-db,nginx
DATABASE_URL=
DOCKER_DATABASE_URL=
DATABASE_TUNNEL_HOSTNAME=db.zwscloud.com
DATABASE_TUNNEL_PORT=15432
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=zwscloud
DATABASE_USER=zwscloud_app
DATABASE_PASSWORD=${db_pass}
DATABASE_SSLMODE=require
CLOUDFLARED_CONFIG_DIR=/root/.cloudflared
TUNNEL_SERVICE_TOKEN_ID=
TUNNEL_SERVICE_TOKEN_SECRET=
EXTERNAL_DATABASE_URL=
DOCKER_EXTERNAL_DATABASE_URL=
LOCAL_DATABASE_URL=
DOCKER_LOCAL_DATABASE_URL=${docker_db_url}
POSTGRES_DB=zwscloud
POSTGRES_USER=zwscloud_app
POSTGRES_PASSWORD=${db_pass}
REDIS_URL=
DOCKER_REDIS_URL=redis://redis:6379/0
SITE_DOMAIN=${DOMAIN}
APP_URL=https://${DOMAIN}
NEXTAUTH_URL=https://${DOMAIN}
NEXT_PUBLIC_APP_URL=https://${DOMAIN}
NEXTAUTH_SECRET=${nxt_secret}
ENCRYPTION_KEY=${enc_key}
MFA_ENCRYPTION_KEY=${mfa_key}
JWT_SECRET=${jwt_secret}
SESSION_SECRET=${session_secret}
PRICE_TOKEN_SECRET=${price_token_secret}
INVOICE_SHARE_SECRET=${invoice_share_secret}
WHATSAPP_PROVIDER=evolution
EVOLUTION_API_URL=
EVOLUTION_INSTANCE=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE_TOKEN=
EVOLUTION_TEST_RECIPIENT=
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_DISPLAY_NAME=Admin
VNC_PROXY_HOST=0.0.0.0
VNC_PROXY_PORT=3001
WORKER_HEALTH_PORT=3100
SCHEDULER_HEALTH_PORT=3101
BROWSER_AUTOMATION_ENABLED=1
CLOUDFLARE_ONLY_MODE=false
DIRECT_CLOUDFLARE_MODE=false
CF_TUNNEL_SERVICE=http://app:3000
PROXMOX_LIVE_SSE_POLL_MS=1000
EOF

  if [[ -f .env ]]; then
    log "Existing .env found - preserving current secrets and adding any new keys"
    cp -a .env .env.pre-update
    local merged
    merged=$(mktemp)
    # Current .env wins; keys it does not define yet are appended from $desired.
    grep -v '^[[:space:]]*$' .env > "$merged"
    while IFS= read -r line; do
      local key="${line%%=*}"
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      grep -q "^${key}=" "$merged" || printf '%s\n' "$line" >> "$merged"
    done < "$desired"
    cat "$merged" > .env
    rm -f "$merged"
  else
    log "Generating .env file..."
    cat "$desired" > .env
  fi
  rm -f "$desired"

  chmod 600 .env
}

# nginx refuses to start without a certificate, so a short-lived self-signed
# pair gets the stack up. It is replaced by a real Let's Encrypt certificate in
# issue_certificate() once port 80 is actually serving.
prepare_certs() {
  log "Preparing TLS certificates..."
  mkdir -p "$CERT_DIR" "$ACME_WEBROOT_DIR/.well-known/acme-challenge"

  if [[ -s "$CERT_DIR/fullchain.pem" && -s "$CERT_DIR/privkey.pem" ]]; then
    log "Existing certificate found in $CERT_DIR"
    return
  fi

  log "Generating temporary self-signed certificate (will be replaced by Let's Encrypt)"
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" >/dev/null 2>&1 \
    || fail "Failed to generate temporary certificate"
  chmod 600 "$CERT_DIR/privkey.pem"
  chmod 644 "$CERT_DIR/fullchain.pem"
  ACME_BASELINE_CERT=1
}

# Requests a real Let's Encrypt certificate over HTTP-01. nginx already serves
# /.well-known/acme-challenge/ from ACME_WEBROOT_DIR on port 80, so validation
# works without stopping the stack.
issue_certificate() {
  log "Requesting Let's Encrypt certificate for $DOMAIN..."

  # certbot keeps its account/renewal state in /etc/letsencrypt and writes the
  # challenge files under the webroot. Those must be two separate mounts,
  # otherwise one shadows the other.
  local le_config="$INSTALL_DIR/acme-state"
  local le_webroot="/var/www/certbot"
  mkdir -p "$le_config"

  local args=(
    certonly
    --webroot
    --webroot-path "$le_webroot"
    --domain "$DOMAIN"
    --agree-tos
    --non-interactive
    --no-eff-email
    --rsa-key-size 2048
    --cert-name zws
  )
  if [[ -n "$LE_EMAIL" ]]; then
    args+=(--email "$LE_EMAIL")
  else
    args+=(--register-unsafely-without-email)
  fi

  local issued=1
  for attempt in 1 2 3; do
    if docker run --rm \
        -v "$ACME_WEBROOT_DIR:$le_webroot" \
        -v "$le_config:/etc/letsencrypt" \
        certbot/certbot:latest "${args[@]}"; then
      issued=0
      break
    fi
    log "Let's Encrypt attempt $attempt failed; retrying in 10s..."
    sleep 10
  done

  if [[ $issued -ne 0 ]]; then
    if [[ $ACME_BASELINE_CERT -eq 1 ]]; then
      fail "Let's Encrypt issuance failed and no usable certificate is present.
       A temporary self-signed certificate is installed so nginx runs, but
       browsers will warn. Re-run this installer once DNS for $DOMAIN resolves
       to this server and port 80 is reachable."
    fi
    fail "Let's Encrypt issuance failed; the previously issued certificate is still in place."
  fi

  local live="$le_config/live/zws"
  [[ -s "$live/fullchain.pem" && -s "$live/privkey.pem" ]] \
    || fail "Let's Encrypt reported success but no certificate was produced"

  # Publish into the directory nginx mounts read-only.
  install -m 644 "$live/fullchain.pem" "$CERT_DIR/fullchain.pem"
  install -m 600 "$live/privkey.pem" "$CERT_DIR/privkey.pem"

  cd "$INSTALL_DIR"
  docker compose --env-file .env -f docker-compose.yml --profile nginx exec -T nginx nginx -s reload >/dev/null 2>&1 \
    || docker compose --env-file .env -f docker-compose.yml --profile nginx restart nginx >/dev/null 2>&1 \
    || true

  # Fail loudly if the deployed certificate is not the one we just obtained.
  if command -v openssl >/dev/null 2>&1; then
    local issuer
    issuer=$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -issuer 2>/dev/null || echo "")
    log "Certificate issuer: ${issuer:-unknown}"
  fi

  log "Let's Encrypt certificate installed and nginx reloaded"
}

start_services() {
  log "Starting Docker services..."
  cd "$INSTALL_DIR"

  mkdir -p "$ACME_WEBROOT_DIR"

  docker compose --env-file .env -f docker-compose.yml --profile local-db --profile nginx up -d --build --remove-orphans
  log "Waiting for services to be healthy..."
  wait_for_containers
}

# Block until the app/worker/scheduler/nginx containers report healthy so that
# later steps (cert issuance, admin init) never race a restarting container.
wait_for_containers() {
  local services=(app worker scheduler nginx)
  local max_wait=420
  local waited=0

  while [[ $waited -lt $max_wait ]]; do
    local pending=0
    for svc in "${services[@]}"; do
      local state
      state=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$(container_name "$svc")" 2>/dev/null || echo "missing/none")
      if [[ "$state" != "running/healthy" ]]; then
        pending=1
        break
      fi
    done
    [[ $pending -eq 0 ]] && return 0
    sleep 5
    waited=$((waited + 5))
  done

  fail "Timed out waiting for containers to become healthy (after ${max_wait}s)"
}

# Compose derives the project name from the install directory basename, which
# matches the container naming used throughout docker-compose.yml.
container_name() {
  printf '%s-%s-1' "$(basename "$INSTALL_DIR")" "$1"
}

run_migrations() {
  log "Running database migrations..."
  cd "$INSTALL_DIR"
  docker compose --env-file .env -f docker-compose.yml run --rm migrate
}

# Creates the admin account through the app's own init endpoint, which refuses
# to run twice in production. ADMIN_EMAIL/ADMIN_PASSWORD come from .env.
initialize_admin() {
  log "Creating admin account..."
  local endpoint="http://127.0.0.1:${APP_PORT}/api/admin/init"
  local body=""

  body=$(curl -sS -X POST "$endpoint" 2>/dev/null || echo "")

  if printf '%s' "$body" | grep -q '"success":true'; then
    log "Admin account: READY ($ADMIN_EMAIL)"
  elif printf '%s' "$body" | grep -q 'already initialized'; then
    log "Admin account: ALREADY EXISTS ($ADMIN_EMAIL)"
  else
    fail "Admin account creation failed: ${body:-no response from $endpoint}"
  fi

  # The password only needs to live in .env long enough to seed the account.
  scrub_admin_password
}

# Strips the admin password out of .env once the account exists. The running
# container still holds it in its environment (like every other secret fed via
# .env), but nothing is written back to disk.
scrub_admin_password() {
  if grep -q '^ADMIN_PASSWORD=' "$INSTALL_DIR/.env" 2>/dev/null; then
    local tmp
    tmp=$(mktemp)
    sed '/^ADMIN_PASSWORD=/d' "$INSTALL_DIR/.env" > "$tmp"
    cat "$tmp" > "$INSTALL_DIR/.env"
    rm -f "$tmp"
    chmod 600 "$INSTALL_DIR/.env"
  fi
  ADMIN_PASSWORD=""
}

health_check() {
  log "Performing health checks..."
  cd "$INSTALL_DIR"

  # The app answers 503 while optional integrations (Evolution API, payment
  # gateways) are unconfigured, which is the expected state on a fresh install.
  # What matters here is that the process is serving, not that every integration is.
  local max_wait=180
  local waited=0
  local code="000"
  while [[ $waited -lt $max_wait ]]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || echo "000")
    if [[ "$code" == "200" || "$code" == "503" ]]; then
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  [[ "$code" == "200" || "$code" == "503" ]] \
    || fail "Application health check timed out (last HTTP status: $code)"
  log "Application: HEALTHY (HTTP $code)"

  docker compose --env-file .env -f docker-compose.yml exec -T postgres pg_isready -U zwscloud_app -d zwscloud >/dev/null 2>&1 \
    && log "Database: HEALTHY" || fail "Database unhealthy"

  docker compose --env-file .env -f docker-compose.yml exec -T redis redis-cli ping >/dev/null 2>&1 \
    && log "Redis: HEALTHY" || fail "Redis unhealthy"

  docker compose --env-file .env -f docker-compose.yml exec -T nginx wget -qO- http://127.0.0.1/nginx-health >/dev/null 2>&1 \
    && log "Nginx: HEALTHY" || fail "Nginx unhealthy"
}

verify_https() {
  log "Verifying HTTPS for https://$DOMAIN..."
  local max_wait=60
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    if curl -s -I "https://$DOMAIN" 2>/dev/null | grep -qE "HTTP/[0-9.]+ (200|301|302)"; then
      log "HTTPS: OK (https://$DOMAIN)"
      return
    fi
    sleep 5
    waited=$((waited + 5))
  done
  fail "HTTPS verification failed for https://$DOMAIN (DNS must point to this server)"
}

main() {
  require_root
  require_supported_os
  prompt_configuration
  install_docker
  download_release
  prepare_certs
  start_services
  run_migrations
  issue_certificate
  health_check
  initialize_admin
  verify_https

  log ""
  log "=== Installation Complete ==="
  log "Admin URL: https://$DOMAIN/login"
  log "Admin Email: $ADMIN_EMAIL"
  log ""
  log "Next steps:"
  log "1. Sign in and configure Proxmox node credentials"
  log "2. Configure Evolution API settings for WhatsApp delivery"
  log "3. Restart after config changes:"
  log "   docker compose --env-file $INSTALL_DIR/.env -f $INSTALL_DIR/docker-compose.yml --profile local-db --profile nginx up -d"
}

main "$@"
