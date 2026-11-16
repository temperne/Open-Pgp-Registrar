import { describe, it, expect } from 'vitest';
import { adoptionFor, adoptionsByState, ADOPTIONS, type Adoption } from '../src/adoption';

const list: Adoption[] = [
  { state: 'Arizona', since: '2027-01-15', seal: true },
  { state: 'Texas', county: 'Harris County', since: '2027-03-01' },
];

describe('adoption list', () => {
  it('a state adopts every county in it', () => {
    expect(adoptionFor('Arizona', 'Pima County', list)?.since).toBe('2027-01-15');
    expect(adoptionFor('arizona', 'Maricopa County', list)?.seal).toBe(true);
  });
  it('a county adopts on its own; its neighbours stay demonstrations', () => {
    expect(adoptionFor('Texas', 'Harris County', list)?.county).toBe('Harris County');
    expect(adoptionFor('Texas', 'Dallas County', list)).toBeNull();
    expect(adoptionFor('Louisiana', 'Orleans Parish', list)).toBeNull();
  });
  it('lists by state', () => {
    const by = adoptionsByState(list);
    expect(by.map(([s]) => s)).toEqual(['Arizona', 'Texas']);
    expect(by[0][1].state?.since).toBe('2027-01-15');
    expect(by[1][1].counties[0].county).toBe('Harris County');
  });
  it('the built-in list is well formed', () => {
    for (const a of ADOPTIONS) {
      expect(a.state).toBeTruthy();
      expect(a.since).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
  });
});
