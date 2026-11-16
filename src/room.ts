// Signing rooms: co-owners (and buyers) sign the same document live, each in
// their own tab, through the program's relay (worker/src/index.ts).
//
// Privacy: the room's key is 32 random bytes carried in the link after "#",
// which browsers never send to a server. Every message is encrypted with it
// (AES-GCM) before it leaves the tab, so the relay only ever sees ciphertext and
// a room name derived from the key by a one-way hash. Nothing connects until
// someone starts or joins a room, and leaving disconnects.
import * as openpgp from 'openpgp';
import { BRAND } from './brand';

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A message between tabs, before encryption. */
export type RoomMessage =
  | { t: 'hello'; key: string; ts: number; sig: string }
  | { t: 'state'; draft: unknown }
  | { t: 'reg'; reg: unknown }
  | { t: 'ask' };

export interface Peer {
  fingerprint: string;
  userID: string;
  /** The tab proved it holds this key by signing the room's challenge. */
  proven: boolean;
  /** Its public key (to add to a registration's key list). */
  key: openpgp.PublicKey;
}

export interface RoomEvents {
  onStatus(status: 'connecting' | 'connected' | 'closed', tabs: number, detail?: string): void;
  onMessage(m: RoomMessage, room: SigningRoom): void;
  /** Another tab arrived: send it what it needs (who we are, the document so far). */
  onJoined(room: SigningRoom): void;
}

/**
 * Sign together works only when this page was loaded from exactly the program's own
 * address (BRAND.relayUrl): a saved copy, another host or a preview can't open or join
 * rooms. Returns the relay's WebSocket address, or '' when signing rooms aren't available.
 */
export function relayBase(): string {
  return roomsAvailableHere() ? `wss://${new URL(BRAND.relayUrl).host}` : '';
}

/** The program's own address, where Sign together works ('' if rooms are turned off). */
export function officialOrigin(): string {
  try {
    return BRAND.relayUrl ? new URL(BRAND.relayUrl).origin : '';
  } catch {
    return '';
  }
}

export function roomsAvailableHere(): boolean {
  try {
    const official = officialOrigin();
    return !!official && location.origin === official && location.protocol === 'https:';
  } catch {
    return false;
  }
}

export class SigningRoom {
  ws: WebSocket | null = null;
  tabs = 0;
  private constructor(
    readonly secret: string,
    readonly id: string,
    private key: CryptoKey,
    private events: RoomEvents,
  ) {}

  /** A new room: a fresh random key. */
  static async create(events: RoomEvents) {
    return SigningRoom.open(b64url(crypto.getRandomValues(new Uint8Array(32))), events);
  }

  /** The room a link names (its key, from after "#"). */
  static async open(secret: string, events: RoomEvents) {
    const raw = fromB64url(secret);
    if (raw.length !== 32) throw new Error('That signing room link is incomplete. Ask for the link again.');
    const id = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`stop-room:${secret}`)))).slice(0, 22);
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return new SigningRoom(secret, id, key, events);
  }

  /** The link that invites others: this page, with the room key after "#". */
  link() {
    return `${location.href.split('#')[0]}#room=${this.secret}`;
  }

  connect() {
    const base = relayBase();
    if (!base) throw new Error('No signing room relay is set up for this site.');
    this.events.onStatus('connecting', 0);
    const ws = new WebSocket(`${base}/relay/${this.id}`);
    this.ws = ws;
    ws.onmessage = async (e) => {
      const data = String(e.data);
      if (data.startsWith('{')) {
        // The relay's own notices (not encrypted): who is in the room.
        try {
          const n = JSON.parse(data) as { relay: string; tabs: number };
          this.tabs = n.tabs;
          this.events.onStatus('connected', n.tabs);
          if (n.relay === 'welcome') {
            this.events.onJoined(this);
            await this.send({ t: 'ask' });
          }
          if (n.relay === 'joined') this.events.onJoined(this);
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        this.events.onMessage(await this.decrypt(data), this);
      } catch {
        /* not for this room's key: ignore */
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.events.onStatus('closed', 0);
    };
    ws.onerror = () => this.events.onStatus('closed', 0, 'The signing room relay could not be reached.');
  }

  leave() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.events.onStatus('closed', 0);
  }

  async send(m: RoomMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(await this.encrypt(m));
  }

  private async encrypt(m: RoomMessage) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(m))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return `v1.${b64(out)}`;
  }

  private async decrypt(s: string): Promise<RoomMessage> {
    if (!s.startsWith('v1.')) throw new Error('unknown message');
    const raw = fromB64(s.slice(3));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, this.key, raw.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt)) as RoomMessage;
  }

  /** The text a participant signs to show the others which key they hold. */
  challenge(ts: number) {
    return `S.T.O.P. SIGNING ROOM ${this.id} ${ts}`;
  }

  /** "hello": our public key and a fresh signature proving we hold its private half. */
  async hello(key: openpgp.PrivateKey) {
    const ts = Date.now();
    const sig = (await openpgp.sign({
      message: await openpgp.createMessage({ text: this.challenge(ts) }),
      signingKeys: key,
      detached: true,
      format: 'binary',
    })) as Uint8Array;
    await this.send({ t: 'hello', key: key.toPublic().armor(), ts, sig: b64(sig) });
  }

  /** Checks a "hello": the signature must be by the key sent, over this room's challenge. */
  async checkHello(m: Extract<RoomMessage, { t: 'hello' }>): Promise<Peer> {
    const key = await openpgp.readKey({ armoredKey: m.key });
    let proven = false;
    try {
      const r = await openpgp.verify({
        message: await openpgp.createMessage({ text: this.challenge(m.ts) }),
        signature: await openpgp.readSignature({ binarySignature: fromB64(m.sig) }),
        verificationKeys: key,
      });
      await r.signatures[0].verified;
      // A recent challenge only (a replayed old "hello" doesn't count).
      proven = Math.abs(Date.now() - m.ts) < 10 * 60 * 1000;
    } catch {
      proven = false;
    }
    return { fingerprint: key.getFingerprint().toUpperCase(), userID: key.getUserIDs()[0] ?? '', proven, key: key.toPublic() };
  }
}
