#!/bin/sh
# Sets up (or updates) the S.T.O.P. backup server on Debian 13. Run as root from the
# repository: sh vps/setup.sh. Safe to run again.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

echo "== Packages: Node.js, npm, Caddy, nftables"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm caddy nftables >/dev/null

echo "== Firewall: only SSH (22), http (80) and https (443) in"
nft -c -f "$HERE/firewall.nft"
install -m 644 "$HERE/firewall.nft" /etc/nftables.conf
systemctl enable --now nftables >/dev/null
nft -f /etc/nftables.conf

echo "== The relay, in /opt/stop"
install -d -m 755 /opt/stop /opt/stop/public
install -m 644 "$HERE/relay.mjs" "$HERE/package.json" "$HERE/package-lock.json" /opt/stop/
(cd /opt/stop && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

echo "== The page (checked against the proven build's SHA-256)"
sh "$HERE/update-page.sh"

echo "== Services"
install -m 644 "$HERE/stop-relay.service" /etc/systemd/system/stop-relay.service
systemctl daemon-reload
systemctl enable stop-relay >/dev/null
systemctl restart stop-relay
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl restart caddy

echo "== Check"
sleep 2
node -e 'fetch("http://127.0.0.1:8787/healthz").then((r) => r.text()).then((t) => console.log("relay:", t)).catch((e) => { console.error("relay not answering:", e.message); process.exit(1); })'
systemctl is-active stop-relay caddy nftables
echo "Done. In a minute or two Caddy has its certificate: https://securerecorder.csproject.org/"
