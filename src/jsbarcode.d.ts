declare module 'jsbarcode/bin/barcodes/CODE128/index.js' {
  export class CODE128 {
    constructor(data: string, options: object);
    valid(): boolean;
    encode(): { data: string; text: string };
  }
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
declare module 'pdfjs-dist/legacy/build/pdf.mjs';
