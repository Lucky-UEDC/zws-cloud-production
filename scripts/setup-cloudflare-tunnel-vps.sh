#!/usr/bin/env bash
# Create/reuse a named Cloudflare Tunnel using the existing cloudflared login
# certificate on this VPS. Does not create API tokens or print secret contents.
set -Eeuo pipefail
umask 077

readonly TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-zwscloud-panel}"
readonly DEV_HOST="${DEV_HOSTNAME:-dev.zwscloud.in}"
readonly API_HOST="${API_HOSTNAME:-api-panel.zwscloud.in}"
readonly ORIGIN_URL="${CLOUDFLARE_ORIGIN_URL:-http://127.0.0.1:13000}"
readonly CF_HOME="${CLOUDFLARED_HOME:-/root/.cloudflared}"
readonly CF_CERT="${CLOUDFLARED_CERT:-${CF_HOME}/cert.pem}"
readonly CONFIG_DIR="/etc/cloudflared"
readonly CONFIG_FILE="${CONFIG_DIR}/zwscloud-panel.yml"
readonly UNIT_FILE="/etc/systemd/system/zwscloud-tunnel.service"
readonly MARKER_DIR="/etc/cloudflared/.zwscloud-dns-routes"
readonly BACKUP_DIR="/var/backups/zwscloud-cloudflared"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[zwscloud-tunnel] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "Run as root: sudo -i, then rerun this script."
command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed. Install it first; this script will not replace your installation."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required."
command -v systemctl >/dev/null 2>&1 || die "systemd is required on this VPS."
[[ -s "$CF_CERT" ]] || die "Existing Cloudflare login certificate not found at $CF_CERT. No tunnel/DNS changes were made. Re-authenticate on this VPS with: cloudflared tunnel login"

[[ "$TUNNEL_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || die "Invalid tunnel name."
for host in "$DEV_HOST" "$API_HOST"; do
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ && "$host" == *.* ]] || die "Invalid hostname: $host"
done
[[ "$DEV_HOST" != "$API_HOST" ]] || die "DEV_HOSTNAME and API_HOSTNAME must be different."
[[ "$ORIGIN_URL" =~ ^http://(127\.0\.0\.1|localhost):[0-9]{1,5}$ ]] || die "Origin must be a local HTTP service such as http://127.0.0.1:13000. This script intentionally refuses remote/public origins."

export TUNNEL_ORIGIN_CERT="$CF_CERT"
log "Checking local app at $ORIGIN_URL ..."
HTTP_CODE="$(curl -sS -o /dev/null --connect-timeout 3 --max-time 8 -w '%{http_code}' "$ORIGIN_URL/" || true)"
[[ "$HTTP_CODE" =~ ^[23][0-9][0-9]$ ]] || die "Origin did not return HTTP 2xx/3xx (received ${HTTP_CODE:-no response}). Start/repair the dev app on port 13000 before routing public hostnames."

install -d -m 700 "$CONFIG_DIR" "$MARKER_DIR" "$BACKUP_DIR"
TMP_LIST="$(mktemp)"
TMP_CONFIG="$(mktemp "${CONFIG_DIR}/.zwscloud-config.XXXXXX")"
TMP_UNIT="$(mktemp /tmp/zwscloud-tunnel-unit.XXXXXX)"
TMP_ROUTE_LOG="$(mktemp)"
cleanup() { rm -f "$TMP_LIST" "$TMP_CONFIG" "$TMP_UNIT" "$TMP_ROUTE_LOG"; }
trap cleanup EXIT

list_tunnels() {
  cloudflared tunnel list --output json > "$TMP_LIST" 2>"$TMP_ROUTE_LOG" ||
    die "Cloudflare authentication/list failed. Existing certificate could be invalid. No tunnel was started. Check: $TMP_ROUTE_LOG"
}

find_tunnel_id() {
  python3 - "$TMP_LIST" "$TUNNEL_NAME" <<'PY'
import json, sys
path, wanted = sys.argv[1:3]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if isinstance(data, dict):
    data = data.get("tunnels", data.get("result", []))
if not isinstance(data, list):
    raise SystemExit("cloudflared returned an unexpected tunnel-list format")
for item in data:
    if not isinstance(item, dict):
        continue
    name = item.get("name") or item.get("NAME") or item.get("Name")
    tid = item.get("id") or item.get("ID") or item.get("Id")
    if name == wanted and tid:
        print(tid)
        break
PY
}

list_tunnels
TUNNEL_ID="$(find_tunnel_id)"
if [[ -z "$TUNNEL_ID" ]]; then
  log "Creating named tunnel '$TUNNEL_NAME' using the existing login certificate ..."
  cloudflared tunnel create "$TUNNEL_NAME"
  list_tunnels
  TUNNEL_ID="$(find_tunnel_id)"
fi
[[ "$TUNNEL_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "Could not resolve a valid tunnel UUID. No configuration was activated."

SRC_CREDENTIALS="${CF_HOME}/${TUNNEL_ID}.json"
if [[ ! -s "$SRC_CREDENTIALS" && -s "${CONFIG_DIR}/${TUNNEL_ID}.json" ]]; then
  SRC_CREDENTIALS="${CONFIG_DIR}/${TUNNEL_ID}.json"
fi
[[ -s "$SRC_CREDENTIALS" ]] || die "Tunnel $TUNNEL_ID exists but this VPS has no matching credential JSON at $CF_HOME/$TUNNEL_ID.json. Refusing to create a duplicate or switch tunnels."
python3 - "$SRC_CREDENTIALS" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    value = json.load(f)
if not isinstance(value, dict) or not value.get("TunnelID") or not value.get("TunnelSecret"):
    raise SystemExit("Tunnel credential JSON is missing expected fields")
PY

CREDENTIALS_FILE="${CONFIG_DIR}/${TUNNEL_ID}.json"
if [[ "$SRC_CREDENTIALS" != "$CREDENTIALS_FILE" ]]; then
  install -m 600 "$SRC_CREDENTIALS" "$CREDENTIALS_FILE"
else
  chmod 600 "$CREDENTIALS_FILE"
fi

cat > "$TMP_CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE
no-autoupdate: true
ingress:
  - hostname: $DEV_HOST
    service: $ORIGIN_URL
  - hostname: $API_HOST
    service: $ORIGIN_URL
  - service: http_status:404
EOF
chmod 600 "$TMP_CONFIG"
cloudflared --config "$TMP_CONFIG" tunnel ingress validate

# Routes are created one hostname at a time. Successful routes are marked so a
# rerun can resume after a partial DNS failure. Existing conflicting records are
# NOT overwritten; inspect them in Cloudflare before retrying.
for host in "$DEV_HOST" "$API_HOST"; do
  marker="${MARKER_DIR}/${TUNNEL_ID}-${host}"
  if [[ -f "$marker" ]]; then
    log "DNS route already recorded for $host; leaving it untouched."
    continue
  fi
  log "Creating Cloudflare DNS route for $host ..."
  if cloudflared tunnel route dns "$TUNNEL_ID" "$host" >"$TMP_ROUTE_LOG" 2>&1; then
    cat "$TMP_ROUTE_LOG"
    printf '%s\n' "$TUNNEL_ID" > "$marker"
    chmod 600 "$marker"
  else
    cat "$TMP_ROUTE_LOG" >&2
    die "Could not route $host. An existing DNS record may conflict. No existing record was overwritten. Check the record in Cloudflare, then if it already points to $TUNNEL_ID.cfargotunnel.com, set DNS_ALREADY_ROUTED_HOSTS=$host before rerunning."
  fi
done

# An operator may confirm that a pre-existing record already points to this
# exact tunnel. This override is explicit and is never guessed from DNS results.
if [[ -n "${DNS_ALREADY_ROUTED_HOSTS:-}" ]]; then
  IFS=',' read -r -a confirmed_hosts <<< "$DNS_ALREADY_ROUTED_HOSTS"
  for host in "${confirmed_hosts[@]}"; do
    host="$(printf '%s' "$host" | xargs)"
    [[ "$host" == "$DEV_HOST" || "$host" == "$API_HOST" ]] || die "DNS_ALREADY_ROUTED_HOSTS contains an unexpected hostname: $host"
    printf '%s\n' "$TUNNEL_ID" > "${MARKER_DIR}/${TUNNEL_ID}-${host}"
    chmod 600 "${MARKER_DIR}/${TUNNEL_ID}-${host}"
  done
fi

if [[ -f "$CONFIG_FILE" ]]; then
  cp -a "$CONFIG_FILE" "${BACKUP_DIR}/zwscloud-panel.yml.$(date +%Y%m%d%H%M%S).bak"
fi
install -m 600 "$TMP_CONFIG" "$CONFIG_FILE"
CF_BIN="$(command -v cloudflared)"
cat > "$TMP_UNIT" <<EOF
[Unit]
Description=ZWS Cloud named Cloudflare Tunnel
Wants=network-online.target
After=network-online.target
ConditionPathExists=$CONFIG_FILE

[Service]
Type=simple
User=root
ExecStart=$CF_BIN --config $CONFIG_FILE tunnel run $TUNNEL_ID
Restart=on-failure
RestartSec=5s
TimeoutStartSec=30s
TimeoutStopSec=30s
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$TMP_UNIT"
install -m 644 "$TMP_UNIT" "$UNIT_FILE"

cloudflared --config "$CONFIG_FILE" tunnel ingress validate
systemctl daemon-reload
systemctl enable --now zwscloud-tunnel.service
sleep 2
systemctl is-active --quiet zwscloud-tunnel.service || {
  systemctl --no-pager --full status zwscloud-tunnel.service || true
  journalctl -u zwscloud-tunnel.service -n 80 --no-pager || true
  die "Tunnel service did not become active. Public DNS was configured; fix the service before retrying."
}

log "Checking whether the origin listens on a public interface (warning only; no firewall changes made)."
if command -v ss >/dev/null 2>&1 && ss -ltnH '( sport = :13000 )' | grep -Eq '0\.0\.0\.0:13000|\*:13000|\[::\]:13000'; then
  printf 'WARNING: Port 13000 appears to listen on a public interface. Restrict the origin to loopback or firewall it to trusted sources; this script does not modify firewall rules.\n' >&2
fi

printf '\nTunnel service: '
systemctl is-active zwscloud-tunnel.service
printf 'Tunnel UUID: %s\n' "$TUNNEL_ID"
printf 'Origin: %s\n' "$ORIGIN_URL"
printf 'Hostnames: https://%s and https://%s\n' "$DEV_HOST" "$API_HOST"
printf 'Config: %s\n' "$CONFIG_FILE"
printf 'Credentials: %s (secret file; contents not displayed)\n' "$CREDENTIALS_FILE"
printf '\nVerify with:\n'
printf '  systemctl status zwscloud-tunnel.service --no-pager\n'
printf '  journalctl -u zwscloud-tunnel.service -n 100 --no-pager\n'
printf '  curl -sS -D- https://%s/api/health -o /dev/null\n' "$DEV_HOST"
printf '  curl -sS -D- https://%s/api/health -o /dev/null\n' "$API_HOST"
