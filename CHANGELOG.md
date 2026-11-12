# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
