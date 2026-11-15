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
/**
 * The master site's Cloudflare Web Analytics token (public; it is in every visitor's
 * page). Fixed in every build and copy: county copies that don't set their own count
 * with this one. '' leaves analytics off. From the Cloudflare dashboard, Web Analytics.
 */
export const MASTER_ANALYTICS_TOKEN = '';

export const BRAND = {
  /** Full program name. */
  name: 'Pima County S.T.O.P. Initiative',
  /** What the acronym stands for. */
  expansion: 'Stop Theft of Property',
  /** County that runs the Recorder's office (used as the default county). */
  county: 'Pima County',
  /** State: used in the deed templates ("... County, Arizona") and the notary venue ("STATE OF ARIZONA"). */
  state: 'Arizona',
  /**
   * The office that records deeds in this county, as it calls itself (it differs
   * by state and by county: County Recorder, County Clerk, Register of Deeds...).
   * Used on the registration form, the certificate and in the templates.
   */
  recorderOffice: 'Pima County Recorder',
  /**
   * Program web address, printed on every PDF and linked from the site.
   * The test site for now; replace it with the official address once there is one, e.g.
   * 'https://www.example.gov/stop'.
   */
  projectUrl: 'https://pimastopinitiative.jasonajensen.workers.dev/',
  /**
   * Office that confirms a business, trust or other entity signer: that the
   * entity exists and the person holds the title they sign with. It signs the
   * "Business authority verification" box on registrations, and the Recorder
   * calls it back. PLACEHOLDER until the county decides. (Arizona corporations
   * and LLCs are registered with the Arizona Corporation Commission; trusts are
   * not registered anywhere, so trusts may need a certification of trust.)
   */
  entityAuthority: 'Pima County Business Licensing Authority',
  /**
   * 'proposed' prints the notice below on the site and every PDF, so nobody
   * mistakes these documents for official county forms before the program is
   * adopted. Change to 'adopted' only once the county has approved the program
   * (and the use of its seal).
   */
  status: 'proposed' as 'proposed' | 'adopted',
  /**
   * Signing rooms: the relay that passes encrypted messages between co-owners'
   * tabs (worker/ in this repository, deployed with Cloudflare). The page may
   * connect only to this host (the build's Content-Security-Policy allows it and
   * nothing else), and only when someone starts or joins a room. '' turns
   * signing rooms off.
   */
  relayUrl: 'https://pimastopinitiative.jasonajensen.workers.dev',
  /**
   * Cloudflare Web Analytics site token (public: it is in every visitor's page). The
   * page asks each visitor first and loads the beacon only if they allow it. ''
   * leaves analytics off. Get it from the Cloudflare dashboard, Web Analytics, after
   * adding the site. County copies use this one unless they give their own.
   */
  analyticsToken: MASTER_ANALYTICS_TOKEN,
  proposedNotice: 'Proposed program: not yet adopted by Pima County. Not an official county form.',
};

/**
 * The program's master address (the original site). Fixed in every build and copy: a
 * county copy whose own signing rooms can't be reached falls back to it, and copies
 * without their own rooms send people there.
 */
export const MASTER_URL = 'https://pimastopinitiative.jasonajensen.workers.dev';

/** The values as built, so an override can be undone. */
export const BRAND_DEFAULTS = { ...BRAND };

/** What can be changed on the page to use the tool for another county or state. */
export interface Jurisdiction {
  name: string;
  /** What the acronym stands for. */
  expansion: string;
  county: string;
  state: string;
  /** The office that records deeds there (e.g. "Harris County Clerk"). */
  recorderOffice: string;
  projectUrl: string;
  entityAuthority: string;
}

/**
 * Uses the tool for another county or state, until the page is closed (nothing
 * is stored). An overridden jurisdiction is always shown as a proposed program:
 * only a county's own build can say it has adopted it.
 */
export function applyJurisdiction(j: Partial<Jurisdiction> | null) {
  Object.assign(BRAND, BRAND_DEFAULTS);
  if (!j) return;
  for (const k of ['name', 'expansion', 'county', 'state', 'recorderOffice', 'projectUrl', 'entityAuthority'] as const) {
    const v = j[k]?.trim();
    if (v) BRAND[k] = v;
  }
  const changed = (['name', 'county', 'state'] as const).some((k) => BRAND[k] !== BRAND_DEFAULTS[k]);
  if (changed) {
    BRAND.status = 'proposed';
    BRAND.proposedNotice = `Proposed program: not yet adopted by ${BRAND.county}. Not an official county form.`;
  }
}

/** Text for the PDF footers. */
export function brandLine() {
  const parts = [`${BRAND.name} (${BRAND.expansion})`, BRAND.projectUrl];
  if (BRAND.status === 'proposed') parts.push(BRAND.proposedNotice);
  return parts.filter(Boolean).join('  |  ');
}
