# The S.T.O.P. project server

The master site's page runs on Cloudflare (`worker/`). This folder sets up the project's
own server (a small Debian VPS) at **https://securerecorder.csproject.org/**: the same page, and
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
| `Caddyfile` | https in front of it: a Let's Encrypt certificate, renewed automatically, http redirected to https, HSTS |
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
two https://securerecorder.csproject.org/ answers. (Its earlier address,
https://84-46-239-112.sslip.io, redirects there.)

## Update it (after each new version)

```sh
cd /root/Open-Pgp-Registrar && git pull && sh vps/setup.sh
```

(`sh vps/update-page.sh` alone is enough when only the page changed. The relay picks up
the new page without a restart.)

## The certificate

Caddy gets the certificate from Let's Encrypt the first time it starts and renews it about
30 days before it expires; nothing to do by hand. To see it:

```sh
echo | openssl s_client -connect securerecorder.csproject.org:443 -servername securerecorder.csproject.org 2>/dev/null | openssl x509 -noout -issuer -dates
```

The issuer should be Let's Encrypt (`O = Let's Encrypt`).

## Check it

```sh
systemctl status stop-relay caddy nftables
journalctl -u stop-relay -n 20     # start-up and errors only; no visitors are logged
nft list ruleset
```

## Using another domain

Point the domain at the server (an A record), put it in `Caddyfile` and in
`MASTER_FALLBACK_URL` in `src/brand.ts`, rebuild and prove the page (the address is in
its security policy), deploy it to the master site, then run `setup.sh` here again.
