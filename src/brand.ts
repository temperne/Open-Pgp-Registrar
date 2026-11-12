/*
 * ===========================================================================
 * BRANDING: edit this file to rename the program or change its web address.
 * ===========================================================================
 *
 * Everything here appears on the website and on every PDF the tool makes
 * (registration form, private key PDF, signed documents).
 *
 * The seal/logo IMAGE is not in this file. It is embedded in index.html, in
 * the <img id="brand-seal"> tag near the top; the comment above that tag
 * explains how to replace it.
 *
 * After editing, rebuild with `npm run build`; the new dist/index.html is the
 * finished single-file site.
 *
 * Only the standard PDF characters can be printed (plain Latin letters,
 * digits and common punctuation), so avoid curly quotes or symbols here.
 */
export const BRAND = {
  /** Full program name. */
  name: 'Pima County S.T.O.P. Initiative',
  /** What the acronym stands for. */
  expansion: 'Stop Theft of Property',
  /** County that runs the Recorder's office (used as the default county). */
  county: 'Pima County',
  /**
   * Program web address, printed on every PDF and linked from the site.
   * PLACEHOLDER: replace '[PROJECT URL]' with the real address, e.g.
   * 'https://www.example.gov/stop'.
   */
  projectUrl: '[PROJECT URL]',
  /**
   * 'proposed' prints the notice below on the site and every PDF, so nobody
   * mistakes these documents for official county forms before the program is
   * adopted. Change to 'adopted' only once the county has approved the program
   * (and the use of its seal).
   */
  status: 'proposed' as 'proposed' | 'adopted',
  proposedNotice: 'Proposed program: not yet adopted by Pima County. Not an official county form.',
};

/** Text for the PDF footers. */
export function brandLine() {
  const parts = [`${BRAND.name} (${BRAND.expansion})`, BRAND.projectUrl];
  if (BRAND.status === 'proposed') parts.push(BRAND.proposedNotice);
  return parts.filter(Boolean).join('  |  ');
}
