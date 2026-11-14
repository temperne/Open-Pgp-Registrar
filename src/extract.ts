// Turns a file into the text that gets signed and printed ("recreated").
// Paper is the proof in this system, so what is signed has to come back from
// paper: the file's text, page by page. A file with no text (a scan, a photo)
// cannot be signed this way.
import { unzipSync, strFromU8 } from 'fflate';
import { safeText } from './text';

export interface SourceImage {
  bytes: Uint8Array;
  format: 'png' | 'jpg';
  name: string;
}

export interface ExtractedFile {
  /** 'image' and 'scan' (a PDF without text) carry no text: the signer describes them. */
  kind: 'pdf' | 'docx' | 'odt' | 'text' | 'image' | 'scan';
  name: string;
  /** Text of each page (PDF), or the whole document as one entry (other kinds). Empty for images and scans. */
  pages: string[];
  /** Pages printed in the package (PDF and scans: the original pages; images: one each). */
  pageCount: number;
  /** The original PDF, reprinted page for page. */
  pdf?: Uint8Array;
  /** Images, one page each. */
  images?: SourceImage[];
  /** SHA-256 of the original file(s), in order: proves the exact file when it is available. */
  sha256: string[];
}

/** No text of its own: the signer writes what it shows, and that is signed. */
export const needsDescription = (f: ExtractedFile) => f.kind === 'image' || f.kind === 'scan';

async function sha256Hex(b: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
export const looksImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?|avif)$/i.test(f.name);

/** PNG and JPEG go in as they are; other formats are converted to PNG by the browser. */
async function toPrintableImage(file: File, bytes: Uint8Array): Promise<SourceImage> {
  if (isPng(bytes)) return { bytes, format: 'png', name: file.name };
  if (isJpg(bytes)) return { bytes, format: 'jpg', name: file.name };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: this browser can't open that image format. Save it as JPG or PNG first.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error(`${file.name}: the image could not be converted.`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), format: 'png', name: file.name };
}

/** One or more images become one signed file, a page each. */
export async function extractImages(files: File[]): Promise<ExtractedFile> {
  const images: SourceImage[] = [];
  const sha256: string[] = [];
  for (const f of files) {
    if (!looksImage(f)) throw new Error('When choosing several files, choose only images (one page each).');
    const bytes = new Uint8Array(await f.arrayBuffer());
    sha256.push(await sha256Hex(bytes));
    images.push(await toPrintableImage(f, bytes));
  }
  return {
    kind: 'image',
    name: files.length === 1 ? files[0].name : `${files.length} images (${files.map((f) => f.name).join(', ')})`,
    pages: [],
    pageCount: images.length,
    images,
    sha256,
  };
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

/** Printable form of extracted text: compatibility characters (ligatures) expanded, tidy lines. */
function tidy(s: string) {
  return safeText(s.normalize('NFKC'))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Word: paragraphs (w:p) of text runs (w:t), tabs and breaks, in document order. */
export function docxText(xml: string) {
  const body = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n');
  const paras = body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paras
    .map((p) => (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|\t|\n/g) ?? []).map((m) => (m.startsWith('<') ? decodeXmlEntities(m.replace(/<[^>]+>/g, '')) : m)).join(''))
    .join('\n');
}

/** OpenDocument: paragraphs and headings (text:p, text:h). */
export function odtText(xml: string) {
  const body = xml.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)));
  const paras = body.match(/<text:(p|h)\b[^>]*>[\s\S]*?<\/text:\1>|<text:(p|h)\b[^>]*\/>/g) ?? [];
  return paras.map((p) => decodeXmlEntities(p.replace(/<[^>]+>/g, ''))).join('\n');
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const { loadPdfjs } = await import('./qrscan');
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let s = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== 'string') continue;
        s += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push(s);
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

export const SUPPORTED_FILES = 'PDF (with selectable text), Word (.docx), OpenDocument (.odt), or plain text (.txt, .md, .csv)';

export async function extractFile(file: File): Promise<ExtractedFile> {
  if (looksImage(file)) return extractImages([file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const sha256 = [await sha256Hex(bytes)];
  let out: ExtractedFile;
  if (isPdf(bytes)) {
    const pages = (await pdfPages(bytes)).map(tidy);
    // A scanned PDF has no text: it is printed as it is and the signer describes it.
    if (!pages.join('').trim()) return { kind: 'scan', name, pages: [], pageCount: pages.length, pdf: bytes, sha256 };
    out = { kind: 'pdf', name, pages, pageCount: pages.length, pdf: bytes, sha256 };
  } else if (isZip(bytes)) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' || f.name === 'content.xml' });
    } catch {
      throw new Error(`That file could not be opened. Use ${SUPPORTED_FILES}.`);
    }
    if (files['word/document.xml']) out = { kind: 'docx', name, pages: [tidy(docxText(strFromU8(files['word/document.xml'])))], pageCount: 0, sha256 };
    else if (files['content.xml']) out = { kind: 'odt', name, pages: [tidy(odtText(strFromU8(files['content.xml'])))], pageCount: 0, sha256 };
    else throw new Error(`That kind of file can't be recreated for signing. Use ${SUPPORTED_FILES}, or save it as a PDF first.`);
  } else if (/\.(txt|md|csv|text)$/i.test(name) || file.type.startsWith('text/')) {
    out = { kind: 'text', name, pages: [tidy(new TextDecoder().decode(bytes))], pageCount: 0, sha256 };
  } else if (/\.doc$/i.test(name)) {
    throw new Error('Older Word (.doc) files can’t be read here. In Word, save it as .docx or as a PDF, then load that.');
  } else {
    throw new Error(`That kind of file can't be recreated for signing. Use ${SUPPORTED_FILES}, or save it as a PDF first.`);
  }
  if (!out.pages.join('').trim()) throw new Error('That file has no text to sign.');
  return out;
}

export const SUPPORTED_ALL = `${SUPPORTED_FILES}, or images (JPG, PNG and others)`;

/**
 * Everything that is signed for a file: what it is (name, fingerprint, pages),
 * then its text, or for an image or scan, the signer's description of it.
 * All of it is carried in the printed codes, so it comes back from paper.
 */
export function fileSignedText(f: ExtractedFile, description: string) {
  const head = [
    `SIGNED FILE: ${safeText(f.name)}.`,
    `DIGITAL FINGERPRINT (SHA-256): ${f.sha256.join(', ')}.`,
    f.pageCount ? `PAGES: ${f.pageCount}.` : '',
  ].filter(Boolean);
  const body = needsDescription(f)
    ? [`DESCRIPTION OR TRANSCRIPTION BY THE SIGNER (${f.kind === 'image' ? 'THE FILE IS AN IMAGE' : 'THE FILE IS A SCAN WITHOUT TEXT'}):`, description.trim()]
    : ['TEXT OF THE FILE:', f.pages.join('\n\n')];
  return [...head, '', ...body].join('\n');
}
