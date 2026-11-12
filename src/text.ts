// Text handling shared by the printed PDFs and the signature.
//
// The signature covers the *canonical* form of a document's text, not a file.
// The canonical form ignores everything that changes between screen, printer,
// retyping and OCR (capital letters, line breaks, spacing, curly vs. straight
// quotes) and keeps everything that carries meaning: every word, number and
// punctuation mark.

/**
 * Maps text onto what the standard PDF fonts can print (WinAnsi/Latin-1), so
 * the printed page and the signed text are always the same characters.
 */
export function safeText(s: string) {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[\t  -​  　]/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, '?');
}

/** Canonical form that is signed: printable characters, upper case, single spaces. */
export function canonicalText(s: string) {
  return safeText(s).toUpperCase().replace(/\s+/g, ' ').trim();
}

export interface TextDifference {
  /** Position in the canonical text where the two first differ. */
  index: number;
  signed: string;
  other: string;
}

/** First place two texts differ once both are canonical, or null when they match. */
export function firstDifference(signedCanonical: string, otherText: string): TextDifference | null {
  const other = canonicalText(otherText);
  if (other === signedCanonical) return null;
  let i = 0;
  while (i < signedCanonical.length && i < other.length && signedCanonical[i] === other[i]) i++;
  const from = Math.max(0, i - 30);
  return {
    index: i,
    signed: (from > 0 ? '...' : '') + signedCanonical.slice(from, i + 40) + (i + 40 < signedCanonical.length ? '...' : ''),
    other: (from > 0 ? '...' : '') + other.slice(from, i + 40) + (i + 40 < other.length ? '...' : ''),
  };
}
