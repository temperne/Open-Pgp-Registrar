import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';
import * as openpgp from 'openpgp';
import { generateKeyPair, readAnyKey, unlockKey, signText, verifyScannedText, signDocument, verifyBinaryFile, binarySignatureFrom } from '../src/crypto';
import { extractFile, fileSignedText, docxText } from '../src/extract';
import { filePackagePdf, sourceFromPdf, checkedCopyPdf } from '../src/pdf';

function has(cmd: string, arg = '--version') {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let key: openpgp.PrivateKey;
beforeAll(async () => {
  const { privateArmored } = await generateKeyPair({ name: 'Example Owner', passphrase: 'pw-123456' });
  key = await unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw-123456');
});

const file = (bytes: Uint8Array, name: string, type = '') => new File([bytes as BlobPart], name, { type });

async function textPdf(pages: string[]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of pages) d.addPage([612, 792]).drawText(t, { x: 72, y: 700, font: f, size: 12 });
  return d.save();
}

function docx(paragraphs: string[]) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  });
}

function png() {
  const p = new PNG({ width: 40, height: 30 });
  p.data.fill(200);
  return new Uint8Array(PNG.sync.write(p));
}

describe('reading files to sign', () => {
  it('Word, OpenDocument and plain text', async () => {
    const w = await extractFile(file(docx(['Lease of parcel 123-45-6789', 'Rent: $1,500 & utilities']), 'lease.docx'));
    expect(w.kind).toBe('docx');
    expect(w.pages[0]).toBe('Lease of parcel 123-45-6789\nRent: $1,500 & utilities');
    const odt = zipSync({ 'content.xml': strToU8('<office:document-content><text:p>Hello</text:p><text:h>World &amp; more</text:h></office:document-content>') });
    expect((await extractFile(file(odt, 'x.odt'))).pages[0]).toBe('Hello\nWorld & more');
    expect((await extractFile(file(strToU8('Plain  text\n\n\n\nhere'), 'note.txt', 'text/plain'))).pages[0]).toBe('Plain text\n\nhere');
    expect(docxText('<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/><w:t>B</w:t></w:r></w:p>')).toBe('A\tB');
  });

  it('a PDF page by page, and a scanned PDF (no text) as a scan', async () => {
    const p = await extractFile(file(await textPdf(['Page one of parcel 123-45-6789', 'Page two']), 'deal.pdf', 'application/pdf'));
    expect(p.kind).toBe('pdf');
    expect(p.pageCount).toBe(2);
    expect(p.pages[0]).toContain('Page one of parcel 123-45-6789');
    const d = await PDFDocument.create();
    d.addPage([612, 792]).drawImage(await d.embedPng(png()), { x: 50, y: 50, width: 200, height: 150 });
    const scan = await extractFile(file(await d.save(), 'scan.pdf', 'application/pdf'));
    expect(scan.kind).toBe('scan');
    expect(scan.pageCount).toBe(1);
  });

  it('refuses old .doc and unknown files with a clear message', async () => {
    await expect(extractFile(file(new Uint8Array([0xd0, 0xcf, 0x11]), 'old.doc'))).rejects.toThrow(/save it as \.docx or as a PDF/);
    await expect(extractFile(file(new Uint8Array([1, 2, 3]), 'data.bin'))).rejects.toThrow(/can't be recreated/);
  });

  it('what is signed names the file and its fingerprint, then the text or the description', async () => {
    const w = await extractFile(file(docx(['Parcel 123-45-6789']), 'a.docx'));
    const t = fileSignedText(w, '');
    expect(t).toMatch(/^SIGNED FILE: a\.docx\.\nDIGITAL FINGERPRINT \(SHA-256\): [0-9A-F]{64}\.\n\nTEXT OF THE FILE:\nParcel 123-45-6789$/);
  });
});

describe.skipIf(!has('pdftoppm', '-v') || !has('zbarimg') || !has('pdftotext', '-v'))('signed file package', () => {
  for (const kind of ['pdf', 'docx', 'image'] as const) {
    it(`${kind}: cover page, stamped file pages, signatures page; checks from a scan`, async () => {
      const src =
        kind === 'pdf'
          ? await extractFile(file(await textPdf(['Lease of parcel 123-45-6789, page one', 'Page two of the lease']), 'lease.pdf', 'application/pdf'))
          : kind === 'docx'
            ? await extractFile(file(docx(['Lease of parcel 123-45-6789', 'Rent $1,500 per month.']), 'lease.docx'))
            : await extractFile(file(png(), 'photo.png', 'image/png'));
      const description = kind === 'image' ? 'Photo of the signed lease for parcel 123-45-6789, first page, rent $1,500.' : undefined;
      const signed = await signText(key, fileSignedText(src, description ?? ''));
      const pdf = await filePackagePdf({ source: src, description, signatures: signed.signatures, documentId: signed.documentId, codes: signed.codes });
      const dir = mkdtempSync('/tmp/opr-pkg-');
      try {
        writeFileSync(join(dir, 'p.pdf'), pdf);
        const pages = Number(execFileSync('pdfinfo', [join(dir, 'p.pdf')]).toString().match(/Pages:\s+(\d+)/)![1]);
        const filePages = kind === 'pdf' ? 2 : kind === 'image' ? 2 /* image + description */ : 1;
        expect(pages).toBe(1 + filePages + 1);
        const page = (n: number) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), join(dir, 'p.pdf'), '-']).toString().replace(/\s+/g, ' ');
        expect(page(1)).toContain('COVER PAGE');
        for (let i = 1; i <= filePages; i++) expect(page(1 + i)).toContain(`Page ${i} of ${filePages}`);
        expect(page(pages)).toContain('acknowledged before me');
        // The codes on the cover bring back exactly what was signed.
        execFileSync('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', '1', join(dir, 'p.pdf'), join(dir, 'c')]);
        let scanned = '';
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) scanned += execFileSync('zbarimg', ['--quiet', '--raw', join(dir, f)]).toString();
        const r = await verifyScannedText({ scanned, registeredKey: key.toPublic() });
        expect(r.verdict).toBe('good');
        expect(r.signedText).toContain('PARCEL 123-45-6789');
        // The original travels inside, so the next owner can recreate exactly the same package.
        const back = await sourceFromPdf(pdf);
        expect(kind === 'image' ? back.images.length : kind === 'pdf' ? (back.pdf ? 1 : 0) : 0).toBe(kind === 'docx' ? 0 : 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('binary file signature (for third parties)', () => {
  it('verifies the exact file, from the .sig or the PGPSIG1 code, and rejects a changed file', async () => {
    const bytes = new TextEncoder().encode('any file at all');
    const signed = await signDocument(key, bytes);
    const pub = key.toPublic();
    for (const sig of [signed.signature, await binarySignatureFrom(signed.payload), await binarySignatureFrom(signed.armoredSignature)]) {
      const good = await verifyBinaryFile({ signature: sig, document: bytes, keys: [pub] });
      expect(good.verdict).toBe('good');
    }
    const changed = await verifyBinaryFile({ signature: signed.signature, document: new TextEncoder().encode('any file at al1'), keys: [pub] });
    expect(changed.verdict).toBe('bad');
    const { privateArmored } = await generateKeyPair({ name: 'Someone Else', passphrase: 'pw-123456' });
    const other = (await readAnyKey(privateArmored)).toPublic();
    expect((await verifyBinaryFile({ signature: signed.signature, document: bytes, keys: [other] })).verdict).toBe('bad');
  });
});

describe('checked copy', () => {
  it('stamps every page of the checked PDFs and images', async () => {
    const pdf = await textPdf(['page one', 'page two']);
    const png = new PNG({ width: 20, height: 10 });
    png.data.fill(200);
    const out = await checkedCopyPdf({
      files: [
        { name: 'a.pdf', pdf, sha256: 'A'.repeat(64) },
        { name: 'b.png', image: { bytes: PNG.sync.write(png), format: 'png', name: 'b.png' }, sha256: 'B'.repeat(64) },
        { name: 'c.docx', sha256: 'C'.repeat(64) },
      ],
      result: 'good',
      summary: 'every key signed',
      documentId: 'ABCD-1234',
      checkedAt: new Date('2026-11-14T00:00:00Z'),
    });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(4);
    if (has('pdftotext', '-v')) {
      const dir = mkdtempSync(join('/tmp', 'cc-'));
      writeFileSync(join(dir, 'c.pdf'), out);
      const text = execFileSync('pdftotext', [join(dir, 'c.pdf'), '-']).toString();
      rmSync(dir, { recursive: true });
      expect(text).toContain('CHECKED 2026-11-14: GOOD');
      expect(text).toContain('Page 4 of 4');
    }
  });
});
