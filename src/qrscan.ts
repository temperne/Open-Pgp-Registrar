// Reads QR codes from images: the PDFs this tool makes, a scanned PDF of the
// paper, or a photo. Everything is decoded locally; nothing is uploaded.
import jsQR from 'jsqr';
import { PDF417Reader, QRCodeReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType } from '@zxing/library';
import { parseCodeMap, pdf417Modules, type CodeMap } from './codes';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Hit {
  text: string;
  /** Code width in pixels. */
  size: number;
  /** Bounding box (with a small margin) relative to the image searched. */
  box: [number, number, number, number];
}

function paint(img: Pixels, [x0, y0, x1, y1]: Hit['box']) {
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    img.data.fill(255, (y * img.width + Math.max(0, x0)) * 4, (y * img.width + Math.min(img.width - 1, x1) + 1) * 4);
  }
}

/** Reads codes one at a time, painting over each one found so the next can be read. */
function decodeWithMasking(src: Pixels, max: number): Hit[] {
  const img = { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  const found: Hit[] = [];
  for (let i = 0; i < max; i++) {
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (!r) break;
    const pts = [r.location.topLeftCorner, r.location.topRightCorner, r.location.bottomLeftCorner, r.location.bottomRightCorner];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    // Artwork (a seal, a photo) can fool the detector into an empty or nonsense "code";
    // ignore it, or its size would steer the tile search wrong.
    if (!r.data || r.data.length < 4 || r.binaryData.length === 0) break;
    const pad = Math.max(4, size * 0.08);
    const box: Hit['box'] = [
      Math.floor(Math.min(...xs) - pad),
      Math.floor(Math.min(...ys) - pad),
      Math.ceil(Math.max(...xs) + pad),
      Math.ceil(Math.max(...ys) + pad),
    ];
    found.push({ text: r.data, size, box });
    paint(img, box);
  }
  return found;
}

function crop(img: Pixels, x: number, y: number, w: number, h: number): Pixels {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Share of dark pixels in a region, sampled sparsely (cheap). */
function darkShare(img: Pixels, x: number, y: number, w: number, h: number) {
  let dark = 0;
  let total = 0;
  for (let yy = y; yy < y + h; yy += 4) {
    for (let xx = x; xx < x + w; xx += 4) {
      const i = (yy * img.width + xx) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 384) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}

/** Nearest-neighbour downscale, so huge scans and photos are searched at about 200 dpi. */
function shrink(img: Pixels, maxSide: number): Pixels {
  const f = maxSide / Math.max(img.width, img.height);
  if (f >= 1) return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const w = Math.round(img.width * f);
  const h = Math.round(img.height * f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) {
      const si = (sy * img.width + Math.min(img.width - 1, Math.floor(x / f))) * 4;
      out.set(img.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Code map (see codes.ts): a PDF417 symbol in the left margin listing where each
// QR code on the page is. Read first; then each QR code is cut out and decoded
// on its own, with no full-page search.
// ---------------------------------------------------------------------------
const HINTS = new Map([[DecodeHintType.TRY_HARDER, true]]);
type Pt = { x: number; y: number };

/** Luminance of a region, turned a quarter turn so the map reads left to right. */
function strip(img: Pixels, side: 'left' | 'right', frac = 0.16) {
  const sw = Math.max(1, Math.round(img.width * frac));
  const x0 = side === 'left' ? 0 : img.width - sw;
  const W = img.height;
  const H = sw;
  const lum = new Uint8ClampedArray(W * H);
  // left: the map runs up the page, so turn clockwise; right (page upside down): turn counter-clockwise.
  const toImg = (xn: number, yn: number): Pt =>
    side === 'left' ? { x: x0 + yn, y: img.height - 1 - xn } : { x: img.width - 1 - yn, y: xn };
  for (let yn = 0; yn < H; yn++) {
    for (let xn = 0; xn < W; xn++) {
      const p = toImg(xn, yn);
      const i = (p.y * img.width + p.x) * 4;
      lum[yn * W + xn] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
    }
  }
  return { lum, W, H, toImg };
}

interface MapRead {
  map: CodeMap;
  /** Expected box of each listed QR code, in image pixels, with a margin. */
  boxes: Hit['box'][];
}

function findCodeMap(img: Pixels): MapRead | null {
  for (const side of ['left', 'right'] as const) {
    const s = strip(img, side);
    let r;
    try {
      r = new PDF417Reader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(s.lum, s.W, s.H))), HINTS);
    } catch {
      continue;
    }
    const map = parseCodeMap(r.getText());
    const pts = r.getResultPoints();
    if (!map || pts.length < 3 || !pts[0] || !pts[1] || !pts[2]) continue;
    // Corners: 0 top-left, 1 bottom-left, 2 top-right of the symbol, in its own orientation.
    const [p0, p1, p2] = [pts[0], pts[1], pts[2]].map((p) => s.toImg(p.getX(), p.getY()));
    const n = pdf417Modules(map.columns);
    const U = { x: (p2.x - p0.x) / n, y: (p2.y - p0.y) / n };
    // Across the map: perpendicular to U, toward the symbol's bottom edge, one module long.
    let V = { x: -U.y, y: U.x };
    if (V.x * (p1.x - p0.x) + V.y * (p1.y - p0.y) < 0) V = { x: U.y, y: -U.x };
    const at = (u: number, v: number): Pt => ({ x: p0.x + U.x * u + V.x * v, y: p0.y + U.y * u + V.y * v });
    // The code's own outline (no margin): decodeOne adds the margin.
    const boxes = map.entries.map((e): Hit['box'] => {
      const c = [at(e.u, e.v), at(e.u + e.size, e.v), at(e.u, e.v + e.size), at(e.u + e.size, e.v + e.size)];
      return [Math.min(...c.map((q) => q.x)), Math.min(...c.map((q) => q.y)), Math.max(...c.map((q) => q.x)), Math.max(...c.map((q) => q.y))];
    });
    return { map, boxes };
  }
  return null;
}

/**
 * Decodes one QR code from its predicted outline. The decoders are sensitive to
 * exactly where a cut-out's edges fall (labels, scan noise), so if the first
 * framing fails, a few others are tried: each costs only milliseconds.
 */
function decodeOne(img: Pixels, outline: Hit['box']): { text: string; box: Hit['box'] } | null {
  const size = Math.max(outline[2] - outline[0], outline[3] - outline[1]);
  const framings: [number, number, number][] = [
    [0.1, 0, 0],
    [0.15, 0, 0],
    [0.05, 0, 0],
    [0.1, 0, -0.04],
    [0.1, 0, 0.04],
    [0.1, -0.04, 0],
    [0.1, 0.04, 0],
    [0.2, 0, 0],
  ];
  for (const [pad, dx, dy] of framings) {
    const p = pad * size;
    const box: Hit['box'] = [
      Math.max(0, Math.floor(outline[0] - p + dx * size)),
      Math.max(0, Math.floor(outline[1] - p + dy * size)),
      Math.min(img.width - 1, Math.ceil(outline[2] + p + dx * size)),
      Math.min(img.height - 1, Math.ceil(outline[3] + p + dy * size)),
    ];
    const text = decodeBox(img, box);
    if (text) return { text, box };
  }
  return null;
}

/** ZXing first (fast), jsQR if it misses. */
function decodeBox(img: Pixels, [x0, y0, x1, y1]: Hit['box']): string | null {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 8 || h < 8) return null;
  const c = crop(img, x0, y0, w, h);
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = (c.data[i * 4] * 299 + c.data[i * 4 + 1] * 587 + c.data[i * 4 + 2] * 114) / 1000;
  try {
    const t = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, h))), HINTS).getText();
    if (t) return t;
  } catch {
    /* try jsQR */
  }
  const r = jsQR(c.data, w, h, { inversionAttempts: 'dontInvert' });
  return r?.data || null;
}

/**
 * The quick pass: the page's code map and the codes it lists, nothing else.
 * `complete` is true when a map was found and every code it lists was read,
 * so the page needs no full search.
 */
export function decodeMapped(input: Pixels, onMap?: (map: CodeMap) => void): { codes: string[]; complete: boolean } {
  const work = shrink(input, 2300);
  const mapped = findCodeMap(work);
  if (!mapped) return { codes: [], complete: false };
  onMap?.(mapped.map);
  const codes: string[] = [];
  for (const outline of mapped.boxes) {
    const r = decodeOne(work, outline);
    if (r) codes.push(r.text);
  }
  return { codes, complete: codes.length === mapped.boxes.length };
}

/**
 * Finds every QR code in an image. jsQR reads one code at a time and gets
 * confused when several codes sit near each other, so the image is also
 * searched in overlapping tiles about the size of one code. Codes already read
 * are painted white, and mostly-white tiles are skipped. `isComplete` lets the
 * search stop as soon as everything needed has been found.
 */
export function decodeAllQr(
  input: Pixels,
  isComplete: (codes: string[]) => boolean = () => false,
  max = 60,
  onMap?: (map: CodeMap) => void,
): string[] {
  const work = shrink(input, 2300);
  const found = new Map<string, number>();
  const done = () => found.size > 0 && isComplete([...found.keys()]);
  const take = (hits: Hit[], dx = 0, dy = 0) => {
    for (const h of hits) {
      found.set(h.text, h.size);
      paint(work, [h.box[0] + dx, h.box[1] + dy, h.box[2] + dx, h.box[3] + dy]);
    }
  };
  // The page's code map, when it has one: cut out and decode each listed code.
  const mapped = findCodeMap(work);
  if (mapped) {
    onMap?.(mapped.map);
    let all = true;
    const hits: Hit[] = [];
    for (const outline of mapped.boxes) {
      const r = decodeOne(work, outline);
      if (r) hits.push({ text: r.text, size: r.box[2] - r.box[0], box: r.box });
      else all = false;
    }
    take(hits);
    // Every listed code read: nothing else on this page needs the slow search.
    if (all || done()) return [...found.keys()];
  }
  take(decodeWithMasking(work, max));
  if (done()) return [...found.keys()];

  const scan = (tile: number, step: number, minDark: number) => {
    tile = Math.round(Math.min(tile, work.width, work.height));
    step = Math.max(8, Math.round(step));
    for (let y = 0; y + tile / 2 < work.height; y += step) {
      for (let x = 0; x + tile / 2 < work.width; x += step) {
        const w = Math.min(tile, work.width - x);
        const h = Math.min(tile, work.height - y);
        if (darkShare(work, x, y, w, h) < minDark) continue;
        const hits = decodeWithMasking(crop(work, x, y, w, h), 3);
        take(hits, x, y);
        if (hits.length && done()) return true;
      }
    }
    return false;
  };

  // Without a code to measure, try a few tile sizes until one is found.
  if (!found.size) {
    for (const frac of [0.3, 0.42, 0.22, 0.55]) {
      const t = work.width * frac;
      if (scan(t, t / 4, 0.12) || found.size) break;
    }
  }
  // With the code size known, use tiles just big enough for one code.
  const sizes = [...found.values()].sort((a, b) => a - b);
  if (sizes.length && !done()) {
    const s = sizes[Math.floor(sizes.length / 2)];
    scan(s * 1.4, s * 0.25, 0.18);
  }
  return [...found.keys()];
}

function canvasPixels(canvas: HTMLCanvasElement): Pixels {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Draws an image file (photo or scan) onto a canvas, at most `maxSide` pixels on its longest side. */
async function imageFilePixels(file: Blob, maxSide = 3000): Promise<Pixels> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That image could not be opened. Use a JPG or PNG photo or scan, or a PDF.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvasPixels(canvas);
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/**
 * pdf.js runs on the main thread: importing its worker module registers the
 * worker code in-page, so no separate worker file or network access is needed.
 */
export function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof import('pdfjs-dist');
  })();
  return pdfjsPromise;
}

/** Renders each PDF page and returns the QR codes found on all of them. */
async function pdfCodes(
  bytes: Uint8Array,
  isComplete: (codes: string[]) => boolean,
  onPage?: (page: number, pages: number) => void,
  onMap?: (map: CodeMap) => void,
): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new Error(/password/i.test(String(e)) ? 'That PDF is password-protected.' : 'That PDF could not be opened.');
  }
  const codes: string[] = [];
  const add = (found: string[]) => {
    for (const c of found) if (!codes.includes(c)) codes.push(c);
  };
  const render = async (n: number) => {
    const page = await doc.getPage(n);
    // About 200 dpi: plenty for printed codes, and for scans made at 200-300 dpi.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(200 / 72, 3200 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const px = canvasPixels(canvas);
    page.cleanup();
    canvas.width = canvas.height = 0;
    return px;
  };
  try {
    // Quick pass, every page: the code map and the codes it lists. Signature pages
    // are usually last (a signed file's codes are on its cover), so read from the
    // end; stop as soon as everything is in.
    const needFull: number[] = [];
    for (let n = doc.numPages; n >= 1; n--) {
      if (isComplete(codes)) return codes;
      onPage?.(doc.numPages - n + 1, doc.numPages);
      const r = decodeMapped(await render(n), onMap);
      add(r.codes);
      if (!r.complete) needFull.push(n);
    }
    // Full search, only where there was no map (an older document, a page from
    // elsewhere, a damaged map) or a listed code could not be read.
    for (const n of needFull) {
      if (isComplete(codes)) break;
      onPage?.(doc.numPages - n + 1, doc.numPages);
      add(decodeAllQr(await render(n), (found) => isComplete([...codes, ...found]), 60, onMap));
    }
  } finally {
    await doc.destroy();
  }
  return codes;
}

/**
 * Reads every QR code in a PDF (any number of pages) or an image file.
 * `onProgress` gets a short status line while it works.
 */
export async function readCodesFromFile(
  file: File,
  onProgress?: (msg: string) => void,
  isComplete: (codes: string[]) => boolean = () => false,
  /** Called with each code map read (pages printed by this tool carry one). */
  onMap?: (map: CodeMap) => void,
): Promise<string[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (isPdf) return pdfCodes(bytes, isComplete, (p, n) => onProgress?.(`Reading page ${p} of ${n}...`), onMap);
  onProgress?.('Reading image...');
  return decodeAllQr(await imageFilePixels(file), isComplete, 60, onMap);
}

