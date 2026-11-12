// QR and Code 128 encoders that return plain module data, so the PDF can draw
// them as crisp vector shapes (no canvas or images needed, works in Node too).
import QRCode from 'qrcode';
import { CODE128 } from 'jsbarcode/bin/barcodes/CODE128/index.js';

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
