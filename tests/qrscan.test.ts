import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import * as openpgp from 'openpgp';
import { generateKeyPair, readAnyKey, unlockKey, signText, scanProgress, verifyScannedText, keyFromCodes, type SignedText } from '../src/crypto';
import { instrumentPdf, privateKeyPdf, setBrandSeal } from '../src/pdf';
import { decodeAllQr } from '../src/qrscan';

function has(cmd: string, arg = '--version') {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let key: openpgp.PrivateKey;
let privateArmored: string;
let signed: SignedText;
let pdf: Uint8Array;

beforeAll(async () => {
  // Use the real seal from index.html: artwork on the page must not confuse the reader.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const m = /id="brand-seal"[^>]*src="data:image\/png;base64,([^"]+)"/.exec(html);
  if (m) setBrandSeal(new Uint8Array(Buffer.from(m[1], 'base64')));
  ({ privateArmored } = await generateKeyPair({ name: 'Example Owner', passphrase: 'pw' }));
  key = await unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw');
  let seed = 9;
  const rand = () => (seed = (seed * 48271) % 2147483647).toString(36);
  const text = 'TEST INSTRUMENT. ' + Array.from({ length: 900 }, rand).join(' ');
  signed = await signText(key, text);
  pdf = await instrumentPdf({
    title: 'Long Test Instrument',
    text,
    fingerprint: signed.fingerprint,
    userID: signed.userID,
    signedAt: signed.signedAt,
    documentId: signed.documentId,
    codes: signed.codes,
  });
});

function readPages(dir: string, ext: string) {
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(ext)).sort()) {
    const png = PNG.sync.read(readFileSync(join(dir, f)));
    for (const c of decodeAllQr({ data: new Uint8ClampedArray(png.data), width: png.width, height: png.height })) found.add(c);
  }
  return [...found].join('\n');
}

describe.skipIf(!has('pdftoppm', '-v'))('reading codes back from the page images', () => {
  it('finds every code on a clean rendering', async () => {
    expect(signed.codes.length).toBeGreaterThanOrEqual(9);
    const dir = mkdtempSync('/tmp/opr-qr-');
    try {
      writeFileSync(join(dir, 'doc.pdf'), pdf);
      execFileSync('pdftoppm', ['-r', process.env.DPI ?? '200', '-png', join(dir, 'doc.pdf'), join(dir, 'p')]);
      const scanned = readPages(dir, '.png');
      expect(scanProgress(scanned).missing).toEqual([]);
      expect((await verifyScannedText({ scanned, registeredKey: key.toPublic() })).verdict).toBe('good');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!has('convert'))('finds every code on a tilted, blurry, noisy scan', async () => {
    const dir = mkdtempSync('/tmp/opr-qr-');
    try {
      writeFileSync(join(dir, 'doc.pdf'), pdf);
      execFileSync('pdftoppm', ['-r', process.env.DPI ?? '200', '-gray', '-png', join(dir, 'doc.pdf'), join(dir, 'p')]);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
        execFileSync('convert', [
          join(dir, f),
          ...['-background', 'white', '-rotate', '1.5', '-blur', '0x0.7', '-attenuate', '0.5', '+noise', 'Gaussian', '-quality', '65'],
          join(dir, f.replace('.png', '.jpg')),
        ]);
        execFileSync('convert', [join(dir, f.replace('.png', '.jpg')), join(dir, f.replace('.png', '.scan.png'))]);
      }
      const scanned = readPages(dir, '.scan.png');
      expect(scanProgress(scanned).missing).toEqual([]);
      expect((await verifyScannedText({ scanned, registeredKey: key.toPublic() })).verdict).toBe('good');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!has('convert'))('loads the private key from a photo-like image of its printed page', async () => {
    const dir = mkdtempSync('/tmp/opr-qr-');
    try {
      const pdfBytes = await privateKeyPdf({
        fingerprint: key.getFingerprint().toUpperCase(),
        userID: key.getUserIDs()[0],
        created: key.getCreationTime(),
        protectedByPassphrase: true,
        privateArmored,
      });
      writeFileSync(join(dir, 'key.pdf'), pdfBytes);
      execFileSync('pdftoppm', ['-r', '160', '-png', '-f', '1', '-l', '1', '-singlefile', join(dir, 'key.pdf'), join(dir, 'k')]);
      // Like a phone photo: a bit rotated, soft, noisy, JPEG-compressed, odd scale.
      execFileSync('convert', [
        join(dir, 'k.png'),
        ...['-background', 'white', '-rotate', '-2.5', '-resize', '87%', '-blur', '0x0.8', '-attenuate', '0.6', '+noise', 'Gaussian', '-quality', '60'],
        join(dir, 'k.jpg'),
      ]);
      execFileSync('convert', [join(dir, 'k.jpg'), join(dir, 'photo.png')]);
      const png = PNG.sync.read(readFileSync(join(dir, 'photo.png')));
      const codes = decodeAllQr({ data: new Uint8ClampedArray(png.data), width: png.width, height: png.height });
      const restored = (await keyFromCodes(codes)) as openpgp.PrivateKey;
      expect(restored.getFingerprint()).toBe(key.getFingerprint());
      await expect(unlockKey(restored, 'pw')).resolves.toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
