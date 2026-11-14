// Reads QR codes from images: the PDFs this tool makes, a scanned PDF of the
// paper, or a photo. Everything is decoded locally; nothing is uploaded.
import jsQR from 'jsqr';

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

/**
 * Finds every QR code in an image. jsQR reads one code at a time and gets
 * confused when several codes sit near each other, so the image is also
 * searched in overlapping tiles about the size of one code. Codes already read
 * are painted white, and mostly-white tiles are skipped. `isComplete` lets the
 * search stop as soon as everything needed has been found.
 */
export function decodeAllQr(input: Pixels, isComplete: (codes: string[]) => boolean = () => false, max = 60): string[] {
  const work = shrink(input, 2300);
  const found = new Map<string, number>();
  const done = () => found.size > 0 && isComplete([...found.keys()]);
  const take = (hits: Hit[], dx = 0, dy = 0) => {
    for (const h of hits) {
      found.set(h.text, h.size);
      paint(work, [h.box[0] + dx, h.box[1] + dy, h.box[2] + dx, h.box[3] + dy]);
    }
  };
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
  try {
    // The signature page is last, so read from the end and stop once every code is found.
    for (let n = doc.numPages; n >= 1; n--) {
      if (isComplete(codes)) break;
      onPage?.(doc.numPages - n + 1, doc.numPages);
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
      for (const c of decodeAllQr(canvasPixels(canvas), (found) => isComplete([...codes, ...found]))) {
        if (!codes.includes(c)) codes.push(c);
      }
      page.cleanup();
      canvas.width = canvas.height = 0;
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
): Promise<string[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (isPdf) return pdfCodes(bytes, isComplete, (p, n) => onProgress?.(`Reading page ${p} of ${n}...`));
  onProgress?.('Reading image...');
  return decodeAllQr(await imageFilePixels(file), isComplete);
}
