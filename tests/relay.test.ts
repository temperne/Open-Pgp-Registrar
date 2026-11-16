// The backup server (vps/relay.mjs): the same room protocol as the Cloudflare Worker.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stop-relay-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>\n<!-- S.T.O.P. stop-version=v0.1.test built=2026-01-01T00:00:00Z -->\n<p>app</p>');
  proc = spawn(process.execPath, ['vps/relay.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PAGE: join(dir, 'index.html') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('relay did not start');
});
afterAll(() => {
  proc?.kill();
});

/** A tab: collects what it receives. */
function tab(room: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay/${room}`);
  const got: string[] = [];
  ws.on('message', (d) => got.push(String(d)));
  const open = new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  return { ws, got, open };
}
const settle = () => new Promise((r) => setTimeout(r, 150));
const ROOM = 'A'.repeat(22);

describe('backup server (vps/relay.mjs)', () => {
  it('serves the page, with CORS only for the update check', async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('stop-version=v0.1.test');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const c = await fetch(`${BASE}/?check=1`);
    expect(c.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${BASE}/secret.txt`)).status).toBe(404);
  });

  it('welcomes, announces joiners and forwards messages to the others only', async () => {
    const a = tab(ROOM);
    await a.open;
    await settle();
    expect(JSON.parse(a.got[0])).toEqual({ relay: 'welcome', tabs: 1 });
    const b = tab(ROOM);
    await b.open;
    await settle();
    expect(JSON.parse(b.got[0])).toEqual({ relay: 'welcome', tabs: 2 });
    expect(JSON.parse(a.got[1])).toEqual({ relay: 'joined', tabs: 2 });
    a.ws.send('v1.ciphertext-from-a');
    await settle();
    expect(b.got).toContain('v1.ciphertext-from-a');
    expect(a.got).not.toContain('v1.ciphertext-from-a');
    // Another room hears nothing.
    const other = tab('B'.repeat(22));
    await other.open;
    a.ws.send('v1.second');
    await settle();
    expect(other.got.some((m) => m.startsWith('v1.'))).toBe(false);
    b.ws.close();
    await settle();
    expect(JSON.parse(a.got[a.got.length - 1])).toEqual({ relay: 'left', tabs: 1 });
    a.ws.close();
    other.ws.close();
  });

  it('refuses a 17th tab and anything that is not a room', async () => {
    const room = 'C'.repeat(22);
    const tabs = Array.from({ length: 16 }, () => tab(room));
    await Promise.all(tabs.map((t) => t.open));
    const extra = tab(room);
    await expect(extra.open).rejects.toThrow();
    await expect(tab('not-a-room').open).rejects.toThrow();
    for (const t of tabs) t.ws.close();
  });
});
