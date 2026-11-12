// Printable PDFs: the key registration form (Exhibit A), the signature
// verification page for a signed instrument (Exhibit B), and an optional paper
// backup of the private key. All drawing is vector; nothing is rasterized.
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFHexString,
  PDFRawStream,
  PDFImage,
  decodePDFRawStream,
  type RGB,
} from 'pdf-lib';
import { bestQr, code128Bits, type QrMatrix } from './codes';
import { formatFingerprint, toBase64, PUBKEY_QR_PREFIX, encodeKeyCodes, readAnyKey, encodeRegistrationCodes, type Registration } from './crypto';
import type * as openpgp from 'openpgp';
import { safeText } from './text';
import { BRAND, brandLine } from './brand';

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
  /** Program seal/logo, when one has been provided. */
  seal?: PDFImage;
}

/**
 * The seal image comes from the website (embedded in index.html), so there is
 * one copy to update. Set once at startup with setBrandSeal().
 */
let sealBytes: Uint8Array | null = null;
export function setBrandSeal(bytes: Uint8Array | null) {
  sealBytes = bytes;
}

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer(BRAND.name);
  doc.setCreator(BRAND.name);
  doc.setSubject(`${BRAND.name} (${BRAND.expansion})`);
  const fonts: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  if (sealBytes) {
    try {
      const isPng = sealBytes[0] === 0x89 && sealBytes[1] === 0x50;
      fonts.seal = isPng ? await doc.embedPng(sealBytes) : await doc.embedJpg(sealBytes);
    } catch {
      /* unreadable image: PDFs are still made, without the seal */
    }
  }
  return { doc, fonts };
}

export { safeText };

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
  rule(page, 46);
  page.drawText(safeText(left), { x: M, y: 35, size: 7.5, font: fonts.reg, color: MUTED });
  const right = `Page ${pageNo} of ${pages}`;
  page.drawText(right, { x: PAGE_W - M - fonts.reg.widthOfTextAtSize(right, 7.5), y: 35, size: 7.5, font: fonts.reg, color: MUTED });
  // Program line: name, web address, and the "proposed" notice while it applies.
  const brand = wrap(brandLine(), fonts.reg, 6.5, CONTENT_W)[0];
  page.drawText(brand, { x: M, y: 25, size: 6.5, font: fonts.reg, color: BRAND.status === 'proposed' ? WARN : MUTED });
}

/** Seal at the top-right corner of a page. Returns the width it takes. */
function sealCorner(page: PDFPage, fonts: Fonts, size = 58) {
  if (!fonts.seal) return 0;
  page.drawImage(fonts.seal, { x: PAGE_W - M - size, y: PAGE_H - M - size + 10, width: size, height: size });
  return size + 12;
}

function header(page: PDFPage, fonts: Fonts, kicker: string, title: string, subtitle?: string) {
  const width = CONTENT_W - sealCorner(page, fonts);
  let y = PAGE_H - M;
  y = text(page, fonts, `${BRAND.name}  |  ${kicker}`.toUpperCase(), y, { size: 8, font: fonts.bold, color: ACCENT, width });
  y = text(page, fonts, title, y - 6, { size: 19, font: fonts.bold, width });
  if (subtitle) y = text(page, fonts, subtitle, y - 4, { size: 10.5, color: MUTED, width });
  return Math.min(y - 10, fonts.seal ? PAGE_H - M - 58 : y - 10);
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
  /** One or more parcel numbers (one per line, or separated by commas). One form is made per parcel. */
  parcels: string;
  /** The other owners' public keys for these parcels. Every key listed must sign. */
  coOwnerKeys?: openpgp.PublicKey[];
  /** Optional free description per key, by fingerprint (e.g. "Trustee", "Beneficiary"). */
  keyLabels?: Record<string, string>;
  /**
   * Everyone who signs this registration (e.g. both spouses sharing one key, or a
   * company's officers), each with an optional capacity: "Jane Doe, Trustee".
   * Each gets a signature line, notary box and officer box. Defaults to the owner.
   */
  signatories?: string[];
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

/** Splits "123-45-6789, 123-45-6790" or one-per-line input into parcel numbers. */
export function splitParcels(s: string) {
  const list = s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : [''];
}

export const REGISTRATION_ATTACHMENT = 'stop-registration';

/**
 * Registration forms: one complete form per parcel. Each lists every key
 * registered for the parcel (this owner's and the co-owners'), all of which
 * must sign. The key list is printed as codes and embedded as JSON, so the
 * signing and checking tools can load it from the PDF, a scan or a photo.
 */
export async function registrationPdf(info: RegistrationInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc('Owner Public Key Registration');
  const fpr = info.fingerprint.toUpperCase();
  const me = (await readAnyKey(info.publicArmored)).toPublic();
  const others = (info.coOwnerKeys ?? []).filter((k) => k.getFingerprint().toUpperCase() !== fpr);
  const keys = [me, ...others];
  const labels = keys.map((k) => (info.keyLabels?.[k.getFingerprint().toUpperCase()] ?? '').trim());
  // The Recorder's tool can read the key straight from this PDF.
  await doc.attach(new TextEncoder().encode(info.publicArmored), PUBLIC_KEY_ATTACHMENT, {
    mimeType: 'application/pgp-keys',
    description: 'OpenPGP public key being registered',
    creationDate: info.created,
  });
  const parcels = splitParcels(info.parcels);
  const footers: string[] = [];
  for (const [n, parcel] of parcels.entries()) {
    const json = {
      format: 'stop-registration-1',
      parcel,
      required: 'all',
      registrant: fpr,
      keys: keys.map((k) => k.armor()),
      labels,
    };
    await doc.attach(new TextEncoder().encode(JSON.stringify(json, null, 1)), `${REGISTRATION_ATTACHMENT}-${n + 1}.json`, {
      mimeType: 'application/json',
      description: `Keys registered for parcel ${parcel}`,
      creationDate: info.created,
    });
    const before = doc.getPageCount();
    await drawRegistration(doc, fonts, info, parcel, keys, labels);
    const label = `Registration for parcel ${parcel || '(not given)'}  |  Registrant ${formatFingerprint(fpr)}`;
    for (let i = before; i < doc.getPageCount(); i++) footers[i] = label;
  }
  const total = doc.getPageCount();
  doc.getPages().forEach((pg, i) => footer(pg, fonts, footers[i] ?? '', i + 1, total));
  return doc.save();
}

function signatoriesOf(info: RegistrationInfo) {
  const list = (info.signatories ?? []).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : [info.ownerName.trim()];
}

/** Signature line, notary and officer boxes, callback rule and a Recorder box, starting at y. */
function signAndVerify(p: PDFPage, fonts: Fonts, y: number, signer: string, tag: string, recFields: string[]) {
  rule(p, y, M, M + 330, INK);
  rule(p, y, M + 360, PAGE_W - M, INK);
  text(p, fonts, `Signature of ${signer || 'owner'}${tag ? `  (${tag})` : ''}`, y - 3, { size: 8, color: MUTED, width: 330 });
  text(p, fonts, 'Date', y - 3, { x: M + 360, size: 8, color: MUTED });
  y -= 22;

  y = text(p, fonts, `Identity verification of ${signer || 'the signer'} (both required)`, y - 4, { size: 10, font: fonts.bold });
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
  ry = text(p, fonts, 'I met this signer in person and checked government photo ID.', ry - 3, { x: rx, size: 8, color: MUTED, width: rw });
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
      "phones the officer's agency at its published number and confirms the officer met this signer and signed. The same two steps and " +
      'callback apply to replacing a lost key.',
    y,
    { size: 8, color: MUTED },
  );

  y -= 8;
  const recH = 52;
  box(p, M, y, CONTENT_W, recH, INK);
  text(p, fonts, 'RECORDER USE ONLY', y - 6, { x: M + 8, size: 7.5, font: fonts.bold, color: MUTED });
  const fw = (CONTENT_W - 16 - (recFields.length - 1) * 12) / recFields.length;
  recFields.forEach((label, i) => {
    const fx = M + 8 + i * (fw + 12);
    rule(p, y - recH + 16, fx, fx + fw, INK);
    text(p, fonts, label, y - recH + 13, { x: fx, size: 7, color: MUTED, width: fw });
  });
}

async function drawRegistration(doc: PDFDocument, fonts: Fonts, info: RegistrationInfo, parcel: string, keys: openpgp.PublicKey[], labels: string[]) {
  const fpr = info.fingerprint.toUpperCase();
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
    { label: 'Parcel number', value: parcel },
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
    (signatoriesOf(info).length > 1
      ? `We, the undersigned, are owners of record of the parcel above, or sign for one in the capacity shown. We ask the Recorder to file the public key with the fingerprint shown, `
      : `I am an owner of record of the parcel above, or sign for one in the capacity shown. I ask the Recorder to file the public key with the fingerprint shown, `) +
      `${keys.length > 1 ? `and the ${keys.length - 1} other key${keys.length > 2 ? 's' : ''} listed on the key page ` : '(listed on the key page) '}against this parcel, and to hold for investigation, rather than record in the ` +
      'ordinary course, any instrument affecting it that does not carry a valid signature from every key listed.',
    y - 3,
    { size: 9.5 },
  );

  const signers = signatoriesOf(info);
  signAndVerify(p, fonts, y - 28, signers[0], signers.length > 1 ? `Signer 1 of ${signers.length}` : '', [
    'Callback confirmed by / date',
    'Key activated (date)',
    'Recording no.',
  ]);

  // ---- One page per additional person signing this registration ----
  for (let i = 1; i < signers.length; i++) {
    const sp = doc.addPage([PAGE_W, PAGE_H]);
    let sy = header(
      sp,
      fonts,
      'Registration (continued)',
      `Additional Signer ${i + 1} of ${signers.length}`,
      'Each person signing this registration signs here, before a notary, and has their identity confirmed by an officer.',
    );
    sy = table(
      sp,
      fonts,
      [
        { label: 'Parcel number', value: parcel },
        { label: 'Key fingerprint', value: fingerprintTwoLines(fpr), mono: true },
        { label: 'Signer', value: signers[i] || '' },
      ],
      sy,
      CONTENT_W,
    );
    sy = text(
      sp,
      fonts,
      'I join in the owner request on page 1 of this registration for the parcel and key shown above, in the capacity stated.',
      sy - 10,
      { size: 9.5 },
    );
    signAndVerify(sp, fonts, sy - 28, signers[i], `Signer ${i + 1} of ${signers.length}`, ['Callback confirmed by / date', 'Signer verified (initials)']);
  }

  // ---- Page 2+: the parcel's keys ----
  let page = doc.addPage([PAGE_W, PAGE_H]);
  y = header(
    page,
    fonts,
    'Attachment to registration',
    'Keys Registered for This Parcel',
    'Every key listed must sign any instrument affecting the parcel. The owners chose how many keys to use and how to describe them. Public keys are safe to publish: they check signatures but cannot create them.',
  );
  const keyRows: Row[] = [{ label: 'Parcel number', value: parcel }];
  keys.forEach((k, i) => {
    const kf = k.getFingerprint().toUpperCase();
    keyRows.push({
      label: `Key ${i + 1}${kf === fpr ? ' (this registrant)' : ''}`,
      value: `${labels[i] ? `${labels[i]}: ` : ''}${k.getUserIDs()[0] ?? ''}\n${formatFingerprint(kf)}`,
    });
  });
  y = table(page, fonts, keyRows, y, CONTENT_W, 150);

  // Codes: this registrant's key, and the parcel's whole key list.
  const ensure = (h: number) => {
    if (y - h < 64) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = header(page, fonts, 'Attachment to registration (continued)', 'Keys Registered for This Parcel');
    }
  };
  const regCodes = await encodeRegistrationCodes({ parcel, keys, labels });
  const size = 120;
  const perRow = 3;
  const gap = (CONTENT_W - perRow * size) / (perRow - 1);
  ensure(size + 60);
  y = text(
    page,
    fonts,
    'Scan: the codes below carry this parcel\u2019s complete key list, for the signing and checking tools. Staff can scan them, or ' +
      'load a scan or photo of this page, instead of retyping. Confirm the fingerprints the tool shows match the ones printed above.',
    y - 12,
    { size: 8.5, color: MUTED },
  );
  y -= 12;
  const all = [
    ...regCodes.map((c, i) => ({ code: c, label: `Parcel key list ${i + 1} of ${regCodes.length}` })),
    { code: `${PUBKEY_QR_PREFIX}|${toBase64(info.publicKeyBinary)}`, label: 'This registrant\u2019s key' },
  ];
  all.forEach(({ code, label }, i) => {
    const col = i % perRow;
    if (col === 0) ensure(size + 24);
    const x = M + col * (size + gap);
    const qr = bestQr(code);
    if (qr) drawQr(page, qr, x, y, size);
    page.drawText(label, { x: x + (size - fonts.bold.widthOfTextAtSize(label, 8)) / 2, y: y - size - 12, size: 8, font: fonts.bold, color: MUTED });
    if (col === perRow - 1 || i === all.length - 1) y -= size + 50;
  });

  // This registrant's key as text.
  ensure(40);
  y = text(page, fonts, 'This registrant\u2019s public key', y + 10, { size: 9, font: fonts.bold });
  const monoSize = 8;
  const lead = monoSize * 1.25;
  for (const line of info.publicArmored.trim().split(/\r?\n/)) {
    ensure(lead);
    page.drawText(safeText(line), { x: M, y: y - monoSize, size: monoSize, font: fonts.mono, color: INK });
    y -= lead;
  }
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
// Private key PDF
// ---------------------------------------------------------------------------

export interface PrivateKeyInfo {
  fingerprint: string;
  userID: string;
  created: Date;
  protectedByPassphrase: boolean;
  privateArmored: string;
}

export const PRIVATE_KEY_ATTACHMENT = 'private-key.asc';
export const PUBLIC_KEY_ATTACHMENT = 'public-key.asc';

/**
 * The owner's private key as a PDF: printable (QR code and text) and loadable,
 * because the key file is embedded in the PDF as an attachment.
 */
export async function privateKeyPdf(info: PrivateKeyInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc('Private key - keep secret');
  await doc.attach(new TextEncoder().encode(info.privateArmored), PRIVATE_KEY_ATTACHMENT, {
    mimeType: 'application/pgp-keys',
    description: 'OpenPGP private key (passphrase-protected)',
    creationDate: info.created,
  });
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = header(
    p,
    fonts,
    'Keep secret  |  Do not file',
    'Your Private Signing Key',
    'Keep this PDF (and a printed copy) somewhere safe, such as a USB drive and a home safe. You need it to sign documents.',
  );
  y = text(
    p,
    fonts,
    info.protectedByPassphrase
      ? 'This key is locked with your passphrase, which is NOT in this PDF. Store the passphrase separately. Without it the key cannot be used.'
      : 'WARNING: this key has no passphrase. Anyone who gets this PDF or page can sign documents as you.',
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
  const how =
    `To sign later: open the ${BRAND.name} website (${BRAND.projectUrl}), choose "Use a key I already have", and pick ` +
    'this PDF (the key file is embedded in it). From the printed page: choose the same option on a phone and take a ' +
    'photo of this page, or scan it. GnuPG users can type the text below into key.asc and run gpg --import key.asc.';
  y = text(p, fonts, how, y - 12, { size: 9, color: MUTED });
  // The key as small QR codes, which read reliably from photos and scans.
  const codes = await encodeKeyCodes(await readAnyKey(info.privateArmored));
  // Big codes, two per row with a wide gap, so phone photos read them easily.
  // Large RSA keys need many codes; they wrap onto new pages.
  const size = 190;
  const perRow = 2;
  const gap = (CONTENT_W - perRow * size) / (perRow - 1);
  let page = p;
  y -= 14;
  codes.forEach((code, i) => {
    const col = i % perRow;
    if (col === 0 && y - size - 20 < 64) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = header(page, fonts, 'Keep secret  |  Do not file', 'Your Private Signing Key (continued)');
    }
    const x = M + col * (size + gap);
    drawQr(page, bestQr(code)!, x, y, size);
    const label = `Key code ${i + 1} of ${codes.length}`;
    page.drawText(label, { x: x + (size - fonts.bold.widthOfTextAtSize(label, 8.5)) / 2, y: y - size - 12, size: 8.5, font: fonts.bold, color: MUTED });
    if (col === perRow - 1 || i === codes.length - 1) y -= size + 50;
  });
  for (const line of info.privateArmored.trim().split(/\r?\n/)) {
    if (y < 64) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = header(page, fonts, 'Keep secret  |  Do not file', 'Your Private Signing Key (continued)');
    }
    page.drawText(safeText(line), { x: M, y: y - 8, size: 8, font: fonts.mono, color: INK });
    y -= 10;
  }
  const total = doc.getPageCount();
  doc.getPages().forEach((pg, i) => footer(pg, fonts, `PRIVATE KEY - KEEP SECRET  |  ${formatFingerprint(info.fingerprint)}`, i + 1, total));
  return doc.save();
}

// ---------------------------------------------------------------------------
// Reading keys back out of PDFs made by this tool
// ---------------------------------------------------------------------------

export function isPdfBytes(bytes: Uint8Array) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/** Lists files embedded in a PDF (the standard EmbeddedFiles name tree). */
export async function pdfAttachments(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: { name: string; data: Uint8Array }[] = [];
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 8) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        try {
          const n = names.lookup(i) as PDFString | PDFHexString;
          const spec = names.lookup(i + 1, PDFDict);
          const ef = spec.lookup(PDFName.of('EF'), PDFDict);
          const stream = ef.lookup(PDFName.of('F')) as PDFRawStream;
          out.push({ name: n.decodeText(), data: decodePDFRawStream(stream).decode() });
        } catch {
          /* skip malformed entries */
        }
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict), depth + 1);
  };
  const namesDict = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  walk(namesDict?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), 0);
  return out;
}

/**
 * Finds an OpenPGP key embedded in a PDF made by this tool: the private key PDF
 * or the registration form (which carries the public key). Prefers a private key.
 */
export async function keyTextFromPdf(bytes: Uint8Array): Promise<string> {
  let files: { name: string; data: Uint8Array }[];
  try {
    files = await pdfAttachments(bytes);
  } catch {
    throw new Error('That PDF could not be read.');
  }
  // Only the key files themselves (the registration JSON also contains co-owners' keys).
  const keyFiles = files.filter((f) => /\.(asc|gpg|key)$/i.test(f.name));
  const texts = (keyFiles.length ? keyFiles : files).map((f) => new TextDecoder().decode(f.data));
  const priv = texts.find((t) => t.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----'));
  const pub = texts.find((t) => t.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----'));
  const found = priv ?? pub;
  if (!found) {
    throw new Error(
      'No key found in that PDF. Use the private key PDF or the registration form PDF made by this tool. ' +
        'A scanned paper copy has no key file inside; scan its QR code with a phone and paste the text instead.',
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Signed instrument (paper workflow): the document text, signature lines,
// notary block, and a final page of QR codes that carry the signed text and
// the owner's signature.
// ---------------------------------------------------------------------------

export interface InstrumentInfo {
  title: string;
  /** The document text exactly as entered (line breaks kept for printing). */
  text: string;
  /** "When recorded, mail to" block. */
  returnTo?: string;
  /** Names for the wet-ink signature lines, one per line. */
  signers?: string;
  /** Every digital signature so far (or use fingerprint/userID/signedAt for a single signer). */
  signatures?: { fingerprint: string; userID: string; signedAt: Date }[];
  fingerprint?: string;
  userID?: string;
  signedAt?: Date;
  documentId: string;
  codes: string[];
  /** The parcel's registered keys, when known: shows who still has to sign. */
  required?: { parcel: string; keys: { fingerprint: string; userID: string; label?: string }[] };
  /** Embedded so the next owner can load this PDF and sign exactly the same text. */
  draft?: DocumentDraft;
}

/** What a signed-document PDF carries so other owners can add their signatures. */
export interface DocumentDraft {
  format: 'stop-document-1';
  title: string;
  text: string;
  returnTo: string;
  signers: string;
  /** Base64 of each owner's detached signature, in signing order. */
  signatures: { fingerprint: string; userID: string; signedAt: string; sig: string }[];
  /** The parcel's registration, when one was loaded. */
  registration?: { parcel: string; keys: string[]; labels?: string[] };
}

export const DOCUMENT_ATTACHMENT = 'stop-document.json';

export async function instrumentPdf(info: InstrumentInfo): Promise<Uint8Array> {
  const title = info.title.trim();
  const { doc, fonts } = await newDoc(title || 'Signed instrument');
  if (info.draft) {
    await doc.attach(new TextEncoder().encode(JSON.stringify(info.draft)), DOCUMENT_ATTACHMENT, {
      mimeType: 'application/json',
      description: 'Document text and owner signatures, so other owners can add theirs',
    });
  }
  const sigs = info.signatures ?? [{ fingerprint: info.fingerprint ?? '', userID: info.userID ?? '', signedAt: info.signedAt ?? new Date() }];
  const bodySize = 11;
  const lead = 15.5;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  const contentPages: PDFPage[] = [page];
  const BOTTOM = 64;

  // Recording area: the top 2 inches of page 1 stay clear for the Recorder.
  const recTop = PAGE_H - 36;
  if (info.returnTo?.trim()) {
    let ry = text(page, fonts, 'When recorded, mail to:', recTop, { size: 8.5, font: fonts.bold, color: MUTED, width: 250 });
    text(page, fonts, info.returnTo.trim(), ry - 2, { size: 9.5, width: 250, leading: 12 });
  }
  const recLabel = 'Space above this line for Recorder’s use';
  rule(page, PAGE_H - 144, M, PAGE_W - M, RULE);
  page.drawText(recLabel, { x: PAGE_W - M - fonts.reg.widthOfTextAtSize(recLabel, 7), y: PAGE_H - 152, size: 7, font: fonts.reg, color: MUTED });

  let y = PAGE_H - 170;
  if (title) {
    const tw = fonts.bold.widthOfTextAtSize(safeText(title.toUpperCase()), 15);
    page.drawText(safeText(title.toUpperCase()), { x: (PAGE_W - tw) / 2, y: y - 15, size: 15, font: fonts.bold, color: INK });
    y -= 36;
  }

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    contentPages.push(page);
    y = PAGE_H - M;
  };
  const ensure = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };

  for (const line of wrap(info.text.replace(/\s+$/, ''), fonts.reg, bodySize, CONTENT_W)) {
    ensure(lead);
    if (line) page.drawText(line, { x: M, y: y - bodySize, size: bodySize, font: fonts.reg, color: INK });
    y -= line ? lead : lead * 0.7;
  }

  // Wet-ink signature lines.
  const signers = (info.signers ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!signers.length) signers.push('');
  y -= 12;
  for (const name of signers) {
    ensure(52);
    y -= 32;
    rule(page, y, M, M + 300, INK);
    rule(page, y, M + 330, PAGE_W - M, INK);
    text(page, fonts, name ? `${name}` : 'Signature', y - 3, { size: 9, color: MUTED, width: 300 });
    text(page, fonts, 'Date', y - 3, { x: M + 330, size: 9, color: MUTED });
    y -= 20;
  }

  // Notary acknowledgments (completed by notaries on paper; not part of the signed text).
  // One per signer, since owners may sign at different times before different notaries.
  const ackFor = signers.filter(Boolean).length ? signers.filter(Boolean) : [''];
  for (const who of ackFor) {
    ensure(150);
    y -= 16;
    const venue: [string, string][] = [
      ['STATE OF ARIZONA', ')'],
      ['', ') ss.'],
      ['COUNTY OF ______________________', ')'],
    ];
    for (const [left, right] of venue) {
      if (left) page.drawText(left, { x: M, y: y - 10, size: 10, font: fonts.reg, color: INK });
      page.drawText(right, { x: M + 200, y: y - 10, size: 10, font: fonts.reg, color: INK });
      y -= 13;
    }
    y = text(
      page,
      fonts,
      'The foregoing instrument was acknowledged before me this ______ day of ____________________, 20____, by ' +
        (who ? `${who}.` : '______________________________________________________.'),
      y - 8,
      { size: 10, width: CONTENT_W },
    );
    y -= 34;
    rule(page, y, M, M + 260, INK);
    rule(page, y, M + 330, PAGE_W - M, INK);
    text(page, fonts, 'Notary Public', y - 3, { size: 9, color: MUTED });
    text(page, fonts, 'My commission expires', y - 3, { x: M + 330, size: 9, color: MUTED });
    text(page, fonts, '(Seal)', y - 20, { size: 9, color: MUTED });
    y -= 30;
  }

  // ---- Signature page(s): QR codes ----
  let sp = doc.addPage([PAGE_W, PAGE_H]);
  const sigPages = [sp];
  y = header(
    sp,
    fonts,
    'OpenPGP signature page',
    sigs.length > 1 ? 'Owners’ Digital Signatures' : 'Owner’s Digital Signature',
    `For: ${title || 'the instrument on the preceding pages'}`,
  );

  // Status against the parcel's registered keys: complete, or who still has to sign.
  if (info.required?.keys.length) {
    const signed = new Set(sigs.map((x) => x.fingerprint.toUpperCase()));
    const missing = info.required.keys.filter((k) => !signed.has(k.fingerprint.toUpperCase()));
    const done = missing.length === 0;
    const msg = done
      ? `COMPLETE: signed by all ${info.required.keys.length} key${info.required.keys.length > 1 ? 's' : ''} registered for parcel ${info.required.parcel}.`
      : `NOT COMPLETE: ${info.required.keys.length - missing.length} of ${info.required.keys.length} registered keys have signed. Still needed: ` +
        missing.map((k) => `${k.label ? `${k.label}: ` : ''}${k.userID || 'owner'} (${k.fingerprint.slice(-16)})`).join(', ') +
        '. Do not file until every owner has signed.';
    const lines = wrap(msg, fonts.bold, 9.5, CONTENT_W - 20);
    const h = lines.length * 12.5 + 14;
    sp.drawRectangle({
      x: M,
      y: y - h,
      width: CONTENT_W,
      height: h,
      color: done ? rgb(0.9, 0.96, 0.92) : rgb(0.98, 0.91, 0.91),
      borderColor: done ? rgb(0.08, 0.42, 0.18) : WARN,
      borderWidth: 1,
    });
    lines.forEach((l, i) => sp.drawText(l, { x: M + 10, y: y - 16 - i * 12.5, size: 9.5, font: fonts.bold, color: done ? rgb(0.08, 0.42, 0.18) : WARN }));
    y -= h + 10;
  }

  const tableTop = y;
  const roleOf = (f: string) => info.required?.keys.find((k) => k.fingerprint.toUpperCase() === f.toUpperCase())?.label ?? '';
  const rows: Row[] = sigs.map((x, i) => ({
    label: sigs.length > 1 ? `Signer ${i + 1}` : 'Signed by',
    value: `${roleOf(x.fingerprint) ? `${roleOf(x.fingerprint)}: ` : ''}${x.userID || '(name not given)'}\n${formatFingerprint(x.fingerprint)}\n${isoDateTime(x.signedAt)}`,
  }));
  rows.push({ label: 'Document ID', value: info.documentId, mono: true });
  y = table(sp, fonts, rows, tableTop, CONTENT_W - 190, 110);
  // Document ID barcode beside the table.
  const bx = PAGE_W - M - 175;
  const moduleW = Math.min(0.8, 175 / (code128Bits(info.documentId).length + 20));
  const bw = drawCode128(sp, info.documentId, bx + 10 * moduleW, tableTop - 58, moduleW, 50);
  const idW = fonts.mono.widthOfTextAtSize(info.documentId, 8);
  sp.drawText(info.documentId, { x: bx + 10 * moduleW + (bw - idW) / 2, y: tableTop - 70, size: 8, font: fonts.mono, color: INK });

  y = text(
    sp,
    fonts,
    `The digital signature${sigs.length > 1 ? 's are' : ' is'} an extra layer. ${sigs.length > 1 ? 'They do' : 'It does'} not replace the ink ` +
      `signatures or the notary acknowledgment on the document, which are still required. ` +
      `To check: open the ${BRAND.name} website (${BRAND.projectUrl}), go to "Check a filing", load the key registered for the parcel, and scan ` +
      `every code below, in any order. The tool shows the exact text the owner signed. Compare it with the pages of this ` +
      `document. The signature covers every word, number and punctuation mark; capital letters, line breaks and spacing do not matter.`,
    y - 12,
    { size: 9 },
  );
  y -= 14;

  const n = info.codes.length;
  // Generous white space between codes keeps them easy to tell apart, for
  // scanners and for the tool's own reader.
  const perRow = 3;
  const size = 120;
  const gap = (CONTENT_W - perRow * size) / (perRow - 1);
  for (let i = 0; i < n; i++) {
    const col = i % perRow;
    if (col === 0) {
      if (y - (size + 30) < BOTTOM) {
        sp = doc.addPage([PAGE_W, PAGE_H]);
        sigPages.push(sp);
        y = header(sp, fonts, 'OpenPGP signature page (continued)', 'Owner’s Digital Signature');
      }
    }
    const x = M + col * (size + gap);
    const qr = bestQr(info.codes[i])!;
    drawQr(sp, qr, x, y, size);
    const label = `Code ${i + 1} of ${n}`;
    sp.drawText(label, { x: x + (size - fonts.bold.widthOfTextAtSize(label, 8.5)) / 2, y: y - size - 12, size: 8.5, font: fonts.bold, color: MUTED });
    if (col === perRow - 1 || i === n - 1) y -= size + 62;
  }

  y = text(
    sp,
    fonts,
    'Without this tool: the codes hold the signed text and a standard OpenPGP signature. The tool can save them as document.txt ' +
      'and document.sig, which check with: gpg --verify document.sig document.txt',
    y - 4,
    { size: 8, color: MUTED },
  );

  const total = doc.getPageCount();
  const firstSig = contentPages.length + 1;
  doc.getPages().forEach((pg, i) =>
    footer(
      pg,
      fonts,
      i < contentPages.length
        ? `Document ID ${info.documentId}  |  Owner's digital signature for this text: page ${firstSig}`
        : `Document ID ${info.documentId}  |  ${n} signature code${n === 1 ? '' : 's'}`,
      i + 1,
      total,
    ),
  );
  return doc.save();
}

// ---------------------------------------------------------------------------
// Verification certificate: printed by Recorder staff after checking a filing,
// signed in ink and appended to the filing.
// ---------------------------------------------------------------------------

export interface CertificateInfo {
  result: 'good' | 'bad';
  /** One-line summary of each check, e.g. "Pass: Signature valid". */
  checks: string[];
  verifierName?: string;
  verifierTitle?: string;
  agency?: string;
  parcels?: string;
  /** One entry per registered owner (and any unregistered signer). */
  owners: { userID: string; fingerprint: string; result: string; signedAt?: Date }[];
  documentId: string;
  checkedAt: Date;
  /** The exact text the owner signed (canonical form). */
  signedText: string;
  /** The signature codes as scanned, reprinted so this page can be checked again. */
  codes: string[];
}

export async function certificatePdf(info: CertificateInfo): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(`Verification certificate - ${info.documentId}`);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  const BOTTOM = 64;
  let y = header(
    page,
    fonts,
    'Verification certificate',
    'S.T.O.P. Signature Verification',
    'Completed by agency personnel and appended to the filing.',
  );

  const good = info.result === 'good';
  const agency = info.agency?.trim() || 'the receiving agency';
  y = text(
    page,
    fonts,
    `The undersigned personnel of ${agency} determined that the parcel(s) below are protected by the ${BRAND.name} ` +
      `(signing keys are registered for them), and checked the digital signatures on the instrument described below ` +
      `against every key registered for the parcel, using the signature codes printed with the instrument.`,
    y,
    { size: 10 },
  );
  y -= 8;
  const bannerH = 34;
  page.drawRectangle({
    x: M,
    y: y - bannerH,
    width: CONTENT_W,
    height: bannerH,
    color: good ? rgb(0.9, 0.96, 0.92) : rgb(0.98, 0.91, 0.91),
    borderColor: good ? rgb(0.08, 0.42, 0.18) : WARN,
    borderWidth: 1,
  });
  const verdict = good
    ? `RESULT: GOOD. Every registered key signed the text below.`
    : 'RESULT: DOES NOT VERIFY. Hold the filing; suspected forgery.';
  page.drawText(verdict, { x: M + 10, y: y - 21, size: 11, font: fonts.bold, color: good ? rgb(0.08, 0.42, 0.18) : WARN });
  y -= bannerH + 10;

  const tableTop = y;
  const rows: Row[] = [
    { label: 'Parcel number', value: info.parcels?.trim() || '' },
    ...info.owners.map((o, i) => ({
      label: info.owners.length > 1 ? `Key ${i + 1}` : 'Key',
      value: `${o.userID || '(name not given)'}\n${formatFingerprint(o.fingerprint)}\n${o.result}${o.signedAt ? `, signed ${isoDateTime(o.signedAt)}` : ''}`,
    })),
    { label: 'Document ID', value: info.documentId, mono: true },
  ];
  rows.push({ label: 'Checked at', value: isoDateTime(info.checkedAt) });
  y = table(page, fonts, rows, tableTop, CONTENT_W - 190, 120);
  const bx = PAGE_W - M - 175;
  const moduleW = Math.min(0.8, 175 / (code128Bits(info.documentId).length + 20));
  const bw = drawCode128(page, info.documentId, bx + 10 * moduleW, tableTop - 58, moduleW, 50);
  const idW = fonts.mono.widthOfTextAtSize(info.documentId, 8);
  page.drawText(info.documentId, { x: bx + 10 * moduleW + (bw - idW) / 2, y: tableTop - 70, size: 8, font: fonts.mono, color: INK });
  y = text(page, fonts, info.checks.join('   |   '), y - 6, { size: 8, color: MUTED });

  // Verifier block: typed name/title if given, signed in ink.
  const blockH = 118;
  if (y - blockH < BOTTOM) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
  }
  y = text(page, fonts, 'Verified by', y - 14, { size: 10, font: fonts.bold });
  const half = (CONTENT_W - 30) / 2;
  const line = (label: string, value: string, x: number, w: number) => {
    if (value.trim()) page.drawText(safeText(value.trim()), { x: x + 2, y: y + 4, size: 10.5, font: fonts.reg, color: INK });
    rule(page, y, x, x + w, INK);
    page.drawText(label, { x, y: y - 10, size: 7.5, font: fonts.reg, color: MUTED });
  };
  y -= 26;
  line('Name', info.verifierName ?? '', M, half);
  line('Title', info.verifierTitle ?? '', M + half + 30, half);
  y -= 32;
  line('Agency', info.agency ?? '', M, half);
  line('Date', '', M + half + 30, half);
  y -= 36;
  line('Signature', '', M, half);
  y -= 22;

  // The signed text, in full.
  const drawLines = (lines: string[], size: number, font: PDFFont, lead: number) => {
    for (const l of lines) {
      if (y - lead < BOTTOM) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = header(page, fonts, 'Verification certificate (continued)', 'S.T.O.P. Signature Verification');
      }
      page.drawText(l, { x: M, y: y - size, size, font, color: INK });
      y -= lead;
    }
  };
  if (y - 60 < BOTTOM) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = header(page, fonts, 'Verification certificate (continued)', 'S.T.O.P. Signature Verification');
  }
  y = text(page, fonts, 'Exactly what the owner signed', y - 4, { size: 10, font: fonts.bold });
  y = text(
    page,
    fonts,
    'Recovered from the signature codes. Capital letters, spacing and line breaks are not significant; every word, number and punctuation mark is.',
    y - 2,
    { size: 8, color: MUTED },
  );
  y -= 6;
  drawLines(wrap(info.signedText, fonts.mono, 8.5, CONTENT_W), 8.5, fonts.mono, 11.5);

  // The signature codes again, so this certificate can be re-checked by scanning.
  if (info.codes.length) {
    const size = 120;
    const perRow = 3;
    const gap = (CONTENT_W - perRow * size) / (perRow - 1);
    if (y - 40 - size < BOTTOM) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = header(page, fonts, 'Verification certificate (continued)', 'S.T.O.P. Signature Verification');
    }
    y = text(page, fonts, 'Owner’s signature codes (as scanned)', y - 14, { size: 10, font: fonts.bold });
    y -= 10;
    info.codes.forEach((code, i) => {
      const col = i % perRow;
      if (col === 0 && y - size - 20 < BOTTOM) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = header(page, fonts, 'Verification certificate (continued)', 'S.T.O.P. Signature Verification');
      }
      const x = M + col * (size + gap);
      const qr = bestQr(code);
      if (qr) drawQr(page, qr, x, y, size);
      const label = `Code ${i + 1} of ${info.codes.length}`;
      page.drawText(label, { x: x + (size - fonts.bold.widthOfTextAtSize(label, 8.5)) / 2, y: y - size - 12, size: 8.5, font: fonts.bold, color: MUTED });
      if (col === perRow - 1 || i === info.codes.length - 1) y -= size + 50;
    });
  }

  const total = doc.getPageCount();
  doc.getPages().forEach((pg, i) => footer(pg, fonts, `Verification certificate  |  Document ID ${info.documentId}`, i + 1, total));
  return doc.save();
}

// ---------------------------------------------------------------------------
// Public key card: a one-page PDF an owner gives to co-owners, so they can
// list this key on their own registration forms. Safe to share.
// ---------------------------------------------------------------------------
export async function publicKeyCardPdf(info: { fingerprint: string; userID: string; created: Date; publicArmored: string; publicKeyBinary: Uint8Array }) {
  const { doc, fonts } = await newDoc('Public key card');
  await doc.attach(new TextEncoder().encode(info.publicArmored), PUBLIC_KEY_ATTACHMENT, {
    mimeType: 'application/pgp-keys',
    description: 'OpenPGP public key',
    creationDate: info.created,
  });
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = header(
    p,
    fonts,
    'Public key card  |  Safe to share',
    'Public Key Card',
    'Give this to your co-owners. They add it on their registration forms so every owner\u2019s key is listed for the parcel.',
  );
  y = table(
    p,
    fonts,
    [
      { label: 'Key holder', value: info.userID },
      { label: 'Key fingerprint', value: formatFingerprint(info.fingerprint), mono: true },
      { label: 'Key created', value: isoDate(info.created) },
    ],
    y,
    CONTENT_W,
  );
  const qr = bestQr(`${PUBKEY_QR_PREFIX}|${toBase64(info.publicKeyBinary)}`);
  if (qr) {
    drawQr(p, qr, M, y - 16, 190);
    text(
      p,
      fonts,
      'To add this key: on the registration step, choose "Add a co-owner\u2019s key" and pick this PDF, or take a photo of this ' +
        'page. Check that the fingerprint shown matches the one printed here. A public key can check signatures but cannot create them.',
      y - 16,
      { x: M + 206, size: 9, color: MUTED, width: CONTENT_W - 206 },
    );
    y -= 190 + 30;
  }
  for (const line of info.publicArmored.trim().split(/\r?\n/)) {
    p.drawText(safeText(line), { x: M, y: y - 8, size: 8, font: fonts.mono, color: INK });
    y -= 10;
  }
  footer(p, fonts, `Public key card  |  ${formatFingerprint(info.fingerprint)}`, 1, 1);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Reading registrations and partially signed documents back out of PDFs
// ---------------------------------------------------------------------------

/** Every parcel registration embedded in a registration form PDF made by this tool. */
export async function registrationsFromPdf(bytes: Uint8Array): Promise<Registration[]> {
  const files = await pdfAttachments(bytes).catch(() => []);
  const out: Registration[] = [];
  for (const f of files.filter((x) => x.name.startsWith(REGISTRATION_ATTACHMENT))) {
    try {
      const j = JSON.parse(new TextDecoder().decode(f.data));
      if (j.format !== 'stop-registration-1') continue;
      const keys = await Promise.all((j.keys as string[]).map(async (a) => (await readAnyKey(a)).toPublic()));
      const labels = Array.isArray(j.labels) ? (j.labels as unknown[]).map((x) => String(x ?? '')) : undefined;
      out.push({ parcel: String(j.parcel ?? ''), keys, labels });
    } catch {
      /* skip damaged entries */
    }
  }
  return out;
}

/** The document and signatures embedded in a signed-document PDF made by this tool, if any. */
export async function draftFromPdf(bytes: Uint8Array): Promise<DocumentDraft | null> {
  const files = await pdfAttachments(bytes).catch(() => []);
  const f = files.find((x) => x.name === DOCUMENT_ATTACHMENT);
  if (!f) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(f.data));
    return j.format === 'stop-document-1' ? (j as DocumentDraft) : null;
  } catch {
    return null;
  }
}
