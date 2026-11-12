// Printable PDFs: the key registration form (Exhibit A), the signature
// verification page for a signed instrument (Exhibit B), and an optional paper
// backup of the private key. All drawing is vector; nothing is rasterized.
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import { bestQr, code128Bits, type QrMatrix } from './codes';
import { formatFingerprint, toBase64, PUBKEY_QR_PREFIX } from './crypto';

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const M = 54; // 0.75 in margins
const CONTENT_W = PAGE_W - 2 * M;

const INK = rgb(0.07, 0.09, 0.12);
const MUTED = rgb(0.36, 0.39, 0.44);
const RULE = rgb(0.78, 0.8, 0.83);
const ACCENT = rgb(0.11, 0.27, 0.53);
const WARN = rgb(0.62, 0.11, 0.11);


interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('Open PGP Registrar');
  doc.setCreator('Open PGP Registrar');
  const fonts: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  return { doc, fonts };
}

/** Standard PDF fonts only cover WinAnsi; replace anything else so drawing never throws. */
export function safeText(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\t/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safeText(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      // Break very long tokens (hashes, base64) by character.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let n = w.length;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

interface TextOpts {
  x?: number;
  size?: number;
  font?: PDFFont;
  color?: RGB;
  width?: number;
  leading?: number;
}

/** Draws wrapped text with its first baseline below `top`; returns the y below the block. */
function text(page: PDFPage, fonts: Fonts, s: string, top: number, o: TextOpts = {}) {
  const size = o.size ?? 10;
  const font = o.font ?? fonts.reg;
  const leading = o.leading ?? size * 1.3;
  const x = o.x ?? M;
  const lines = wrap(s, font, size, o.width ?? CONTENT_W);
  let y = top - size;
  for (const line of lines) {
    page.drawText(line, { x, y, size, font, color: o.color ?? INK });
    y -= leading;
  }
  return y + leading - size * 0.35;
}

function rule(page: PDFPage, y: number, x1 = M, x2 = PAGE_W - M, color = RULE, thickness = 0.75) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

function box(page: PDFPage, x: number, yTop: number, w: number, h: number, color = RULE) {
  page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: color, borderWidth: 0.75 });
}

function checkbox(page: PDFPage, x: number, yBase: number, checked: boolean) {
  page.drawRectangle({ x, y: yBase - 1, width: 9, height: 9, borderColor: INK, borderWidth: 0.8 });
  if (checked) {
    page.drawLine({ start: { x: x + 1.5, y: yBase + 0.5 }, end: { x: x + 7.5, y: yBase + 6.5 }, thickness: 1.2, color: INK });
    page.drawLine({ start: { x: x + 1.5, y: yBase + 6.5 }, end: { x: x + 7.5, y: yBase + 0.5 }, thickness: 1.2, color: INK });
  }
}

/** Draws a QR code with its top-left at (x, yTop), `size` points square. */
function drawQr(page: PDFPage, m: QrMatrix, x: number, yTop: number, size: number) {
  const cell = size / m.size;
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.dark(r, c)) c++;
      // Slight overlap avoids hairline gaps between modules in some viewers.
      page.drawRectangle({ x: x + start * cell, y: yTop - (r + 1) * cell, width: (c - start) * cell + 0.05, height: cell + 0.05, color: rgb(0, 0, 0) });
    }
  }
}

/** Draws a Code 128 barcode; returns its drawn width. */
function drawCode128(page: PDFPage, value: string, x: number, yBottom: number, moduleW: number, height: number) {
  const bits = code128Bits(value);
  let i = 0;
  while (i < bits.length) {
    if (bits[i] !== '1') {
      i++;
      continue;
    }
    const start = i;
    while (i < bits.length && bits[i] === '1') i++;
    page.drawRectangle({ x: x + start * moduleW, y: yBottom, width: (i - start) * moduleW, height, color: rgb(0, 0, 0) });
  }
  return bits.length * moduleW;
}

function footer(page: PDFPage, fonts: Fonts, left: string, pageNo: number, pages: number) {
  rule(page, 44);
  page.drawText(safeText(left), { x: M, y: 32, size: 7.5, font: fonts.reg, color: MUTED });
  const right = `Page ${pageNo} of ${pages}`;
  page.drawText(right, { x: PAGE_W - M - fonts.reg.widthOfTextAtSize(right, 7.5), y: 32, size: 7.5, font: fonts.reg, color: MUTED });
}

function header(page: PDFPage, fonts: Fonts, kicker: string, title: string, subtitle?: string) {
  let y = PAGE_H - M;
  y = text(page, fonts, kicker.toUpperCase(), y, { size: 8, font: fonts.bold, color: ACCENT });
  y = text(page, fonts, title, y - 6, { size: 19, font: fonts.bold });
  if (subtitle) y = text(page, fonts, subtitle, y - 4, { size: 10.5, color: MUTED });
  return y - 10;
}

interface Row {
  label: string;
  value: string;
  mono?: boolean;
}

/** Two-column label/value table. Returns y below the table. */
function table(page: PDFPage, fonts: Fonts, rows: Row[], top: number, width: number, labelW = 128) {
  let y = top;
  rule(page, y, M, M + width);
  for (const row of rows) {
    const vFont = row.mono ? fonts.mono : fonts.reg;
    const vSize = row.mono ? 9.5 : 10;
    const vLines = wrap(row.value || ' ', vFont, vSize, width - labelW - 8);
    const h = Math.max(1, vLines.length) * vSize * 1.3 + 7;
    text(page, fonts, row.label, y - 5, { x: M, size: 8.5, font: fonts.bold, color: MUTED, width: labelW - 6 });
    text(page, fonts, vLines.join('\n'), y - 5, { x: M + labelW, size: vSize, font: vFont, width: width - labelW - 8 });
    y -= h;
    rule(page, y, M, M + width);
  }
  return y;
}

function fingerprintTwoLines(fpr: string) {
  const f = formatFingerprint(fpr);
  const groups = f.split(' ');
  const half = Math.ceil(groups.length / 2);
  return `${groups.slice(0, half).join(' ')}\n${groups.slice(half).join(' ')}`;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isoDateTime(d: Date) {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ---------------------------------------------------------------------------
// Exhibit A: registration form
// ---------------------------------------------------------------------------

export interface RegistrationInfo {
  ownerName: string;
  parcels: string;
  propertyAddress?: string;
  mailingAddress?: string;
  county?: string;
  replacement?: boolean;
  previousFingerprint?: string;
  fingerprint: string;
  algorithm: string;
  created: Date;
  userID: string;
  /** Binary public key, for the compact QR. */
  publicKeyBinary: Uint8Array;
  publicArmored: string;
}

export async function registrationPdf(info: RegistrationInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc('Owner Public Key Registration');
  const fpr = info.fingerprint.toUpperCase();
  const foot = `Owner key registration  |  Fingerprint ${formatFingerprint(fpr)}`;

  // ---- Page 1: the form ----
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = header(
    p,
    fonts,
    'No fee  |  Voluntary',
    'Owner Public Key Registration',
    info.county?.trim() ? `For filing with the Recorder, ${info.county.trim()}` : 'For filing with the County Recorder',
  );

  checkbox(p, M, y - 9, !info.replacement);
  p.drawText('New registration', { x: M + 14, y: y - 9, size: 10, font: fonts.reg, color: INK });
  checkbox(p, M + 130, y - 9, !!info.replacement);
  p.drawText('Replacement (previous key retired)', { x: M + 144, y: y - 9, size: 10, font: fonts.reg, color: INK });
  y -= 24;

  const qrSize = 104;
  const tableW = CONTENT_W - qrSize - 18;
  const rows: Row[] = [
    { label: 'Registration fee', value: '$0.00 (no charge)' },
    { label: 'Owner(s) of record', value: info.ownerName },
    { label: 'Parcel number(s)', value: info.parcels },
    { label: 'Property address', value: info.propertyAddress ?? '' },
    { label: 'Mailing address', value: info.mailingAddress ?? '' },
    { label: 'Key type', value: info.algorithm },
    { label: 'Key created', value: isoDate(info.created) },
    { label: 'Key user ID', value: info.userID },
    { label: 'Key fingerprint', value: fingerprintTwoLines(fpr), mono: true },
  ];
  if (info.replacement) {
    rows.push({
      label: 'Previous key (retire)',
      value: info.previousFingerprint?.trim() ? fingerprintTwoLines(info.previousFingerprint.replace(/\s+/g, '')) : '',
      mono: true,
    });
  }
  const tableTop = y;
  y = table(p, fonts, rows, y, tableW);

  const fprQr = bestQr(fpr)!;
  const qx = PAGE_W - M - qrSize;
  drawQr(p, fprQr, qx, tableTop - 4, qrSize);
  text(p, fonts, 'Scan: key fingerprint', tableTop - qrSize - 10, { x: qx, size: 7.5, color: MUTED, width: qrSize });

  y = text(p, fonts, 'Owner request', y - 12, { size: 10, font: fonts.bold });
  y = text(
    p,
    fonts,
    'I am the owner of record of the parcel(s) listed above. I ask the Recorder to file the attached public key, with the ' +
      'fingerprint shown, against those parcels, and to hold for investigation, rather than record in the ordinary course, any ' +
      'instrument affecting them that does not carry a valid signature from this key.',
    y - 3,
    { size: 9.5 },
  );

  y -= 28;
  rule(p, y, M, M + 330, INK);
  rule(p, y, M + 360, PAGE_W - M, INK);
  text(p, fonts, 'Owner signature', y - 3, { size: 8, color: MUTED });
  text(p, fonts, 'Date', y - 3, { x: M + 360, size: 8, color: MUTED });
  y -= 22;

  y = text(p, fonts, 'Identity verification (both required)', y - 4, { size: 10, font: fonts.bold });
  y -= 6;
  const colW = (CONTENT_W - 14) / 2;
  // Fit the identity boxes to the space left above the callback note and Recorder box.
  const boxH = Math.max(118, Math.min(150, y - 168));
  box(p, M, y, colW, boxH);
  box(p, M + colW + 14, y, colW, boxH);

  const lx = M + 8;
  let ly = text(p, fonts, '1. Notary acknowledgment', y - 8, { x: lx, size: 9, font: fonts.bold });
  ly = text(p, fonts, 'Notarial certificate, signature and seal, in the form required by state law:', ly - 3, {
    x: lx,
    size: 8,
    color: MUTED,
    width: colW - 16,
  });
  const notaryBottom = y - boxH + 26;
  rule(p, notaryBottom, lx, lx + colW - 16, INK);
  text(p, fonts, 'Commission expires', notaryBottom - 3, { x: lx, size: 7.5, color: MUTED });

  const rx = M + colW + 22;
  const rw = colW - 16;
  let ry = text(p, fonts, '2. Law enforcement attestation', y - 8, { x: rx, size: 9, font: fonts.bold });
  ry = text(p, fonts, 'I met the owner in person and checked government photo ID.', ry - 3, { x: rx, size: 8, color: MUTED, width: rw });
  const fieldRows: [string, string][] = [
    ['Officer name', 'Badge no.'],
    ['Agency', 'Agency phone'],
    ['Signature', 'Date'],
  ];
  for (const [a, b] of fieldRows) {
    ry -= 20;
    const split = rx + rw * 0.62;
    rule(p, ry, rx, split - 8, INK);
    rule(p, ry, split, rx + rw, INK);
    text(p, fonts, a, ry - 2, { x: rx, size: 7.5, color: MUTED });
    text(p, fonts, b, ry - 2, { x: split, size: 7.5, color: MUTED });
    ry -= 6;
  }
  y -= boxH + 8;

  y = text(
    p,
    fonts,
    'Callback rule: a notary stamp alone can be forged, so the officer step is also required. Before the key is activated, the Recorder ' +
      "phones the officer's agency at its published number and confirms the officer met the owner and signed. The same two steps and " +
      'callback apply to replacing a lost key.',
    y,
    { size: 8, color: MUTED },
  );

  y -= 8;
  const recH = 52;
  box(p, M, y, CONTENT_W, recH, INK);
  text(p, fonts, 'RECORDER USE ONLY', y - 6, { x: M + 8, size: 7.5, font: fonts.bold, color: MUTED });
  const recFields = ['Callback confirmed by / date', 'Key activated (date)', 'Recording no.'];
  const fw = (CONTENT_W - 16 - 2 * 12) / 3;
  recFields.forEach((label, i) => {
    const fx = M + 8 + i * (fw + 12);
    rule(p, y - recH + 16, fx, fx + fw, INK);
    text(p, fonts, label, y - recH + 13, { x: fx, size: 7, color: MUTED, width: fw });
  });

  // ---- Page 2+: the public key attachment ----
  const attachPages: PDFPage[] = [];
  const p2 = doc.addPage([PAGE_W, PAGE_H]);
  attachPages.push(p2);
  y = header(p2, fonts, 'Attachment to registration', 'Public Key Submitted',
    'This key is public and safe to publish. It lets anyone check a signature but cannot create one. The private key stays with the owner.',
  );
  y = table(
    p2,
    fonts,
    [
      { label: 'Owner(s) of record', value: info.ownerName },
      { label: 'Parcel number(s)', value: info.parcels },
      { label: 'Key fingerprint', value: formatFingerprint(fpr), mono: true },
    ],
    y,
    CONTENT_W,
  );

  const keyQr = bestQr(`${PUBKEY_QR_PREFIX}|${toBase64(info.publicKeyBinary)}`);
  if (keyQr) {
    const s = Math.min(200, Math.max(130, keyQr.size * 2.2));
    drawQr(p2, keyQr, M, y - 14, s);
    text(
      p2,
      fonts,
      'Scan: full public key. Staff can scan this into the verification tool instead of retyping the text below. ' +
        'After scanning, confirm the fingerprint shown by the tool matches the one printed on this form.',
      y - 14,
      { x: M + s + 16, size: 9, color: MUTED, width: CONTENT_W - s - 16 },
    );
    y -= s + 26;
  } else {
    y -= 10;
  }

  let page = p2;
  const monoSize = 8;
  const lead = monoSize * 1.25;
  const lines = info.publicArmored.trim().split(/\r?\n/);
  for (const line of lines) {
    if (y - lead < 60) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      attachPages.push(page);
      y = header(page, fonts, 'Attachment to registration (continued)', 'Public Key Submitted');
    }
    page.drawText(safeText(line), { x: M, y: y - monoSize, size: monoSize, font: fonts.mono, color: INK });
    y -= lead;
  }

  const total = doc.getPageCount();
  doc.getPages().forEach((pg, i) => footer(pg, fonts, foot, i + 1, total));
  return doc.save();
}

// ---------------------------------------------------------------------------
// Exhibit B: signature verification page
// ---------------------------------------------------------------------------

export interface SignaturePageInfo {
  documentTitle?: string;
  fileName: string;
  fileSize: number;
  parcels?: string;
  userID: string;
  fingerprint: string;
  signedAt: Date;
  sha256: string;
  documentId: string;
  payload: string;
}

function humanSize(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB (${n.toLocaleString('en-US')} bytes)`;
  return `${(n / 1024 / 1024).toFixed(2)} MB (${n.toLocaleString('en-US')} bytes)`;
}

async function drawSignaturePage(doc: PDFDocument, fonts: Fonts, info: SignaturePageInfo) {
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = header(
    p,
    fonts,
    'Signature verification page',
    info.documentTitle?.trim() || 'Signed Instrument',
    'Attach this page to the instrument it describes.',
  );

  const rows: Row[] = [
    { label: 'Signed file', value: info.fileName },
    { label: 'File size', value: humanSize(info.fileSize) },
  ];
  if (info.parcels?.trim()) rows.push({ label: 'Parcel number(s)', value: info.parcels.trim() });
  rows.push(
    { label: 'Signed by', value: info.userID },
    { label: 'Signing key fingerprint', value: fingerprintTwoLines(info.fingerprint), mono: true },
    { label: 'Signed at', value: isoDateTime(info.signedAt) },
    { label: 'Document hash (SHA-256)', value: `${info.sha256.slice(0, 32)}\n${info.sha256.slice(32)}`, mono: true },
  );
  y = table(p, fonts, rows, y, CONTENT_W, 150);

  y -= 18;
  const qr = bestQr(info.payload)!;
  const qrSize = 190;
  drawQr(p, qr, M, y, qrSize);
  text(p, fonts, 'Scan: carries the actual signature', y - qrSize - 6, { x: M, size: 8, font: fonts.bold, color: MUTED, width: qrSize });

  const rx = M + qrSize + 30;
  const rw = PAGE_W - M - rx;
  let ry = text(p, fonts, 'DOCUMENT ID', y, { x: rx, size: 8, font: fonts.bold, color: MUTED });
  const moduleW = Math.min(1.0, rw / (code128Bits(info.documentId).length + 20));
  const bw = drawCode128(p, info.documentId, rx + 10 * moduleW, ry - 58, moduleW, 50);
  ry -= 62;
  const idW = fonts.mono.widthOfTextAtSize(info.documentId, 10);
  p.drawText(info.documentId, { x: rx + 10 * moduleW + (bw - idW) / 2, y: ry - 10, size: 10, font: fonts.mono, color: INK });
  ry -= 22;
  ry = text(p, fonts, 'First 24 hex digits of the document hash, for the filing record.', ry, { x: rx, size: 8, color: MUTED, width: rw });

  ry = text(p, fonts, 'How the Recorder checks it', ry - 14, { x: rx, size: 9.5, font: fonts.bold, width: rw });
  ry = text(
    p,
    fonts,
    'Scan the QR code. The tool reads the key fingerprint, document hash and signature, compares the fingerprint with the key ' +
      'registered for the parcel, recomputes the hash of the signed file, and checks the signature. A match is recorded as usual. ' +
      'A missing or failing signature on a registered parcel is held for investigation.',
    ry - 3,
    { x: rx, size: 8.5, width: rw },
  );

  y = Math.min(y - qrSize - 24, ry) - 16;
  rule(p, y);
  y = text(p, fonts, 'Manual check with GnuPG (no special software needed)', y - 8, { size: 9.5, font: fonts.bold });
  y = text(
    p,
    fonts,
    'The QR code text is PGPSIG1|fingerprint|sha256|signature. The last field is a standard detached OpenPGP signature in base64. ' +
      'Save it as document.sig (for example: base64 -d > document.sig), import the registered public key, then run: ' +
      'gpg --verify document.sig "' +
      info.fileName +
      '". Changing any byte of the file breaks the signature.',
    y - 3,
    { size: 8.5, color: MUTED },
  );
  y = text(p, fonts, 'Code text (for manual entry if the code cannot be scanned):', y - 8, { size: 8, font: fonts.bold, color: MUTED });
  text(p, fonts, info.payload, y - 2, { size: 7.5, font: fonts.mono, leading: 9.5 });
  return p;
}

export async function signaturePagePdf(info: SignaturePageInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(`Signature verification page - ${info.documentId}`);
  const p = await drawSignaturePage(doc, fonts, info);
  footer(p, fonts, `Signature verification page  |  Document ID ${info.documentId}`, 1, 1);
  return doc.save();
}

/**
 * Print copy: the original PDF with the verification page appended. This is a
 * new file for printing; the signature covers the original file, not this one.
 */
export async function printCopyPdf(original: Uint8Array, info: SignaturePageInfo): Promise<Uint8Array> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(original);
  } catch (e) {
    const msg = String((e as Error).message || e);
    throw new Error(
      /encrypt/i.test(msg)
        ? 'This PDF is password-protected or encrypted, so a combined print copy cannot be made. Print the verification page separately.'
        : 'This PDF could not be read, so a combined print copy cannot be made. Print the verification page separately.',
    );
  }
  const { doc, fonts } = await newDoc(`${info.documentTitle?.trim() || info.fileName} (with signature page)`);
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((pg) => doc.addPage(pg));
  const sp = await drawSignaturePage(doc, fonts, info);
  footer(sp, fonts, `Signature verification page  |  Document ID ${info.documentId}`, doc.getPageCount(), doc.getPageCount());
  return doc.save();
}

// ---------------------------------------------------------------------------
// Private key paper backup
// ---------------------------------------------------------------------------

export interface BackupInfo {
  fingerprint: string;
  userID: string;
  created: Date;
  protectedByPassphrase: boolean;
  privateArmored: string;
}

export async function privateKeyBackupPdf(info: BackupInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc('Private key paper backup');
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = header(p, fonts, 'Keep secret  |  Do not file', 'Private Key Paper Backup', 'Store this page somewhere safe, such as a home safe or safe deposit box.');
  y = text(
    p,
    fonts,
    info.protectedByPassphrase
      ? 'This key is protected by a passphrase, which is NOT printed here. Store the passphrase separately. Without it this backup cannot be used.'
      : 'WARNING: this key has no passphrase. Anyone who gets this page can sign documents as you.',
    y,
    { size: 10, font: fonts.bold, color: WARN },
  );
  y = table(
    p,
    fonts,
    [
      { label: 'Key user ID', value: info.userID },
      { label: 'Key fingerprint', value: formatFingerprint(info.fingerprint), mono: true },
      { label: 'Key created', value: isoDate(info.created) },
    ],
    y - 10,
    CONTENT_W,
  );
  const qr = bestQr(info.privateArmored.trim());
  if (qr) {
    const s = 180;
    drawQr(p, qr, M, y - 14, s);
    text(
      p,
      fonts,
      'To restore: scan this code with a phone or type the text below into a file named key.asc. Then load it in this tool, ' +
        'or run gpg --import key.asc.',
      y - 14,
      { x: M + s + 16, size: 9, color: MUTED, width: CONTENT_W - s - 16 },
    );
    y -= s + 24;
  } else {
    y = text(p, fonts, 'To restore: type the text below into a file named key.asc, then load it in this tool or run gpg --import key.asc.', y - 12, {
      size: 9,
      color: MUTED,
    });
    y -= 8;
  }
  let page = p;
  for (const line of info.privateArmored.trim().split(/\r?\n/)) {
    if (y < 64) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = header(page, fonts, 'Keep secret  |  Do not file', 'Private Key Paper Backup (continued)');
    }
    page.drawText(safeText(line), { x: M, y: y - 8, size: 8, font: fonts.mono, color: INK });
    y -= 10;
  }
  const total = doc.getPageCount();
  doc.getPages().forEach((pg, i) => footer(pg, fonts, `PRIVATE KEY - KEEP SECRET  |  ${formatFingerprint(info.fingerprint)}`, i + 1, total));
  return doc.save();
}
