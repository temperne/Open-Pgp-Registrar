/**
 * Where the program is adopted (src/adoptions.json, maintained by the project owner and
 * built in, so every activation is a dated, proven build in the repository's history).
 * A state entry adopts every county in that state; a county entry adopts one county.
 * Everywhere else the program runs as a demonstration: a notice on the page and every
 * PDF, and a DEMO band across the seal.
 */
import data from './adoptions.json';

export interface Adoption {
  state: string;
  /** Omitted: the whole state adopted it. */
  county?: string;
  /** The office that records deeds there, as adopted. */
  office?: string;
  /** Date adopted (YYYY-MM-DD). */
  since: string;
  /** The use of the government's seal is approved (no DEMO band). */
  seal?: boolean;
  /** The decision: an ordinance, resolution or statute, for example. */
  authority?: string;
  note?: string;
}

export const ADOPTIONS: Adoption[] = (data as { adoptions: Adoption[] }).adoptions ?? [];

const same = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** The adoption covering this county: its own entry, or its state's. */
export function adoptionFor(state: string, county: string, list: Adoption[] = ADOPTIONS): Adoption | null {
  return list.find((a) => a.county && same(a.state, state) && same(a.county, county)) ?? list.find((a) => !a.county?.trim() && same(a.state, state)) ?? null;
}

/** The list by state, for the About tab: each state's own adoption and its adopted counties. */
export function adoptionsByState(list: Adoption[] = ADOPTIONS) {
  const by = new Map<string, { state?: Adoption; counties: Adoption[] }>();
  for (const a of list) {
    const e = by.get(a.state) ?? { counties: [] };
    if (a.county?.trim()) e.counties.push(a);
    else e.state = a;
    by.set(a.state, e);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
}
