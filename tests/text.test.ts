import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  signText,
  decodeCodes,
  scanProgress,
  verifyScannedText,
  encodeCodes,
  toBase64,
  type SignedText,
} from '../src/crypto';
import { canonicalText, firstDifference, safeText } from '../src/text';
import { instrumentPdf } from '../src/pdf';
import { TEMPLATES } from '../src/templates';

const fields = {
  grantor: 'Example Owner',
  grantee: 'Example Buyer',
  county: 'Pima',
  parcels: '000-00-0000',
  propertyAddress: '100 Example St, Tucson AZ',
  legal: 'Lot 1, Block 2, EXAMPLE SUBDIVISION, according to Book 1 of Maps and Plats, Page 1, records of Pima County, Arizona.',
  consideration: 'Ten Dollars and other valuable consideration',
  date: 'November 12, 2026',
};
const deedText = TEMPLATES.find((t) => t.id === 'warranty')!.body(fields);

let key: openpgp.PrivateKey;
let signed: SignedText;

beforeAll(async () => {
  const { privateArmored } = await generateKeyPair({ name: 'Example Owner', passphrase: 'pw-for-tests' });
  key = await unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw-for-tests');
  signed = await signText(key, deedText);
});

describe('canonical text', () => {
  it('ignores case, spacing, line breaks and curly quotes', () => {
    const a = 'The Grantor’s  interest\nin LOT 1 — Block 2.';
    const b = "  the grantor's interest in lot 1 - block 2.  ";
    expect(canonicalText(a)).toBe(canonicalText(b));
    expect(canonicalText(a)).toBe("THE GRANTOR'S INTEREST IN LOT 1 - BLOCK 2.");
  });

  it('keeps words, numbers and punctuation significant', () => {
    expect(canonicalText('$100,000.00')).not.toBe(canonicalText('$100,000'));
    expect(canonicalText('Lot 1')).not.toBe(canonicalText('Lot 7'));
  });

  it('signs only characters the PDF can print', () => {
    expect(safeText('Não 李')).toBe('Não ?');
  });

  it('reports where two texts differ', () => {
    const d = firstDifference(signed.canonical, deedText.replace('Example Buyer', 'Mallory Forger'));
    expect(d).not.toBeNull();
    expect(d!.signed).toContain('EXAMPLE BUYER');
    expect(d!.other).toContain('MALLORY FORGER');
    expect(firstDifference(signed.canonical, deedText.toLowerCase().replace(/\n/g, '  '))).toBeNull();
  });
});

describe('codes', () => {
  it('splits the signed message into compact codes', () => {
    expect(signed.codes.length).toBeGreaterThanOrEqual(1);
    for (const c of signed.codes) {
      expect(c).toMatch(/^PGPQ1\|[0-9A-F]{12}\|\d+\/\d+\|/);
      expect(c.length).toBeLessThan(360);
    }
  });

  it('reassembles codes scanned in any order, with duplicates and scanner newlines', async () => {
    let seed = 11;
    const rand = () => (seed = (seed * 48271) % 2147483647).toString(36);
    const long = await signText(key, deedText + '\n' + Array.from({ length: 300 }, rand).join(' '));
    expect(long.codes.length).toBeGreaterThan(1);
    const scanned = [...long.codes].reverse().concat(long.codes[0]).join('\r\n');
    const d = await decodeCodes(scanned);
    expect(d.canonical).toBe(long.canonical);
    expect(d.documentId).toBe(long.documentId);
  });

  it('reports which codes are still missing', async () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647).toString(36);
    const long = await signText(key, Array.from({ length: 400 }, rand).join(' '));
    expect(long.codes.length).toBeGreaterThan(1);
    const partial = long.codes.slice(1).join('\n');
    const p = scanProgress(partial);
    expect(p.missing).toEqual([1]);
    await expect(decodeCodes(partial)).rejects.toThrow(/missing code 1/);
    const r = await verifyScannedText({ scanned: partial, registeredKey: key.toPublic() });
    expect(r.verdict).toBe('incomplete');
  });

  it('refuses codes from two different documents', async () => {
    const other = await signText(key, 'A different deed');
    await expect(decodeCodes([signed.codes[0], other.codes[0]].join('\n'))).rejects.toThrow(/more than one document/);
  });
});

describe('verifying a paper filing', () => {
  it('good: registered key, codes scanned from the paper', async () => {
    const r = await verifyScannedText({ scanned: signed.codes.join('\n'), registeredKey: key.toPublic() });
    expect(r.verdict).toBe('good');
    expect(r.signedText).toBe(signed.canonical);
    expect(r.signedText).toContain('EXAMPLE BUYER');
  });

  it('bad: codes signed by a different key', async () => {
    const other = await generateKeyPair({ name: 'Forger', passphrase: '' });
    const forger = (await readAnyKey(other.privateArmored)) as openpgp.PrivateKey;
    const forged = await signText(forger, deedText);
    const r = await verifyScannedText({ scanned: forged.codes.join('\n'), registeredKey: key.toPublic() });
    expect(r.verdict).toBe('bad');
  });

  it('bad: text altered inside the codes, even when the fingerprint is copied', async () => {
    const altered = canonicalText(deedText.replace('Example Buyer', 'Mallory Forger'));
    const { sha256Hex } = await import('../src/crypto');
    const sha = await sha256Hex(new TextEncoder().encode(altered));
    const codes = await encodeCodes(signed.fingerprint, signed.signature, altered, sha);
    const r = await verifyScannedText({ scanned: codes.join('\n'), registeredKey: key.toPublic() });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((c) => c.label === 'Signature valid')?.state).toBe('fail');
  });

  it('bad: garbage', async () => {
    const r = await verifyScannedText({ scanned: 'hello', registeredKey: key.toPublic() });
    expect(r.verdict).toBe('bad');
  });

  it('the payload carries a plain base64 signature', () => {
    expect(signed.codes.join('')).toContain(toBase64(signed.signature).slice(0, 20));
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
  it('verifies the recovered text with stock gpg', () => {
    const dir = mkdtempSync('/tmp/opr-');
    try {
      const env = { ...process.env, GNUPGHOME: dir };
      writeFileSync(join(dir, 'pub.asc'), key.toPublic().armor());
      writeFileSync(join(dir, 'document.txt'), signed.canonical);
      writeFileSync(join(dir, 'document.sig'), signed.signature);
      execFileSync('gpg', ['--batch', '--import', join(dir, 'pub.asc')], { env, stdio: 'pipe' });
      const out = execFileSync('gpg', ['--batch', '--status-fd', '1', '--verify', join(dir, 'document.sig'), join(dir, 'document.txt')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      expect(out).toContain(`VALIDSIG ${signed.fingerprint}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!has('zbarimg') || !has('pdftoppm', '-v'))('printed instrument', () => {
  it('codes printed on the document scan back and verify', async () => {
    let seed = 3;
    const rand = () => (seed = (seed * 48271) % 2147483647).toString(36);
    const fullText = deedText + '\n\nExhibit A: ' + Array.from({ length: 350 }, rand).join(' ');
    const long = await signText(key, fullText);
    expect(long.codes.length).toBeGreaterThan(3);
    const pdf = await instrumentPdf({
      title: 'Warranty Deed',
      text: fullText,
      returnTo: 'Example Buyer\nPO Box 1\nTucson AZ 85701',
      signers: 'Example Owner',
      fingerprint: long.fingerprint,
      userID: long.userID,
      signedAt: long.signedAt,
      documentId: long.documentId,
      codes: long.codes,
    });
    const dir = mkdtempSync('/tmp/opr-scan-');
    try {
      writeFileSync(join(dir, 'doc.pdf'), pdf);
      execFileSync('pdftoppm', ['-r', '200', '-png', join(dir, 'doc.pdf'), join(dir, 'p')]);
      let scanned = '';
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
        try {
          scanned += execFileSync('zbarimg', ['--quiet', '--raw', join(dir, f)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() + '\n';
        } catch {
          /* page without codes */
        }
      }
      expect(scanProgress(scanned).missing).toEqual([]);
      const r = await verifyScannedText({ scanned, registeredKey: key.toPublic() });
      expect(r.verdict).toBe('good');
      expect(r.signedText).toBe(long.canonical);
      // And what was printed on the pages is the text that was signed.
      const txt = execFileSync('pdftotext', [join(dir, 'doc.pdf'), '-'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      expect(canonicalText(txt)).toContain(canonicalText(deedText).slice(0, 200));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
