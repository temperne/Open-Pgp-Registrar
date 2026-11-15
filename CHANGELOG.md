# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
`v<major>.<minor>.<mmddyyyy>`: the project owner sets major and minor, and the
last part is the date the version was tagged.

## [Unreleased]

## [v0.1.11152026] - 2026-11-15

### Added (this release)
- **Protection passes with a sale.** Warranty and quitclaim deeds can name any number
  of buyers' signing keys. Their fingerprints are part of the signed deed, and the
  deed PDF carries them as a "registration by sale". Once the deed is recorded, load it
  in place of a registration form (the PDF, a scan or a photo): the tool confirms that
  every previous registered key signed the deed naming the new keys. No separate
  registration or identity check is needed.
  The **Grantee** field fills itself from the buyers' keys: a person's name, every
  member of a group key, or the business or trust for a position key. Wording you
  type yourself is kept.
- **Buyers prove their keys.** As on a registration form, every buyer key signs the new
  registration (on the same computer, or by loading the deed with "Sign exactly as
  others" and choosing "Prove my buyer key"). The deed's registration-by-sale page shows
  COMPLETE / NOT COMPLETE, the Recorder's check reports it, and a deed whose buyers
  haven't all proven their keys doesn't hand over the registration.
- **Lien holder registrations.** "Registering as: Lien holder" names the lien; the role
  is part of the statement every key signs. A new **Release of lien** template is
  checked against the lien holder's registration.
- **Deregistration** template: signed with every registered key, it takes a parcel out
  of the program once recorded.
- **Combined filing PDF.** On the check page, two checkboxes add the original document
  (exactly as loaded) and the checked copy to the certificate download: one PDF in that
  order. The certificate lists the page ranges and each original's SHA-256.
- **Use the tool for another county or state.** The page header shows the county and
  state with a **Change county or state** button (on every tab; clicking the seal works
  too). It changes the
  program name, county, state, web address, business verification office and logo on
  the page, the templates, the notary wording and every PDF, for the session only
  (nothing stored). The program name and business office follow the new county unless
  typed differently. Settings can be saved to a file and loaded again, or **given in the
  link**: `?name=`, `expansion=`, `county=`, `state=`, `url=`, `authority=` and `seal=`
  (the image itself as a `data:image/png;base64,...` address; a seal at a web address is
  refused, because the page never contacts other servers). **Copy a link with these
  settings** builds such a link. The "proposed
  program" notice follows the chosen county.
- **About this software**: the version, build date and full changelog are built into
  the page, with a **Download this tool** link (the page saves itself; hidden when
  opened from a saved copy). The README lists each version's SHA-256.
- **Versions** are now `v<major>.<minor>.<mmddyyyy>`.

### Fixed (this release)
- Loading a finished sale deed with "Sign exactly as others" no longer reopens it for
  signing with the buyers' keys locked in. A document every owner has signed has
  nothing to add: a sale deed is loaded as the new owners' registration instead.
  An unfinished document loads the registration it was started for, and loading a
  different registration while a signed document is open asks before clearing it.
  The registered owners' own keys can't be listed as buyers.
- A co-owner signing on their own computer ("Sign exactly as others") no longer sees a
  false "this registration is not fully signed" warning: the document now carries its
  registration whole, including its proof (or, for a registration by sale, the deed).
- A Recorder's filing made of the certificate only now works as the new owners'
  registration: the certificate reprints the buyers' keys from a sale deed. Loading a
  signed document as a registration explains what to load instead.

### Sign together, county list, analytics (this release)
- **Sign together, live (signing rooms).** Co-owners and buyers sign the same document at
  once, each on their own computer, through the program's relay. It works **only when the
  page was loaded from the program's own address** (a saved copy or another host can't use
  it, and says where to go), needs an unlocked private key and agreement to its **terms of
  service and waiver of liability** (shown in place), and is **off until turned on**; a
  room link shows an invitation and asks before joining. Everything is encrypted in the tab with a key that
  is only in the link (after "#", never sent to a server); participants appear proven by
  their keys. The relay stores nothing. The security policy allows that one host only.
- **County selector:** every U.S. county and county equivalent (U.S. Census Bureau list,
  public domain), Pima County by default. Choosing one fills in its **recording office**
  from the state's usual title (County Recorder, County Clerk, Register of Deeds, Clerk of
  Court, Town Clerk...) with known county exceptions; it can be corrected, and given in a
  link (`recorder=`). Registration forms, certificates and templates name that office, and
  templates write parishes, boroughs and independent cities correctly.
- **State seals:** choosing a county in another state shows that state's seal on the page
  and every PDF (an uploaded logo still wins; Pima County keeps its own). The 50 seals
  come from Wikimedia Commons, credited on the page and in `SEALS.md`. Many are insignia
  whose use states restrict by law, as the page says.
- **Link builder and API documentation:** the county panel documents every link setting
  and builds the link live from the settings as they are, with the tab to open on, the
  logo optionally included, and Copy and Open buttons.
- **Download this county's program:** a zip with the whole program as one HTML file,
  that county's settings (and seal) built in as its defaults, and the Cloudflare Worker
  that serves it, relays its signing rooms and counts its use, with instructions. The
  copy can make the next county's copy. Copies always say "proposed program". The copy's
  web address is its program address; a checkbox runs Sign together there with its own
  Worker. Otherwise, or if its relay can't be reached, Sign together falls back to the
  master site (https://pimastopinitiative.jasonajensen.workers.dev), same room.
- **Signed release statement for a county copy (optional).** The builder can name who is
  making the copy (person or office, title or authority, where the statement will be
  posted) and sign the program file with the maker's key. It then offers a **release
  statement** PDF to post on the maker's website: the program file's and the zip's
  SHA-256, the publisher, the key fingerprint and the signature (QR code, with the key and
  `.sig` attached). The hash can't be inside the file it describes, so it lives in the
  statement. The zip carries `index.html.sig` and `publisher-key.asc`
  (`gpg --verify index.html.sig public/index.html`), and "Check a binary-signed file"
  accepts the statement on its own, using its attached key. The copy's About tab names
  its publisher.
- **Analytics, asked first.** On the web the page asks each visitor whether it may count
  the visit with Cloudflare Web Analytics (no cookies, no cross-site tracking); the beacon
  loads only on "Allow". County copies can use their own token or, by default, the master
  site's. The site's Worker also counts page loads, downloads and signing rooms by
  country on the server (Workers Analytics Engine). Nothing about keys or documents is
  counted. The Worker (`worker/`) also serves the site and the relay.

### Build proof (this release)
- `npm run proof` runs the built app through the full ownership chain (complex
  registration, two sales, every form of the Recorder's filing as the next
  registration, a co-owner signing apart, and checks that must fail) and saves every
  PDF with a report in `proof/<version>/`, tied to the build by its SHA-256.


### Performance
- **Code maps: checking a document is many times faster.** Every page with QR codes
  now also carries a small PDF417 barcode in the left margin listing where each QR
  code is, measured from the map itself, so scaling, shifting and tilt in a scan
  don't matter. The reader finds the map, cuts out each code and decodes it
  directly instead of searching the whole page; pages without a map still get the
  full search, so older documents keep working. On the same 7-page, 25-code
  documents in the browser: a typed document's PDF 6.3 s to 1.5 s, its scan 7.1 s
  to 0.9 s, and a signed file package's scan 28.6 s to 1.4 s. Decoding alone for a
  10-page, 40-code document: 10.3 s to 0.54 s (scan: 11.3 s to 0.71 s).
- The map carries the document ID; a file whose map names a different document
  than its codes fails the check.

### Changed (length)
- **No length limit on signing.** The 30,000-character limit is gone. Above 30,000
  characters the Sign tab shows a warning with the number of QR codes and printed
  pages the signature will need (worked out from the compressed text), and signing
  needs "Sign it anyway" ticked. A 49,000-character, 133-code document checks in
  about 6 seconds.
- Reading codes keeps a safety ceiling (50 million characters, checked while
  unpacking) so crafted codes can't freeze the browser.

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

### Added (parcel filing)
- **Ready this document for parcel filing** (checkbox on the Sign tab, with a
  registration loaded): for a file or document that doesn't list the parcel number,
  adds a signed statement that the signers sign it explicitly for use with the
  registered parcel. It is printed on the first page (a signed file's cover, or the
  start of a document's text) and carried in the codes, so the Recorder's check
  matches it to the parcel.

### Changed
- A file or non-recorded document whose text doesn't name the registered parcel is no
  longer refused. It is signed with a warning, **for third parties only, not for
  recording**, which is also printed on the package's cover. The check shows "Signed by
  the owners. For third parties only: not for recording" instead of failing. Deeds
  and other recordable documents must still name the parcel.

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
