// Starting-point wording for common instruments. These follow the short
// statutory forms in A.R.S. 33-402 (quit claim, convey, warranty) and the
// beneficiary deed statute, A.R.S. 33-405. They are editable starting points,
// not legal advice; the owner should have the final wording checked.

import { BRAND } from './brand';

export interface TemplateFields {
  grantor: string;
  grantee: string;
  county: string;
  parcels: string;
  propertyAddress: string;
  legal: string;
  consideration: string;
  date: string;
  /** Free terms: lease terms, offer conditions, purpose, what is authorized. */
  terms: string;
}

export interface Template {
  id: string;
  label: string;
  title: string;
  /** Short note shown under the picker. */
  note: string;
  /** Which fields the template uses. */
  uses: (keyof TemplateFields)[];
  /** Field labels for this template, where they differ from the deed wording. */
  labels?: Partial<Record<keyof TemplateFields, string>>;
  /** Recorded with the County Recorder (deeds): printed with the 2-inch recording margin. */
  recordable: boolean;
  body(f: TemplateFields): string;
}

const blank = (v: string, what: string) => v.trim() || `[${what}]`;

function property(f: TemplateFields) {
  const lines = [
    `the following real property situated in ${blank(f.county, 'COUNTY')} County, ${BRAND.state}:`,
    '',
    blank(f.legal, 'LEGAL DESCRIPTION'),
    '',
    `Assessor's Parcel Number: ${blank(f.parcels, 'PARCEL NUMBER')}`,
  ];
  if (f.propertyAddress.trim()) lines.push(`Property address: ${f.propertyAddress.trim()}`);
  return lines.join('\n');
}

const dated = (f: TemplateFields) => `Dated: ${blank(f.date, 'DATE')}`;

export const TEMPLATES: Template[] = [
  {
    id: 'warranty',
    label: 'Warranty deed',
    title: 'WARRANTY DEED',
    note: 'Conveys the property and warrants the title. Based on the short form in A.R.S. 33-402.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'legal', 'consideration', 'date'],
    recordable: true,
    body: (f) =>
      [
        `For the consideration of ${blank(f.consideration, 'CONSIDERATION')}, ${blank(f.grantor, 'GRANTOR')}, Grantor, hereby conveys to ${blank(f.grantee, 'GRANTEE')}, Grantee, ${property(f)}`,
        '',
        'And the Grantor warrants the title against all persons whomsoever.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'quitclaim',
    label: 'Quitclaim deed',
    title: 'QUIT CLAIM DEED',
    note: 'Gives up whatever interest the grantor has, with no warranty. Based on the short form in A.R.S. 33-402.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'legal', 'consideration', 'date'],
    recordable: true,
    body: (f) =>
      [
        `For the consideration of ${blank(f.consideration, 'CONSIDERATION')}, ${blank(f.grantor, 'GRANTOR')}, Grantor, hereby quit claims to ${blank(f.grantee, 'GRANTEE')}, Grantee, all of the Grantor's interest in ${property(f)}`,
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'beneficiary',
    label: 'Beneficiary deed',
    title: 'BENEFICIARY DEED',
    note: 'Passes the property on the owner’s death (A.R.S. 33-405). Have this one checked carefully before recording.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'legal', 'date'],
    recordable: true,
    body: (f) =>
      [
        `${blank(f.grantor, 'OWNER')}, Owner, hereby conveys to ${blank(f.grantee, 'GRANTEE BENEFICIARY')}, Grantee Beneficiary, effective on the death of the Owner, ${property(f)}`,
        '',
        'This beneficiary deed is made under A.R.S. 33-405. The Owner may revoke it as provided in that section. It is not effective until the death of the Owner.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'lease',
    label: 'Lease agreement',
    title: 'LEASE AGREEMENT',
    note: 'The owner signs with the key registered for the parcel, so a tenant can confirm the lease really comes from the owner of record. Not recorded. Arizona landlord-tenant law adds requirements; have the terms checked.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'consideration', 'terms', 'date'],
    labels: { grantor: 'Owner and landlord', grantee: 'Tenant', consideration: 'Rent', terms: 'Lease terms (dates, deposit, rules)' },
    recordable: false,
    body: (f) =>
      [
        `${blank(f.grantor, 'OWNER')}, owner of record and Landlord, leases to ${blank(f.grantee, 'TENANT')}, Tenant, the property situated in ${blank(f.county, 'COUNTY')} County, ${BRAND.state}, Assessor's Parcel Number ${blank(f.parcels, 'PARCEL NUMBER')}${f.propertyAddress.trim() ? `, ${f.propertyAddress.trim()}` : ''}.`,
        '',
        `Rent: ${blank(f.consideration, 'RENT')}.`,
        '',
        `Terms: ${blank(f.terms, 'LEASE TERMS')}`,
        '',
        'The Landlord signs with the signing key registered for this parcel with the County Recorder, so the Tenant can confirm that the owner of record made this lease.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'offer',
    label: 'Offer or acceptance (sale)',
    title: 'OFFER TO SELL',
    note: 'An owner\u2019s offer to sell, or acceptance of a buyer\u2019s offer, signed with the registered key so the buyer can confirm it comes from the owner of record. Not recorded. Purchase contracts usually use a standard form; have it checked.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'consideration', 'terms', 'date'],
    labels: { grantor: 'Owner and seller', grantee: 'Buyer', consideration: 'Price', terms: 'Terms and conditions' },
    recordable: false,
    body: (f) =>
      [
        `${blank(f.grantor, 'OWNER')}, owner of record, offers to sell to ${blank(f.grantee, 'BUYER')} (or accepts the offer of ${blank(f.grantee, 'BUYER')} to buy) the property situated in ${blank(f.county, 'COUNTY')} County, ${BRAND.state}, Assessor's Parcel Number ${blank(f.parcels, 'PARCEL NUMBER')}${f.propertyAddress.trim() ? `, ${f.propertyAddress.trim()}` : ''}, for ${blank(f.consideration, 'PRICE')}.`,
        '',
        `Terms and conditions: ${blank(f.terms, 'TERMS')}`,
        '',
        'Signed with the signing key registered for this parcel with the County Recorder, so the buyer can confirm that the owner of record made this offer.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'ownership',
    label: 'Proof of ownership statement',
    title: 'STATEMENT OF OWNERSHIP',
    note: 'Shows a bank, buyer, tenant, utility or agency that you control the property: anyone can check the signature against the Recorder\u2019s registration. Not recorded.',
    uses: ['grantor', 'county', 'parcels', 'propertyAddress', 'terms', 'date'],
    labels: { grantor: 'Owner(s) of record', terms: 'Purpose and who it is for' },
    recordable: false,
    body: (f) =>
      [
        `${blank(f.grantor, 'OWNER')} is the owner of record of the property situated in ${blank(f.county, 'COUNTY')} County, ${BRAND.state}, Assessor's Parcel Number ${blank(f.parcels, 'PARCEL NUMBER')}${f.propertyAddress.trim() ? `, ${f.propertyAddress.trim()}` : ''}.`,
        '',
        `Purpose: ${blank(f.terms, 'PURPOSE')}`,
        '',
        'This statement is signed with the signing key registered for this parcel with the County Recorder. The signature can be checked against that registration.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'authorization',
    label: 'Authorization (agent, manager, contractor)',
    title: 'AUTHORIZATION',
    note: 'Authorizes someone, such as a property manager, agent or contractor, to act for the owner on the property. Not recorded. Do not use this in place of a recorded power of attorney.',
    uses: ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'terms', 'date'],
    labels: { grantor: 'Owner(s) of record', grantee: 'Authorized person or company', terms: 'What is authorized, and until when' },
    recordable: false,
    body: (f) =>
      [
        `${blank(f.grantor, 'OWNER')}, owner of record of the property situated in ${blank(f.county, 'COUNTY')} County, ${BRAND.state}, Assessor's Parcel Number ${blank(f.parcels, 'PARCEL NUMBER')}${f.propertyAddress.trim() ? `, ${f.propertyAddress.trim()}` : ''}, authorizes ${blank(f.grantee, 'AUTHORIZED PERSON')} to act as follows:`,
        '',
        blank(f.terms, 'WHAT IS AUTHORIZED, AND UNTIL WHEN'),
        '',
        'Signed with the signing key registered for this parcel with the County Recorder. This authorization does not convey any interest in the property.',
        '',
        dated(f),
      ].join('\n'),
  },
  {
    id: 'blank',
    label: 'Blank (write your own)',
    title: '',
    note: 'Type or paste the full text of any document.',
    uses: [],
    recordable: true,
    body: () => '',
  },
];

export const DISCLAIMER =
  'Templates are starting points based on Arizona statutory short forms. They are not legal advice. Have the wording checked before recording.';
