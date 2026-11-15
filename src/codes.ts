// QR and Code 128 encoders that return plain module data, so the PDF can draw
// them as crisp vector shapes (no canvas or images needed, works in Node too).
import QRCode from 'qrcode';
import { CODE128 } from 'jsbarcode/bin/barcodes/CODE128/index.js';
import { pdf417, drawingSVG } from 'bwip-js/generic';

export interface QrMatrix {
  size: number;
  dark(row: number, col: number): boolean;
}

export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: level });
  const { size, data } = qr.modules;
  return { size, dark: (r, c) => data[r * size + c] === 1 };
}

/** Largest error-correction level that still fits the text, or null if it cannot fit at all. */
export function bestQr(text: string): QrMatrix | null {
  for (const level of ['M', 'L'] as const) {
    try {
      return qrMatrix(text, level);
    } catch {
      /* too long for this level */
    }
  }
  return null;
}

/** Code 128 bar pattern as a string of '1' (bar) and '0' (space) modules. */
export function code128Bits(text: string): string {
  const enc = new CODE128(text, {}).encode() as { data: string };
  return enc.data;
}

// ---------------------------------------------------------------------------
// Code map: a PDF417 symbol printed in the left margin of every page that has
// QR codes. It lists where each QR code is, measured from the map itself in
// its own module units, so a reader can find the map, work out the scan's
// scale, position and tilt from it, and cut each QR code out directly instead
// of searching the whole page. A different symbology from QR, so the reader can
// look for it alone.
//
// Text: PGPMAP1|<columns>|<document ID or ->|<QR size>|u,v[,size];u,v[,size];...
//   u: along the map (from its start pattern), v: across it (from its top row),
//   both to the QR code's corner nearest the map's origin, in map modules.
// ---------------------------------------------------------------------------
export const MAP_PREFIX = 'PGPMAP1';

export interface CodeMapEntry {
  /** Offsets and size in map modules. */
  u: number;
  v: number;
  size: number;
}

export interface CodeMap {
  columns: number;
  documentId: string;
  entries: CodeMapEntry[];
}

/** Total width of a PDF417 symbol in modules: start, left indicator, data, right indicator, stop. */
export const pdf417Modules = (columns: number) => 17 * (columns + 4) + 1;

export function codeMapText(m: CodeMap): string {
  const sizes = m.entries.map((e) => e.size);
  const common = sizes.sort((a, b) => sizes.filter((x) => x === b).length - sizes.filter((x) => x === a).length)[0] ?? 0;
  const list = m.entries.map((e) => (e.size === common ? `${e.u},${e.v}` : `${e.u},${e.v},${e.size}`)).join(';');
  return [MAP_PREFIX, m.columns, m.documentId || '-', common, list].join('|');
}

export function parseCodeMap(text: string): CodeMap | null {
  const f = text.split('|');
  if (f[0] !== MAP_PREFIX || f.length < 5) return null;
  const columns = Number(f[1]);
  const common = Number(f[3]);
  if (!(columns > 0) || !(common > 0)) return null;
  const entries: CodeMapEntry[] = [];
  for (const item of f[4].split(';').filter(Boolean)) {
    const [u, v, s] = item.split(',').map(Number);
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    entries.push({ u, v, size: Number.isFinite(s) ? s : common });
  }
  return { columns, documentId: f[2] === '-' ? '' : f[2], entries };
}

/** The PDF417 symbol as one SVG path (2 units per module), with its size in units. */
export function pdf417Path(text: string, columns: number): { path: string; width: number; height: number } {
  const svg = pdf417({ bcid: 'pdf417', text, columns, eclevel: 3, rowmult: 3 } as Parameters<typeof pdf417>[0], drawingSVG()) as string;
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const path = /<path[^>]* d="([^"]+)"/.exec(svg);
  if (!vb || !path) throw new Error('The code map could not be drawn.');
  return { path: path[1], width: Number(vb[1]), height: Number(vb[2]) };
}
