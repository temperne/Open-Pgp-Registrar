/**
 * The S.T.O.P. project server: serves the single-file app and relays signing rooms (the
 * first-choice relay; Cloudflare is the backup), with
 * the same protocol as the Cloudflare Worker (worker/src/index.ts). It sits behind Caddy
 * (https) on 127.0.0.1.
 *
 * - GET /, /index.html  -> the app (PAGE, default /opt/stop/public/index.html)
 * - GET /?check=1       -> the same, with CORS, for other copies' update check
 * - GET /healthz        -> "ok"
 * - WS  /relay/<room>   -> a signing room: forwards each tab's messages to the others
 *
 * The relay only forwards opaque, end-to-end encrypted messages; the room key is in the
 * link after "#", which browsers never send. Nothing is stored or logged: a room exists
 * only while tabs are connected.
 */
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const PAGE = process.env.PAGE ?? '/opt/stop/public/index.html';
/** At most this many tabs in one room, and this much per message (as the Worker). */
const MAX_TABS = 16;
const MAX_MESSAGE = 4 * 1024 * 1024;
/** Room names are derived in the browser from the room key (a hash); 22 base64url characters. */
const ROOM_RE = /^\/relay\/([A-Za-z0-9_-]{22})$/;

// The page, reloaded when the file changes (update-page.sh replaces it).
let page = { body: Buffer.alloc(0), mtime: 0 };
function currentPage() {
  try {
    const m = statSync(PAGE).mtimeMs;
    if (m !== page.mtime) page = { body: readFileSync(PAGE), mtime: m };
  } catch {
    /* keep the last good copy */
  }
  return page.body;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const body = currentPage();
  if (!body.length) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('The page is not installed yet (run update-page.sh).');
    return;
  }
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': body.length,
  };
  // Another copy (a saved file or a county's site) reading the version comment at the top.
  if (url.searchParams.has('check')) Object.assign(headers, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
});

/** Open rooms: room name -> its tabs. Kept in memory only. */
const rooms = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const m = ROOM_RE.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!m) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const name = m[1];
  const tabs = rooms.get(name) ?? new Set();
  if (tabs.size >= MAX_TABS) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\nThis signing room is full.');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    rooms.set(name, tabs);
    // Tell the others someone arrived, so they can send the current document.
    for (const other of tabs) safeSend(other, JSON.stringify({ relay: 'joined', tabs: tabs.size + 1 }));
    tabs.add(ws);
    safeSend(ws, JSON.stringify({ relay: 'welcome', tabs: tabs.size }));
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      for (const other of tabs) if (other !== ws) safeSend(other, data, isBinary);
    });
    const gone = () => {
      if (!tabs.delete(ws)) return;
      for (const other of tabs) safeSend(other, JSON.stringify({ relay: 'left', tabs: tabs.size }));
      if (!tabs.size) rooms.delete(name);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  });
});

function safeSend(ws, data, binary = false) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary });
  } catch {
    /* the tab went away */
  }
}

// Drop tabs that vanished without closing (a phone going to sleep, a dropped network).
const heartbeat = setInterval(() => {
  for (const tabs of rooms.values()) {
    for (const ws of tabs) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  const a = server.address();
  console.log(`S.T.O.P. backup server on ${typeof a === 'object' && a ? `${a.address}:${a.port}` : PORT}, page ${PAGE}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
