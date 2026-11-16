#!/bin/sh
# Installs the program's page on this server: downloads it from the master site and
# keeps it only if its SHA-256 matches the proven build listed in the repository's
# README ("Download and verify"). Run after `git pull` whenever a new version is out.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
MASTER=${MASTER:-https://pimastopinitiative.jasonajensen.workers.dev}
DEST=${DEST:-/opt/stop/public/index.html}
WANT=$(grep -oE '[0-9a-f]{64}' "$REPO/README.md" | head -1)
[ -n "$WANT" ] || { echo "No SHA-256 found in README.md." >&2; exit 1; }
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
node -e '
  const [url, out] = process.argv.slice(1);
  fetch(url, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    require("node:fs").writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  }).catch((e) => { console.error(`Could not download ${url}: ${e.message}`); process.exit(1); });
' "$MASTER/" "$TMP"
GOT=$(sha256sum "$TMP" | cut -d' ' -f1)
if [ "$GOT" != "$WANT" ]; then
  echo "The page at $MASTER has SHA-256 $GOT," >&2
  echo "but README.md lists $WANT. Not installed (git pull first, or wait for the master site to update)." >&2
  exit 1
fi
install -d -m 755 "$(dirname "$DEST")"
install -m 644 "$TMP" "$DEST.new"
mv "$DEST.new" "$DEST"
echo "Installed the proven page ($GOT) at $DEST."
