import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  summarize,
  signDocument,
  parsePayload,
  verifyFiling,
  formatFingerprint,
  isPrivate,
  type SignedDocument,
} from '../src/crypto';

const doc = new TextEncoder().encode('WARRANTY DEED\nParcel 000-00-0000\nGrantor: EXAMPLE OWNER\n');
let privateArmored: string;
let publicArmored: string;
let unlocked: openpgp.PrivateKey;
let signed: SignedDocument;

beforeAll(async () => {
  ({ privateArmored, publicArmored } = await generateKeyPair({
    name: 'Example Owner',
    email: 'owner@example.invalid',
    passphrase: 'correct horse battery staple',
  }));
  const key = await readAnyKey(privateArmored);
  if (!isPrivate(key)) throw new Error('expected private key');
  unlocked = await unlockKey(key, 'correct horse battery staple');
  signed = await signDocument(unlocked, doc);
});

describe('keys', () => {
  it('generates a passphrase-protected v4 Ed25519 key', async () => {
    const key = await readAnyKey(privateArmored);
    const s = summarize(key);
    expect(s.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(s.algorithm).toMatch(/Ed25519/);
    expect(s.hasPrivate).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.userIDs[0]).toBe('Example Owner <owner@example.invalid>');
  });

  it('rejects a wrong passphrase and accepts the right one', async () => {
    const key = (await readAnyKey(privateArmored)) as openpgp.PrivateKey;
    await expect(unlockKey(key, 'nope')).rejects.toThrow(/Wrong passphrase/);
    const ok = await unlockKey(key, 'correct horse battery staple');
    expect(ok.isDecrypted()).toBe(true);
  });

  it('reads public keys and reports a friendly error for junk', async () => {
    const pub = await readAnyKey(publicArmored);
    expect(pub.isPrivate()).toBe(false);
    await expect(readAnyKey('hello')).rejects.toThrow(/does not look like an OpenPGP key/);
  });

  it('reads binary keys', async () => {
    const pub = await readAnyKey(publicArmored);
    const bin = pub.write();
    const back = await readAnyKey(bin);
    expect(back.getFingerprint()).toBe(pub.getFingerprint());
  });

  it('formats fingerprints in groups of four', () => {
    expect(formatFingerprint('679f2d203aa613386ec59e872165d437bf00575a')).toBe(
      '679F 2D20 3AA6 1338 6EC5 9E87 2165 D437 BF00 575A',
    );
  });
});

describe('signing and payload', () => {
  it('refuses to sign with a locked key', async () => {
    const key = (await readAnyKey(privateArmored)) as openpgp.PrivateKey;
    await expect(signDocument(key, doc)).rejects.toThrow(/Unlock/);
  });

  it('builds a compact PGPSIG1 payload', () => {
    expect(signed.payload.startsWith(`PGPSIG1|${signed.fingerprint}|${signed.sha256}|`)).toBe(true);
    // Ed25519 plus openpgp.js signature salt: about 366 chars, easily one QR code.
    expect(signed.payload.length).toBeLessThan(400);
    expect(signed.documentId).toBe(signed.sha256.slice(0, 24).toUpperCase());
  });

  it('parses payloads, tolerating scanner whitespace', () => {
    const p = parsePayload(`  ${signed.payload.slice(0, 50)}\n${signed.payload.slice(50)}\r\n`);
    expect(p.fingerprint).toBe(signed.fingerprint);
    expect(p.sha256).toBe(signed.sha256);
    expect(p.signature).toEqual(signed.signature);
  });

  it('rejects malformed payloads', () => {
    expect(() => parsePayload('hello')).toThrow(/Not a signature code/);
    expect(() => parsePayload('PGPSIG1|XYZ|00|AA==')).toThrow(/fingerprint/);
  });
});

describe('recorder verification (Exhibit C outcomes)', () => {
  it('good: registered key, original document', async () => {
    const pub = await readAnyKey(publicArmored);
    const r = await verifyFiling({ payload: signed.payload, registeredKey: pub, document: doc });
    expect(r.verdict).toBe('good');
    expect(r.checks.every((c) => c.state === 'pass')).toBe(true);
    expect(r.signedAt).toBeInstanceOf(Date);
  });

  it('incomplete: no document file supplied', async () => {
    const pub = await readAnyKey(publicArmored);
    const r = await verifyFiling({ payload: signed.payload, registeredKey: pub });
    expect(r.verdict).toBe('incomplete');
  });

  it('bad: document edited after signing', async () => {
    const pub = await readAnyKey(publicArmored);
    const edited = new TextEncoder().encode('WARRANTY DEED\nParcel 000-00-0000\nGrantor: FORGER\n');
    const r = await verifyFiling({ payload: signed.payload, registeredKey: pub, document: edited });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((c) => c.label === 'Document matches code')?.state).toBe('fail');
    expect(r.checks.find((c) => c.label === 'Signature valid')?.state).toBe('fail');
  });

  it('bad: signed by some other key', async () => {
    const other = await generateKeyPair({ name: 'Forger', passphrase: '' });
    const otherKey = (await readAnyKey(other.privateArmored)) as openpgp.PrivateKey;
    const forged = await signDocument(otherKey, doc);
    const pub = await readAnyKey(publicArmored);
    const r = await verifyFiling({ payload: forged.payload, registeredKey: pub, document: doc });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((c) => c.label === 'Signed by the registered key')?.state).toBe('fail');
    expect(r.checks.find((c) => c.label === 'Signature valid')?.state).toBe('fail');
  });

  it('bad: forged code that claims the registered fingerprint', async () => {
    const other = await generateKeyPair({ name: 'Forger', passphrase: '' });
    const otherKey = (await readAnyKey(other.privateArmored)) as openpgp.PrivateKey;
    const forged = await signDocument(otherKey, doc);
    const lying = forged.payload.replace(forged.fingerprint, signed.fingerprint);
    const pub = await readAnyKey(publicArmored);
    const r = await verifyFiling({ payload: lying, registeredKey: pub, document: doc });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((c) => c.label === 'Signature valid')?.state).toBe('fail');
  });

  it('bad: unreadable code', async () => {
    const pub = await readAnyKey(publicArmored);
    const r = await verifyFiling({ payload: 'random text', registeredKey: pub, document: doc });
    expect(r.verdict).toBe('bad');
  });
});

function hasGpg() {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGpg())('GnuPG interoperability', () => {
  it('signature from the QR payload verifies with standard gpg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opr-gpg-'));
    try {
      const env = { ...process.env, GNUPGHOME: dir };
      writeFileSync(join(dir, 'pub.asc'), publicArmored);
      writeFileSync(join(dir, 'deed.txt'), doc);
      const sigB64 = signed.payload.split('|')[3];
      writeFileSync(join(dir, 'deed.sig'), Buffer.from(sigB64, 'base64'));
      execFileSync('gpg', ['--batch', '--import', join(dir, 'pub.asc')], { env, stdio: 'pipe' });
      const out = execFileSync(
        'gpg',
        ['--batch', '--status-fd', '1', '--verify', join(dir, 'deed.sig'), join(dir, 'deed.txt')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString();
      expect(out).toMatch(new RegExp(`VALIDSIG ${signed.fingerprint}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads and signs with a key generated by gpg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opr-gpg-'));
    try {
      const env = { ...process.env, GNUPGHOME: dir };
      execFileSync(
        'gpg',
        ['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'pw123456', '--quick-gen-key', 'GPG Owner', 'ed25519', 'sign', 'never'],
        { env, stdio: 'pipe' },
      );
      const armored = execFileSync(
        'gpg',
        ['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'pw123456', '--armor', '--export-secret-keys'],
        { env },
      ).toString();
      const key = (await readAnyKey(armored)) as openpgp.PrivateKey;
      expect(summarize(key).locked).toBe(true);
      const ok = await unlockKey(key, 'pw123456');
      const s = await signDocument(ok, doc);
      const r = await verifyFiling({ payload: s.payload, registeredKey: key.toPublic(), document: doc });
      expect(r.verdict).toBe('good');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
