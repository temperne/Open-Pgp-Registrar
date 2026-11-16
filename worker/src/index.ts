/**
 * Cloudflare Worker for the S.T.O.P. site: serves the single-file app, relays
 * signing rooms, and counts usage on the server side (no tracking in the page).
 *
 * - GET anything else      -> the app (dist/index.html, from the assets binding)
 * - GET /relay/<room>      -> WebSocket: a signing room (one Durable Object per room)
 *
 * The relay only forwards opaque, end-to-end encrypted messages between the tabs
 * in a room. The key is in the room link after "#", which browsers never send to
 * the server. Nothing is stored: a room exists only while tabs are connected.
 *
 * Analytics (Workers Analytics Engine, dataset "stop_usage"): one data point per
 * event, with the event name, the country Cloudflare reports, and nothing else
 * (no IP address, no cookies, no identifiers).
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace;
  STATS?: AnalyticsEngineDataset;
}

type Event = 'page' | 'download' | 'room-open' | 'room-join' | 'update-check';

function count(env: Env, event: Event, request: Request) {
  try {
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? 'unknown';
    env.STATS?.writeDataPoint({ indexes: [event], blobs: [event, country] });
  } catch {
    /* analytics must never break the site */
  }
}

/** Room names are derived in the browser from the room key (a hash); 22 base64url characters. */
const ROOM_RE = /^\/relay\/([A-Za-z0-9_-]{22})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = ROOM_RE.exec(url.pathname);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1]));
      const res = await stub.fetch(request);
      // The room reports whether this tab opened it or joined it.
      count(env, res.headers.get('X-Room') === 'open' ? 'room-open' : 'room-join', request);
      return res;
    }
    if (request.method === 'GET' && url.searchParams.has('check')) {
      // Another copy (a saved file or a county's site) reading the version comment at the top.
      count(env, 'update-check', request);
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('Access-Control-Allow-Origin', '*');
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'))) {
      count(env, url.searchParams.has('dl') ? 'download' : 'page', request);
    }
    return env.ASSETS.fetch(request);
  },
};

/** At most this many tabs in one room, and this much per message. */
const MAX_TABS = 16;
/**
 * The public meetup room (its name is fixed in the page: the hash of a public key, so
 * anyone can join it) holds more people; they invite each other to private rooms.
 */
const MEETUP_ROOM = '29ub2ZWPUlBCk_wLQwgRfj';
const MAX_MEETUP_TABS = 500;
const MAX_MESSAGE = 4 * 1024 * 1024;

/**
 * One signing room. Forwards every message from one tab to the others. Uses the
 * WebSocket Hibernation API, so an idle room costs nothing; it keeps no storage.
 */
export class Room {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const tabs = this.state.getWebSockets();
    const meetup = new URL(request.url).pathname.endsWith(`/${MEETUP_ROOM}`);
    if (tabs.length >= (meetup ? MAX_MEETUP_TABS : MAX_TABS)) return new Response('This signing room is full.', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    // Tell the others someone arrived, so they can send the current document.
    for (const ws of tabs) safeSend(ws, JSON.stringify({ relay: 'joined', tabs: tabs.length + 1 }));
    safeSend(server, JSON.stringify({ relay: 'welcome', tabs: tabs.length + 1 }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'X-Room': tabs.length ? 'join' : 'open' } });
  }

  webSocketMessage(from: WebSocket, message: string | ArrayBuffer) {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_MESSAGE) return;
    for (const ws of this.state.getWebSockets()) if (ws !== from) safeSend(ws, message);
  }

  webSocketClose(ws: WebSocket) {
    const left = this.state.getWebSockets().filter((x) => x !== ws);
    for (const other of left) safeSend(other, JSON.stringify({ relay: 'left', tabs: left.length }));
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }
}

function safeSend(ws: WebSocket, data: string | ArrayBuffer) {
  try {
    ws.send(data);
  } catch {
    /* the tab went away */
  }
}
