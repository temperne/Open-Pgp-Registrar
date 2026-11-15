# The site's Cloudflare Worker

Serves the app, relays signing rooms, and counts usage. Everything lives on the one
address, `https://pimastopinitiative.jasonajensen.workers.dev/`.

## Deploy (from a computer with Node.js)

```sh
# 1. Build the app (from the repository root)
npm install
npm run build              # dist/index.html; prints its SHA-256

# 2. Deploy the Worker (from this folder)
cd worker
npm install
npx wrangler login         # once: opens Cloudflare in the browser
npx wrangler deploy
```

`wrangler.toml` names the Worker `pimastopinitiative`, so it replaces what is at that
address now. If the existing Worker has a different name, change `name` to match it (or
the site moves to `<name>.jasonajensen.workers.dev`). The first deploy creates the
Durable Object for rooms and the `stop_usage` analytics dataset. Both are in Cloudflare's
free plan.

To try it locally first: `npx wrangler dev`, then open http://127.0.0.1:8787.

## What it does

- `GET /` (and any other path): the app, from `../dist` (the single HTML file).
- `GET /relay/<room>` with a WebSocket upgrade: a signing room. Every message from one tab
  goes to the others in the same room. Messages are encrypted in the browser with a key
  the server never sees; the room name is a hash of that key. Nothing is stored, and a room
  disappears when its last tab leaves. At most 16 tabs per room, 4 MB per message.
- Usage counts (Workers Analytics Engine, dataset `stop_usage`): one data point per page
  load, download (`?dl=1`), room opened and room joined, with the country Cloudflare
  reports. No IP address, cookie or identifier is recorded.

## Reading the usage counts

In the Cloudflare dashboard: Workers & Pages, Analytics Engine, or with the SQL API:

```sql
SELECT blob1 AS event, blob2 AS country, SUM(_sample_interval) AS count
FROM stop_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event, country
ORDER BY count DESC
```

(`curl https://api.cloudflare.com/client/v4/accounts/<account id>/analytics_engine/sql -H "Authorization: Bearer <API token with Account Analytics read>" -d "<the query>"`.)
