// A registration and a document name their county in the signed text; another county's site refuses them.
import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  signText,
  signRegistration,
  registrationStatement,
  verifyScannedText,
  jurisdictionOf,
  sameJurisdiction,
  encodeRegistrationCodes,
  decodeRegistrationCodes,
  checkRegistrationProof,
  type Registration,
} from '../src/crypto';

let key: openpgp.PrivateKey;
let reg: Registration;
const PIMA = 'Pima County, Arizona';
const MARICOPA = 'Maricopa County, Arizona';

beforeAll(async () => {
  const { privateArmored } = await generateKeyPair({ name: 'County Test', passphrase: 'pw-123456' });
  key = await unlockKey((await readAnyKey(privateArmored)) as openpgp.PrivateKey, 'pw-123456');
  reg = { parcel: '123-45-678', keys: [key.toPublic()], jurisdiction: PIMA };
  reg.proof = await signRegistration(key, reg);
});

const deed = (county: string) => `JURISDICTION: ${county}.\n\nWARRANTY DEED. Parcel 123-45-678. The grantor conveys the property.`;

describe('jurisdiction', () => {
  it('is part of the registration statement every key signs', () => {
    expect(registrationStatement(reg)).toContain(`JURISDICTION: ${PIMA}.`);
    // The same keys for another county are a different statement, so the proof doesn't carry over.
    expect(registrationStatement({ ...reg, jurisdiction: MARICOPA })).not.toBe(registrationStatement(reg));
  });

  it('travels in the registration codes and keeps the proof valid', async () => {
    const back = await decodeRegistrationCodes((await encodeRegistrationCodes(reg)).join('\n'));
    expect(back.jurisdiction).toBe(PIMA);
    expect((await checkRegistrationProof({ ...back, proof: reg.proof })).complete).toBe(true);
    // Claiming another county breaks the proof.
    expect((await checkRegistrationProof({ ...back, jurisdiction: MARICOPA, proof: reg.proof })).complete).toBe(false);
  });

  it('reads the county from signed text, however it is written', () => {
    expect(jurisdictionOf('JURISDICTION: PIMA COUNTY, ARIZONA. WARRANTY DEED')).toBe('PIMA COUNTY, ARIZONA');
    expect(sameJurisdiction('PIMA COUNTY, ARIZONA', PIMA)).toBe(true);
    expect(sameJurisdiction(MARICOPA, PIMA)).toBe(false);
  });

  it('checks GOOD on the right county and fails on another', async () => {
    const signed = await signText(key, deed(PIMA));
    const good = await verifyScannedText({ scanned: signed.codes.join('\n'), registration: reg, jurisdiction: PIMA });
    expect(good.verdict).toBe('good');
    const elsewhere = await verifyScannedText({ scanned: signed.codes.join('\n'), registration: reg, jurisdiction: MARICOPA });
    expect(elsewhere.verdict).toBe('bad');
    expect(elsewhere.checks.find((c) => c.label === 'Registration county')?.state).toBe('fail');
    expect(elsewhere.checks.find((c) => c.label === 'Document county')?.state).toBe('fail');
  });

  it('fails a document made for another county, even against a matching registration', async () => {
    const signed = await signText(key, deed(MARICOPA));
    const r = await verifyScannedText({ scanned: signed.codes.join('\n'), registration: reg, jurisdiction: PIMA });
    expect(r.verdict).toBe('bad');
    expect(r.checks.find((c) => c.label === 'Document county')?.detail).toMatch(/MARICOPA/i);
  });
});
