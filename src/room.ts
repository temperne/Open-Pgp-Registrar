// Signing rooms: co-owners (and buyers) sign the same document live, each in
// their own tab, through the program's relay (worker/src/index.ts).
//
// Privacy: the room's key is 32 random bytes carried in the link after "#",
// which browsers never send to a server. Every message is encrypted with it
// (AES-GCM) before it leaves the tab, so the relay only ever sees ciphertext and
// a room name derived from the key by a one-way hash. Nothing connects until
// someone starts or joins a room, and leaving disconnects.
import * as openpgp from 'openpgp';
import { BRAND, MASTER_URL, MASTER_FALLBACK_URL } from './brand';

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
  | { t: 'need-file'; hash: string; to?: string }
  | { t: 'file-part'; hash: string; i: number; n: number; data: string }
  // Live editing before anyone signs: changed form fields, the registration, keys.
  | { t: 'prep'; fields: Record<string, string | boolean>; signReg?: unknown; buyers?: string[]; coOwners?: string[] }
  // The meetup room: who is there (signed), private invitations, and goodbyes.
  | { t: 'profile'; data: string; sig: string }
  | { t: 'invite'; from: string; to: string; iv: string; ct: string; sig: string }
  | { t: 'invite-reply'; from: string; to: string; ok: boolean }
  | { t: 'bye'; from: string; ts: number; sig: string }
  | { t: 'settings'; settings: string; key: string; sig: string }
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
/**
 * Every address where this site's signing rooms work, in the order they are tried: its
 * own, then (when it relays through the master site) the master's backup server.
 */
/** The meetup room's key: public on purpose (anyone may join), so its name is fixed too. */
export const MEETUP_SECRET = 'TMyTXDYH0G3X4ZXC2eYJOfYkjwp-MsgFeqxJ9nMDqlA';

/**
 * Private invitations in the public meetup room: each tab brings a fresh ECDH key pair
 * (P-256) and shows its public half in its signed profile; an invitation is encrypted
 * with the key both sides derive, so only the invitee can read it.
 */
export async function newMeetupKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const pub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pair, pub };
}
async function sharedKey(mine: CryptoKeyPair, theirPub: string) {
  const pub = await crypto.subtle.importKey('raw', fromB64(theirPub) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, mine.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealFor(mine: CryptoKeyPair, theirPub: string, data: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sharedKey(mine, theirPub), new TextEncoder().encode(JSON.stringify(data))));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function openFrom(mine: CryptoKeyPair, theirPub: string, iv: string, ct: string): Promise<unknown> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) as BufferSource }, await sharedKey(mine, theirPub), fromB64(ct) as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt));
}

export function officialOrigins(): string[] {
  const own = officialOrigin();
  if (!own) return [];
  try {
    return own === new URL(MASTER_URL).origin ? [own, new URL(MASTER_FALLBACK_URL).origin] : [own];
  } catch {
    return [own];
  }
}

/**
 * The relays to try, in order (the same order for everyone, so a room meets on one of
 * them). With the master site, the project's own server comes first (no per-message
 * cost, no size limit), then Cloudflare as the backup.
 */
export function relayBases(): string[] {
  if (!roomsAvailableHere()) return [];
  const o = officialOrigins();
  return (o.length > 1 ? [o[1], o[0]] : o).map((x) => `wss://${new URL(x).host}`);
}

/** @deprecated The first relay; see relayBases. */
export function relayBase(): string {
  return relayBases()[0] ?? '';
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
    return !!official && officialOrigins().includes(location.origin) && location.protocol === 'https:';
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
    const r = await SigningRoom.open(b64url(crypto.getRandomValues(new Uint8Array(32))), events);
    r.host = true;
    return r;
  }

  /** This tab started the room: its settings (county, office, names, logo) are the room's. */
  host = false;

  /** The room's settings, signed by the person who started it. */
  async shareSettings(key: openpgp.PrivateKey, settings: string) {
    const sig = (await openpgp.sign({
      message: await openpgp.createMessage({ text: `S.T.O.P. ROOM SETTINGS ${this.id}\n${settings}` }),
      signingKeys: key,
      detached: true,
      format: 'binary',
    })) as Uint8Array;
    await this.send({ t: 'settings', settings, key: key.toPublic().armor(), sig: b64(sig) });
  }

  /** The signer of a settings message (its fingerprint), or null if the signature doesn't hold. */
  async checkSettings(m: Extract<RoomMessage, { t: 'settings' }>): Promise<string | null> {
    try {
      const key = await openpgp.readKey({ armoredKey: m.key });
      const r = await openpgp.verify({
        message: await openpgp.createMessage({ text: `S.T.O.P. ROOM SETTINGS ${this.id}\n${m.settings}` }),
        signature: await openpgp.readSignature({ binarySignature: fromB64(m.sig) }),
        verificationKeys: key,
      });
      await r.signatures[0].verified;
      return key.getFingerprint().toUpperCase();
    } catch {
      return null;
    }
  }

  /** The room a link names (its key, from after "#"). */
  static async open(secret: string, events: RoomEvents) {
    const raw = fromB64url(secret);
    if (raw.length !== 32) throw new Error('That signing room link is incomplete. Ask for the link again.');
    const id = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`stop-room:${secret}`)))).slice(0, 22);
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return new SigningRoom(secret, id, key, events);
  }

  /** The public meetup room: everyone who joins uses this same, public key. */
  static async meetup(events: RoomEvents) {
    const r = await SigningRoom.open(MEETUP_SECRET, events);
    r.isMeetup = true;
    return r;
  }

  isMeetup = false;

  /** A detached OpenPGP signature over a labelled text, as base64. */
  async signBlob(key: openpgp.PrivateKey, label: string, data: string) {
    const sig = (await openpgp.sign({
      message: await openpgp.createMessage({ text: `S.T.O.P. ${label} ${this.id}\n${data}` }),
      signingKeys: key,
      detached: true,
      format: 'binary',
    })) as Uint8Array;
    return b64(sig);
  }

  /** Whether a blob was signed by this key. */
  async verifyBlob(key: openpgp.PublicKey, label: string, data: string, sig: string) {
    try {
      const r = await openpgp.verify({
        message: await openpgp.createMessage({ text: `S.T.O.P. ${label} ${this.id}\n${data}` }),
        signature: await openpgp.readSignature({ binarySignature: fromB64(sig) }),
        verificationKeys: key,
      });
      await r.signatures[0].verified;
      return true;
    } catch {
      return false;
    }
  }

  /** The link that invites others: this page, with the room key after "#". */
  link() {
    return `${location.href.split('#')[0]}#room=${this.secret}`;
  }

  /** Which relay the room is on, by its place in relayBases (0: the first choice; 1: the backup). */
  via = 0;

  connect(attempt = 0) {
    const bases = relayBases();
    const base = bases[attempt];
    if (!base) throw new Error('No signing room relay is set up for this site.');
    this.via = attempt;
    this.events.onStatus('connecting', 0);
    const ws = new WebSocket(`${base}/relay/${this.id}`);
    this.ws = ws;
    // A relay that doesn't welcome us (down, refusing, or out of its free quota): try the
    // next one. Everyone tries them in the same order, so the room meets on the same one.
    let welcomed = false;
    const next = () => {
      if (welcomed || this.ws !== ws || attempt + 1 >= bases.length) return false;
      clearTimeout(timer);
      ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      this.connect(attempt + 1);
      return true;
    };
    const timer = setTimeout(next, 8000);
    ws.onmessage = async (e) => {
      const data = String(e.data);
      if (data.startsWith('{')) {
        // The relay's own notices (not encrypted): who is in the room.
        try {
          const n = JSON.parse(data) as { relay: string; tabs: number };
          this.tabs = n.tabs;
          this.events.onStatus('connected', n.tabs);
          if (n.relay === 'welcome') {
            welcomed = true;
            clearTimeout(timer);
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
      if (next()) return;
      clearTimeout(timer);
      if (this.ws === ws) this.events.onStatus('closed', 0);
    };
    ws.onerror = () => {
      if (next()) return;
      this.events.onStatus('closed', 0, 'The signing room relay could not be reached.');
    };
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
