# Cloudflare Tunnel setup on the VPS

This runbook configures a named tunnel using the existing `cloudflared` login certificate on the VPS. It does not require creating a Cloudflare API token, does not route a database through the tunnel, and does not open public firewall ports.

## Default routes

- `https://dev.zwscloud.in` → `http://127.0.0.1:13000`
- `https://api-panel.zwscloud.in` → `http://127.0.0.1:13000`
- All other Host headers → HTTP 404

The two hostnames use the same app origin by default. Change this only if the API is actually served on a different local port.

## Run on the VPS

The app must already respond locally on port 13000. From a source checkout with the deployment repository credentials configured, fetch the branch without checking it out or changing the running release:

```bash
git fetch origin fix/reliable-vm-invoices-notifications
git show FETCH_HEAD:scripts/setup-cloudflare-tunnel-vps.sh > /tmp/setup-cloudflare-tunnel-vps.sh
sudo install -o root -g root -m 700 /tmp/setup-cloudflare-tunnel-vps.sh /usr/local/sbin/setup-zwscloud-tunnel
sudo /usr/local/sbin/setup-zwscloud-tunnel
```

Run from the repository directory. The script requires root. By default it reads the existing login certificate at `/root/.cloudflared/cert.pem`. If the login was performed under a different home directory, pass the correct paths explicitly, for example:

```bash
sudo env CLOUDFLARED_HOME=/home/ubuntu/.cloudflared CLOUDFLARED_CERT=/home/ubuntu/.cloudflared/cert.pem /usr/local/sbin/setup-zwscloud-tunnel
```

The script lists existing tunnels, reuses the tunnel named `zwscloud-panel` if it has local credentials, or creates it if it does not exist. It keeps existing tunnel credentials private under `/etc/cloudflared`, validates ingress before activation, backs up any previous managed config, installs a dedicated systemd unit, and attempts DNS routes one hostname at a time. It does not overwrite conflicting DNS records.

## If account login fails

The login certificate (`cert.pem`) authorizes tunnel management; it is different from a Cloudflare Origin CA certificate. If `cloudflared tunnel list` rejects the certificate, the script stops before activating a tunnel. Authenticate on the VPS interactively, then rerun:

```bash
cloudflared tunnel login
sudo /usr/local/sbin/setup-zwscloud-tunnel
```

Do not paste or commit `cert.pem`, tunnel credential JSON, or tunnel tokens into chat or GitHub.

## DNS conflicts

If Cloudflare reports that a DNS record already exists, the script will stop rather than overwrite it. Inspect the record in the Cloudflare dashboard. Only if it already targets this tunnel's UUID at `<UUID>.cfargotunnel.com`, rerun while explicitly confirming the matching hostname:

```bash
sudo env DNS_ALREADY_ROUTED_HOSTS=dev.zwscloud.in /usr/local/sbin/setup-zwscloud-tunnel
```

For both hostnames use a comma-separated value. Do not confirm a hostname whose target you have not checked.

## Verification

```bash
systemctl status zwscloud-tunnel.service --no-pager
journalctl -u zwscloud-tunnel.service -n 100 --no-pager
curl -sS -D- https://dev.zwscloud.in/api/health -o /dev/null
curl -sS -D- https://api-panel.zwscloud.in/api/health -o /dev/null
```

If tunnel startup fails, inspect the journal before trying further changes. The script does not modify UFW, nftables, Docker port bindings, database configuration, or any unrelated Cloudflare tunnel. It warns if port 13000 appears to listen on a public interface; restrict the origin separately after confirming the public tunnel works, to avoid an accidental outage.

## Rollback

The script creates a backup of an existing managed `/etc/cloudflared/zwscloud-panel.yml` before replacing it. To stop this dedicated tunnel service:

```bash
systemctl disable --now zwscloud-tunnel.service
```

This does not delete the named Cloudflare tunnel or DNS records. Remove those explicitly in Cloudflare only after confirming they are not being used elsewhere.
