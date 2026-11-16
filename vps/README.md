# The S.T.O.P. project server

The master site's page runs on Cloudflare (`worker/`). This folder sets up the project's
own server (a small Debian VPS) at **https://84-46-239-112.sslip.io/**: the same page, and
the **first-choice signing-room relay**.

- Signing rooms use this server first (no per-message cost, so files up to 50 MB and live
  updates go through rooms freely) and move to the master site's Cloudflare relay on
  their own if it can't be reached. Everyone tries them in the same order with the same
  room key, so a room meets on one of them.
- The page also works when loaded from this address (it is a second official address).
- Like the Worker, it forwards only end-to-end encrypted messages and stores nothing. It
  keeps no access log.

## What it is

| File | What it does |
|---|---|
| `relay.mjs` | Serves the page and relays rooms (Node.js + `ws`), on 127.0.0.1:8787 |
| `stop-relay.service` | Runs it as a throwaway user with no write access (systemd) |
| `Caddyfile` | https in front of it; Caddy gets and renews the certificate |
| `firewall.nft` | Lets in only SSH (22), http (80) and https (443) |
| `update-page.sh` | Downloads the page from the master site and installs it only if its SHA-256 matches the proven build in the repository's README |
| `setup.sh` | Installs and starts everything (safe to run again) |

## Set it up (Debian 13, as root)

```sh
cd /root/Open-Pgp-Registrar
git pull
sh vps/setup.sh
```

It installs Node.js, npm, Caddy and nftables from Debian, turns on the firewall, installs
the relay in `/opt/stop`, installs the proven page, and starts the services. In a minute or
two https://84-46-239-112.sslip.io/ answers.

## Update it (after each new version)

```sh
cd /root/Open-Pgp-Registrar && git pull && sh vps/setup.sh
```

(`sh vps/update-page.sh` alone is enough when only the page changed. The relay picks up
the new page without a restart.)

## Check it

```sh
systemctl status stop-relay caddy nftables
journalctl -u stop-relay -n 20     # start-up and errors only; no visitors are logged
nft list ruleset
```

## Using a domain instead of sslip.io

Point the domain at the server, put it in `Caddyfile` and in `MASTER_FALLBACK_URL` in
`src/brand.ts`, rebuild and prove the page (the address is in its security policy), deploy
it to the master site, then run `setup.sh` here again.
