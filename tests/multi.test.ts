import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  signText,
  signedFromCodes,
  verifyScannedText,
  encodeRegistrationCodes,
  decodeRegistrationCodes,
  registrationScanProgress,
  mergeRegistrations,
  type Registration,
} from '../src/crypto';

const text = `WARRANTY DEED
For the consideration of Ten Dollars, EXAMPLE OWNER and EXAMPLE SPOUSE, Grantors, convey to EXAMPLE BUYER the real property in Pima County, Arizona:
Lot 1, Block 2, EXAMPLE SUBDIVISION.
Assessor's Parcel Number: 123-45-6789
Dated: November 12, 2026`;

async function makeKey(name: string) {
  const { privateArmored } = await generateKeyPair({ name, passphrase: 'pw-123456' });
  return unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw-123456');
}

let a: openpgp.PrivateKey;
let b: openpgp.PrivateKey;
let c: openpgp.PrivateKey;
let reg: Registration;

beforeAll(async () => {
  [a, b, c] = await Promise.all([makeKey('Example Owner'), makeKey('Example Spouse'), makeKey('Someone Else')]);
  reg = { parcel: '123-45-6789', keys: [a.toPublic(), b.toPublic()] };
});

describe('several owners signing one document', () => {
  it('good: every registered owner signed the same text', async () => {
    const one = await signText(a, text);
    const both = await signText(b, text, one);
    expect(both.signatures.map((s) => s.fingerprint)).toEqual([a, b].map((k) => k.getFingerprint().toUpperCase()));
    expect(both.codes[0]).toContain('PGPDOC2');
    const r = await verifyScannedText({ scanned: both.codes.join('\n'), registration: reg });
    expect(r.verdict).toBe('good');
    expect(r.signers?.map((s) => s.state)).toEqual(['pass', 'pass']);
    expect(r.checks.find((x) => x.label === 'Same text for every signer')?.state).toBe('pass');
    expect(r.checks.find((x) => x.label === 'Parcel number in the signed text')?.state).toBe('pass');
  });

  it('can continue from a partially signed document read back from its codes', async () => {
    const one = await signText(a, text);
    const restored = await signedFromCodes([...one.codes].reverse().join('\n'));
    expect(restored.signatures).toHaveLength(1);
    expect(restored.signatures[0].fingerprint).toBe(a.getFingerprint().toUpperCase());
    const both = await signText(b, text.toLowerCase().replace(/\n/g, '  '), restored); // same canonical text
    expect((await verifyScannedText({ scanned: both.codes.join('\n'), registration: reg })).verdict).toBe('good');
  });

  it('bad: a registered owner has not signed', async () => {
    const one = await signText(a, text);
    const r = await verifyScannedText({ scanned: one.codes.join('\n'), registration: reg });
    expect(r.verdict).toBe('bad');
    const missing = r.signers?.find((s) => s.fingerprint === b.getFingerprint().toUpperCase());
    expect(missing?.state).toBe('fail');
    expect(missing?.detail).toMatch(/No signature/);
  });

  it('bad: an extra signature from a key not registered for the parcel', async () => {
    const both = await signText(b, text, await signText(a, text));
    const three = await signText(c, text, both);
    const r = await verifyScannedText({ scanned: three.codes.join('\n'), registration: reg });
    expect(r.verdict).toBe('bad');
    expect(r.signers?.find((s) => !s.registered)?.detail).toMatch(/not registered/);
  });

  it('bad: signatures valid but for a different parcel', async () => {
    const both = await signText(b, text, await signText(a, text));
    const r = await verifyScannedText({ scanned: both.codes.join('\n'), registration: { ...reg, parcel: '999-99-9999' } });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((x) => x.label === 'Parcel number in the signed text')?.state).toBe('fail');
  });

  it('refuses different text or a second signature by the same key', async () => {
    const one = await signText(a, text);
    await expect(signText(b, text.replace('EXAMPLE BUYER', 'MALLORY'), one)).rejects.toThrow(/exactly the same text/);
    await expect(signText(a, text, one)).rejects.toThrow(/already signed/);
  });
});

describe('parcel registration codes', () => {
  it('round-trip the parcel and every key, in any scan order', async () => {
    const codes = await encodeRegistrationCodes(reg);
    expect(codes.every((x) => x.length < 360)).toBe(true);
    const back = await decodeRegistrationCodes([...codes].reverse().join('\n'));
    expect(back.parcel).toBe('123-45-6789');
    expect(back.keys.map((k) => k.getFingerprint())).toEqual(reg.keys.map((k) => k.getFingerprint()));
    expect(registrationScanProgress(codes.slice(1).join('\n')).missing).toEqual([1]);
  });

  it('merges the co-owners’ forms, and refuses ones that disagree', () => {
    const merged = mergeRegistrations([reg, { parcel: '123 45 6789', keys: [b.toPublic(), a.toPublic()] }]);
    expect(merged.keys).toHaveLength(2);
    expect(() => mergeRegistrations([reg, { parcel: '123-45-6789', keys: [a.toPublic()] }])).toThrow(/different keys/);
    expect(() => mergeRegistrations([reg, { parcel: '555-55-5555', keys: reg.keys }])).toThrow(/different parcels/);
  });
});

function has(cmd: string) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!has('gpg'))('GnuPG', () => {
  it('checks both owners’ signatures in the combined signature file', async () => {
    const both = await signText(b, text, await signText(a, text));
    const dir = mkdtempSync('/tmp/opr-multi-');
    try {
      const env = { ...process.env, GNUPGHOME: dir };
      writeFileSync(join(dir, 'keys.asc'), a.toPublic().armor() + '\n' + b.toPublic().armor());
      writeFileSync(join(dir, 'doc.txt'), both.canonical);
      writeFileSync(join(dir, 'doc.sig'), both.signature);
      execFileSync('gpg', ['--batch', '--import', join(dir, 'keys.asc')], { env, stdio: 'pipe' });
      const out = execFileSync('gpg', ['--batch', '--status-fd', '1', '--verify', join(dir, 'doc.sig'), join(dir, 'doc.txt')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      expect(out).toContain(`VALIDSIG ${a.getFingerprint().toUpperCase()}`);
      expect(out).toContain(`VALIDSIG ${b.getFingerprint().toUpperCase()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
