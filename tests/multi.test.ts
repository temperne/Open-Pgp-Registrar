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

function has(cmd: string, arg = '--version') {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
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

describe('multi-owner PDFs', () => {
  it('makes one registration per parcel, each carrying the full key list', async () => {
    const { registrationPdf, registrationsFromPdf, keyTextFromPdf } = await import('../src/pdf');
    const pdf = await registrationPdf({
      ownerName: 'Example Owner',
      parcels: '123-45-6789\n123-45-6790',
      coOwnerKeys: [b.toPublic()],
      fingerprint: a.getFingerprint().toUpperCase(),
      algorithm: 'Ed25519',
      created: a.getCreationTime(),
      userID: a.getUserIDs()[0],
      publicKeyBinary: a.toPublic().write(),
      publicArmored: a.toPublic().armor(),
    });
    const regs = await registrationsFromPdf(pdf);
    expect(regs.map((r) => r.parcel)).toEqual(['123-45-6789', '123-45-6790']);
    for (const r of regs) expect(r.keys.map((k) => k.getFingerprint())).toEqual([a.getFingerprint(), b.getFingerprint()]);
    // Loading "a key" from the form still gives this registrant's own key, not a co-owner's.
    expect((await readAnyKey(await keyTextFromPdf(pdf))).getFingerprint()).toBe(a.getFingerprint());
  });

  it('embeds the document so the next owner can sign exactly the same text', async () => {
    const { instrumentPdf, draftFromPdf } = await import('../src/pdf');
    const { toBase64 } = await import('../src/crypto');
    const one = await signText(a, text);
    const pdf = await instrumentPdf({
      title: '',
      text,
      signatures: one.signatures,
      documentId: one.documentId,
      codes: one.codes,
      required: { parcel: reg.parcel, keys: reg.keys.map((k) => ({ fingerprint: k.getFingerprint().toUpperCase(), userID: k.getUserIDs()[0] })) },
      draft: {
        format: 'stop-document-1',
        title: '',
        text,
        returnTo: '',
        signers: '',
        signatures: one.signatures.map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) })),
      },
    });
    const d = await draftFromPdf(pdf);
    expect(d?.text).toBe(text);
    expect(d?.signatures).toHaveLength(1);
  });

  it('public key card loads as the owner’s public key', async () => {
    const { publicKeyCardPdf, keyTextFromPdf } = await import('../src/pdf');
    const pdf = await publicKeyCardPdf({
      fingerprint: b.getFingerprint().toUpperCase(),
      userID: b.getUserIDs()[0],
      created: b.getCreationTime(),
      publicArmored: b.toPublic().armor(),
      publicKeyBinary: b.toPublic().write(),
    });
    const k = await readAnyKey(await keyTextFromPdf(pdf));
    expect(k.isPrivate()).toBe(false);
    expect(k.getFingerprint()).toBe(b.getFingerprint());
  });

  it.skipIf(!has('pdftoppm', '-v') || !has('zbarimg'))('registration key list scans back from page 2', async () => {
    const { registrationPdf } = await import('../src/pdf');
    const pdf = await registrationPdf({
      ownerName: 'Example Owner',
      parcels: '123-45-6789',
      coOwnerKeys: [b.toPublic()],
      fingerprint: a.getFingerprint().toUpperCase(),
      algorithm: 'Ed25519',
      created: a.getCreationTime(),
      userID: a.getUserIDs()[0],
      publicKeyBinary: a.toPublic().write(),
      publicArmored: a.toPublic().armor(),
    });
    const dir = mkdtempSync('/tmp/opr-reg-');
    try {
      writeFileSync(join(dir, 'r.pdf'), pdf);
      execFileSync('pdftoppm', ['-r', '200', '-png', '-f', '2', '-l', '2', '-singlefile', join(dir, 'r.pdf'), join(dir, 'p2')]);
      const scanned = execFileSync('zbarimg', ['--quiet', '--raw', join(dir, 'p2.png')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const back = await decodeRegistrationCodes(scanned);
      expect(back.parcel).toBe('123-45-6789');
      expect(back.keys).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('key descriptions', () => {
  it('travel in the codes, the embedded registration, and the check results', async () => {
    const labelled: Registration = { parcel: '123-45-6789', keys: [a.toPublic(), b.toPublic()], labels: ['Doe Family Trust', 'Beneficiary'] };
    const back = await decodeRegistrationCodes((await encodeRegistrationCodes(labelled)).join('\n'));
    expect(back.labels).toEqual(['Doe Family Trust', 'Beneficiary']);
    const merged = mergeRegistrations([back, { parcel: '123-45-6789', keys: [b.toPublic(), a.toPublic()] }]);
    expect(merged.labels).toEqual(['Doe Family Trust', 'Beneficiary']);
    const both = await signText(b, text, await signText(a, text));
    const r = await verifyScannedText({ scanned: both.codes.join('\n'), registration: merged });
    expect(r.verdict).toBe('good');
    expect(r.checks.map((c) => c.label)).toContain('Signed by Example Owner (Doe Family Trust)');

    const { registrationPdf, registrationsFromPdf } = await import('../src/pdf');
    const pdf = await registrationPdf({
      ownerName: 'Doe Family Trust',
      parcels: '123-45-6789',
      coOwnerKeys: [b.toPublic()],
      keyLabels: { [a.getFingerprint().toUpperCase()]: 'Doe Family Trust', [b.getFingerprint().toUpperCase()]: 'Beneficiary' },
      fingerprint: a.getFingerprint().toUpperCase(),
      algorithm: 'Ed25519',
      created: a.getCreationTime(),
      userID: a.getUserIDs()[0],
      publicKeyBinary: a.toPublic().write(),
      publicArmored: a.toPublic().armor(),
    });
    expect((await registrationsFromPdf(pdf))[0].labels).toEqual(['Doe Family Trust', 'Beneficiary']);
  });

  it('one key on its own is a complete registration', async () => {
    const solo = await signText(a, text);
    const r = await verifyScannedText({ scanned: solo.codes.join('\n'), registration: { parcel: '123-45-6789', keys: [a.toPublic()] } });
    expect(r.verdict).toBe('good');
  });
});
