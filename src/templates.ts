// Starting-point wording for common instruments. These follow the short
// statutory forms in A.R.S. 33-402 (quit claim, convey, warranty) and the
// beneficiary deed statute, A.R.S. 33-405. They are editable starting points,
// not legal advice; the owner should have the final wording checked.

export interface TemplateFields {
  grantor: string;
  grantee: string;
  county: string;
  parcels: string;
  propertyAddress: string;
  legal: string;
  consideration: string;
  date: string;
}

export interface Template {
  id: string;
  label: string;
  title: string;
  /** Short note shown under the picker. */
  note: string;
  /** Which fields the template uses. */
  uses: (keyof TemplateFields)[];
  body(f: TemplateFields): string;
}

const blank = (v: string, what: string) => v.trim() || `[${what}]`;

function property(f: TemplateFields) {
  const lines = [
    `the following real property situated in ${blank(f.county, 'COUNTY')} County, Arizona:`,
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
    id: 'blank',
    label: 'Blank (write your own)',
    title: '',
    note: 'Type or paste the full text of any instrument.',
    uses: [],
    body: () => '',
  },
];

export const DISCLAIMER =
  'Templates are starting points based on Arizona statutory short forms. They are not legal advice. Have the wording checked before recording.';
