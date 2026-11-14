# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Sign a file**: PDF (with text), Word (.docx), OpenDocument (.odt), plain text,
  images (several at once, one page each) and scanned PDFs. The file is recreated as
  a printable package (cover page with the document ID barcode and signature codes;
  the file's pages, each stamped with the document ID and "page i of n"; a final page
  of ink signature blocks and notary acknowledgments) and the recreation is signed,
  so it can be checked from paper. Images and scans are signed with the signer's
  description. Works with registrations, several owners and the check. PDFs are
  recommended (reprinted exactly); Word, OpenDocument and text files are recreated
  as plain text, and the app says so when one is loaded.
- Hosted test site: https://pimastopinitiative.jasonajensen.workers.dev/ (linked from
  the README, and printed on every page and PDF as the program's web address).
- **Binary file signature** (advanced, on the Sign tab): signs a file's exact bytes,
  for files sent directly to a tenant, buyer, bank or other third party. Not for
  recording: the Recorder takes paper, and paper cannot carry a file's bytes. Gives a
  `.sig` (checks with `gpg --verify`) and a verification page with its code.
- **Check a document** (renamed from "Check a filing") invites anyone given a signed
  document, not only Recorder staff, to check it. A public key card can be loaded in
  place of a registration.
- **Check a binary-signed file**: the file plus its `.sig` or verification page (PDF,
  scan or photo).
- **Checked copy**: after a check, download the checked file(s) as a PDF, every page
  (PDF pages and images) stamped with the result, the date, the document ID and the
  page number, with a barcode.

### Fixed
- Signature blocks always follow the signing key's identity: a group key gets a
  signature line and notary acknowledgment for every member, and a position key names
  its holder ("as Secretary of ..."), including for signed files and for documents
  signed without a registration loaded (before, each signature got one block). The
  Sign tab lists who signs in ink before signing; for a document without a
  registration, the lines can still be typed by hand.

## [0.1.0] - 2026-11-12

First working version of the Pima County S.T.O.P. Initiative site (proposed program).

### Added
- **Keys**: Ed25519 OpenPGP keys made in the browser, passphrase required. The key
  records who signs with it: an individual, a group (every named person signs; with a
  warning about fraud between members), or a position in a business, trust or other
  entity with its current holder. Private key PDF (embedded key file, printed key
  codes that load back from a scan or phone photo); public key card for co-owners;
  `.asc` files for GnuPG users.
- **Registration**: one form per parcel listing every key for the parcel (all must
  sign); a signature and identity-verification section per signer (notary plus law
  enforcement officer, or notary plus business authority for positions); Recorder
  callback rule and boxes; the key list as QR codes and embedded data.
- **Proof of key possession**: every listed key digitally signs the registration, on
  one computer or each on their own ("Continue a registration").
- **Position holder updates** signed with the position key and notarized.
- **Signing documents**: the signature covers the document's canonical text, carried
  in the printed QR codes with the signatures, so paper can be checked. Several owners
  sign the same text (same computer, or "Sign exactly as others"). Per-signer
  signature blocks with notary acknowledgments, generated from the registration.
- **Templates**: warranty, quitclaim and beneficiary deeds (Arizona statutory short
  forms); lease; offer to sell or acceptance; statement of ownership; authorization;
  blank. Unrecorded documents print without the recording margin.
- **Checking a filing**: from the signed PDF, a scan, a phone photo, a handheld
  scanner, or several copies at once (all must carry the same text). Requires every
  registered key, no unregistered key, the registered parcel in the text, and a fully
  proven registration. Printable verification certificate for the checker to sign.
- **Electronic filing** option: a byte-for-byte file signature for e-recording.
- **About the program** page, branding (`src/brand.ts`, embedded seal), a "proposed
  program" notice on every page and PDF, and a configurable state, county and entity
  authority for other jurisdictions.
- MIT license with an express grant for government use.

### Security
- Runs entirely in the browser; the built page's Content-Security-Policy blocks all
  network connections. Nothing is stored. Every signature verifies with stock GnuPG.
