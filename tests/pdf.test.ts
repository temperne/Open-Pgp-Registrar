import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as openpgp from 'openpgp';
import { generateKeyPair, readAnyKey, unlockKey, signDocument, summarize, verifyFiling, keyFromCodes, type SignedDocument } from '../src/crypto';
import { registrationPdf, signaturePagePdf, printCopyPdf, privateKeyPdf, keyTextFromPdf, safeText } from '../src/pdf';

let key: openpgp.PrivateKey;
let privateArmored: string;
let originalPdf: Uint8Array;
let signed: SignedDocument;

beforeAll(async () => {
  ({ privateArmored } = await generateKeyPair({ name: 'Example Owner', passphrase: 'pw-for-tests' }));
  key = await unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw-for-tests');
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of ['WARRANTY DEED (sample)', 'Page two']) d.addPage([612, 792]).drawText(t, { x: 72, y: 700, font: f, size: 14 });
  originalPdf = await d.save();
  signed = await signDocument(key, originalPdf);
});

function regInfo(replacement = false) {
  const s = summarize(key);
  return {
    ownerName: 'Example Owner',
    parcels: '000-00-0000',
    propertyAddress: '1 Example Way',
    mailingAddress: 'PO Box 1, Example AZ',
    county: 'Example County',
    replacement,
    previousFingerprint: replacement ? 'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111 2222 3333' : '',
    fingerprint: s.fingerprint,
    algorithm: s.algorithm,
    created: s.created,
    userID: s.userIDs[0],
    publicKeyBinary: key.toPublic().write(),
    publicArmored: s.publicArmored,
  };
}

function sigInfo() {
  return {
    documentTitle: 'Warranty Deed',
    fileName: 'deed.pdf',
    fileSize: originalPdf.length,
    parcels: '000-00-0000',
    userID: signed.userID,
    fingerprint: signed.fingerprint,
    signedAt: signed.signedAt,
    sha256: signed.sha256,
    documentId: signed.documentId,
    payload: signed.payload,
  };
}

function has(cmd: string) {
  try {
    execFileSync(cmd, [cmd === 'pdftoppm' ? '-v' : '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const canScan = has('zbarimg') && has('pdftoppm');

/** Rasterizes a PDF and returns every code zbarimg finds, as "TYPE:data". */
function scan(pdf: Uint8Array): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'opr-scan-'));
  try {
    writeFileSync(join(dir, 'in.pdf'), pdf);
    execFileSync('pdftoppm', ['-r', '200', '-png', join(dir, 'in.pdf'), join(dir, 'p')]);
    const out: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.png')).sort()) {
      try {
        const typed = execFileSync('zbarimg', ['--quiet', join(dir, f)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        out.push(...typed.split(/\n(?=[A-Z0-9-]+:)/).map((s) => s.trim()).filter(Boolean));
      } catch {
        /* no codes on this page */
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PDF generation', () => {
  it('builds a registration form with the public key attachment', async () => {
    const pdf = await registrationPdf(regInfo());
    const d = await PDFDocument.load(pdf);
    expect(d.getPageCount()).toBe(2);
  });

  it('builds a replacement registration', async () => {
    const pdf = await registrationPdf(regInfo(true));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
  });

  it('builds a signature page and a combined print copy', async () => {
    const page = await signaturePagePdf(sigInfo());
    expect((await PDFDocument.load(page)).getPageCount()).toBe(1);
    const copy = await printCopyPdf(originalPdf, sigInfo());
    expect((await PDFDocument.load(copy)).getPageCount()).toBe(3);
  });

  it('explains when a combined copy cannot be made', async () => {
    await expect(printCopyPdf(new TextEncoder().encode('not a pdf'), sigInfo())).rejects.toThrow(/could not be read/);
  });

  it('builds a private key backup', async () => {
    const pdf = await privateKeyPdf({
      fingerprint: signed.fingerprint,
      userID: signed.userID,
      created: key.getCreationTime(),
      protectedByPassphrase: true,
      privateArmored,
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it('private key PDF embeds the key, and the tool can load it back', async () => {
    const pdf = await privateKeyPdf({
      fingerprint: signed.fingerprint,
      userID: signed.userID,
      created: key.getCreationTime(),
      protectedByPassphrase: true,
      privateArmored,
    });
    const back = (await readAnyKey(await keyTextFromPdf(pdf))) as openpgp.PrivateKey;
    expect(back.isPrivate()).toBe(true);
    expect(back.getFingerprint().toUpperCase()).toBe(signed.fingerprint);
    await expect(unlockKey(back, 'pw-for-tests')).resolves.toBeTruthy();
  });

  it('registration form embeds the public key for the Recorder', async () => {
    const back = await readAnyKey(await keyTextFromPdf(await registrationPdf(regInfo())));
    expect(back.isPrivate()).toBe(false);
    expect(back.getFingerprint().toUpperCase()).toBe(signed.fingerprint);
  });

  it('explains when a PDF has no key inside', async () => {
    await expect(keyTextFromPdf(originalPdf)).rejects.toThrow(/No key found/);
  });

  it('copes with characters outside the standard PDF fonts', async () => {
    expect(safeText('José “Pepe” Núñez — 李')).toBe('José "Pepe" Núñez - ?');
    const info = { ...regInfo(), ownerName: 'José Núñez 李明' };
    await expect(registrationPdf(info)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe.skipIf(!canScan)('printed codes scan back correctly', () => {
  it('registration: fingerprint QR and public key QR', async () => {
    const codes = scan(await registrationPdf(regInfo()));
    const fpr = summarize(key).fingerprint;
    expect(codes).toContain(`QR-Code:${fpr}`);
    const keyCode = codes.find((c) => c.startsWith('QR-Code:PGPKEY1|'));
    expect(keyCode).toBeTruthy();
    const scannedKey = await readAnyKey(keyCode!.slice('QR-Code:'.length));
    expect(scannedKey.getFingerprint().toUpperCase()).toBe(fpr);
  });

  it('signature page: QR verifies and barcode gives the document ID', async () => {
    const codes = scan(await signaturePagePdf(sigInfo()));
    expect(codes).toContain(`CODE-128:${signed.documentId}`);
    const qr = codes.find((c) => c.startsWith('QR-Code:PGPSIG1|'));
    expect(qr).toBeTruthy();
    const r = await verifyFiling({ payload: qr!.slice('QR-Code:'.length), registeredKey: key.toPublic(), document: originalPdf });
    expect(r.verdict).toBe('good');
  });

  it('private key page QR codes restore the key', async () => {
    const codes = scan(
      await privateKeyPdf({
        fingerprint: signed.fingerprint,
        userID: signed.userID,
        created: key.getCreationTime(),
        protectedByPassphrase: true,
        privateArmored,
      }),
    );
    const keyCodes = codes.filter((c) => c.startsWith('QR-Code:PGPK1|')).map((c) => c.slice('QR-Code:'.length));
    expect(keyCodes.length).toBeGreaterThanOrEqual(1);
    const restored = (await keyFromCodes(keyCodes)) as openpgp.PrivateKey;
    expect(restored.getFingerprint().toUpperCase()).toBe(signed.fingerprint);
    await expect(unlockKey(restored, 'pw-for-tests')).resolves.toBeTruthy();
  });
});
