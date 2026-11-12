# Project brief: Pima County S.T.O.P. Initiative (Stop Theft of Property)

## Purpose

A voluntary, no-fee safeguard against forged deeds. A property owner registers an
OpenPGP public signing key with the County Recorder on a paper form. After that, any
instrument filed against the parcel should carry a valid signature from the matching
private key. Anything unsigned, or signed with a key that doesn't match, is held and
investigated instead of being recorded. The Recorder's existing software doesn't
change. The paper process stays as it is, with barcodes and QR codes added.

This app is the optional "simple website" that walks owners through it. It also
gives counter staff a way to check a filing.

## Hard rules

- **Nothing is stored or sent.** No server, no accounts, no analytics, no
  localStorage/IndexedDB/cookies. Keys and documents exist only in memory while
  the tab is open. The production build sets a Content-Security-Policy with
  `connect-src 'none'`. Do not loosen it.
- Keys are never published anywhere (no keyservers, no WKD). The public key only
  goes onto the printed registration form.
- Use standard OpenPGP only. Every signature must also verify with stock GnuPG
  (`gpg --verify document.sig document`).
- The build is one self-contained HTML file that works offline from `file://`.

## What it does

1. **Your key**: create an Ed25519 key, which must have a passphrase, or load an
   existing key. Loading accepts the private key PDF made by this tool, or an
   armored or binary key file from GnuPG, Kleopatra, etc. A locked key is unlocked
   with its passphrase. **The key's main output is a PDF.** The private key PDF
   embeds the passphrase-protected key file as a PDF attachment (so the tool can
   load it back to sign) and prints it as a QR code and as text. `.asc` downloads
   are a secondary "for GnuPG users" option. The printed page carries the key as
   a few large `PGPK1|GROUP|i/n|chunk` codes, so it loads back from a phone photo
   or a scan (the picker accepts images and offers the camera on phones).
2. **Register** (Exhibit A): each owner files their own PDF form, **one per parcel**
   (enter several parcels, get one form each in one PDF). One key can be registered on
   any number of parcels. Each form carries the parcel's complete key list (this
   owner's key plus every co-owner's, added from their public key card, registration
   form, a photo, or a .asc). **Every listed key must sign.** Page 1 covers new or
   replacement registration, owner, parcel, addresses, county, the key's type,
   creation date, user ID, fingerprint and fingerprint QR, the owner request, an
   owner signature line, two identity boxes (notary and law enforcement), the callback
   rule and a "Recorder use only" box. **Everyone who signs the registration** (e.g.
   both spouses sharing one key, a company's officers; "People signing this
   registration", one per line with an optional capacity) gets their own signature
   line, notary box, officer box and Recorder callback box: the first on page 1,
   each additional person on an "Additional Signer" page. Each signer has a **type**:
   an *individual* (notary + law enforcement officer), or someone signing *for a
   business, trust or other entity* (entity name and title; notary + a **business
   authority verification** box, completed by `BRAND.entityAuthority`, which confirms
   from its records that the entity exists and the signer holds the title, and is
   the one the Recorder calls back). The authority is a placeholder setting in
   `src/brand.ts` until the county decides (Arizona corporations and LLCs are
   registered with the Arizona Corporation Commission; trusts are not registered). Page 2 lists every key for the parcel, the key
   list as `PGPR1|GROUP|i/n|chunk` codes (message
   `PGPREG1|b64(parcel)|ALL|b64(concatenated public keys)`), the registrant's
   `PGPKEY1` code and armored key. **Multiple keys are optional for any kind of
   owner** (person, family, trust, company): one key named with a list of names or
   the entity's name is enough, or several keys, each with an optional free
   **description** ("Trustee", "Beneficiary"...) carried in the codes (a fifth field,
   `b64(JSON labels)`), the embedded JSON (`labels`), signer lists and the
   certificate. A person at the Recorder judges whether the structure fits. The PDF embeds `public-key.asc` (the registrant)
   and `stop-registration-N.json` per parcel. The key tab also offers a **public key
   card** PDF for sharing with co-owners.
3. **Sign** (Exhibit B): the signature covers the document's **text** (title plus
   body), not a file, so it can be checked from paper. Load the parcel's registration
   first (PDF, scan or photo) so the tool knows every owner who must sign, and refuses
   a key that isn't listed or text that doesn't name the parcel. Pick a template
   (warranty, quitclaim or beneficiary deed, based on A.R.S. 33-402/33-405, or blank)
   and edit freely. The signed bytes are the *canonical* text (`src/text.ts`):
   printable WinAnsi characters, upper-cased, whitespace collapsed. **Several owners
   sign the same text**: on one computer ("Next owner signs on this computer" keeps the
   document while switching keys) or apart ("**Sign exactly as others**": load the
   partly signed PDF, which embeds `stop-document.json`, or a scan or photo of its
   signature page). The text locks after the first signature. Signatures are standard
   detached OpenPGP signatures, concatenated; codes carry
   `PGPDOC2|FPR1,FPR2|sigs|z|text` (one signer: `PGPDOC1`), split into `PGPQ1` codes of
   at most 320 characters. The printed instrument has a 2-inch recording margin, the
   title and text, **ink signature lines and a notary acknowledgment for each signer
   (still required)**, then a signature page with every signer, a COMPLETE / NOT COMPLETE
   banner against the registration, the document ID barcode and the codes. The `.txt`
   and `.sig` files verify with stock `gpg` (it checks each signature). Signing a file
   byte for byte (`PGPSIG1`) remains for electronic filing (single signer).
4. **Check a filing** (Exhibit C): load the parcel registration (any owner's form
   PDF, scan or photo; several may be loaded and must agree), then the signature
   codes: scanned in any order, or read from the signed PDF, the Recorder's scan or a
   phone photo. Good only if **every registered key** made a valid signature, no
   unregistered key signed, all over the same text, and that text names the
   registered parcel. When registrations for several parcels are loaded, the parcel
   named in the signed text is used. The signed text is shown for comparison with the
   paper (there is no typed-comparison box). Staff can then print a **verification
   certificate** (`certificatePdf`) with each owner's result, their name, title and
   agency, ink signature and date lines, the document ID barcode, the signed text and
   the codes reprinted. It is appended to the filing.

5. **About the program** (first tab, the default): explains the problem (deed
   fraud and the cost of quiet title), why the program exists, how it works, how it
   solves the problem, and an FAQ.

## Branding

- Program name, acronym expansion, county, web address (`[PROJECT URL]`
  placeholder) and the proposed/adopted status live in `src/brand.ts`, with
  instructions. They appear on the site and in every PDF footer and header.
- The seal image is embedded in `index.html` (`<img id="brand-seal">`, base64), with
  a comment explaining how to replace it. The PDFs read the seal from there, so
  there is one copy.
- While `status` is `'proposed'`, the site and every PDF say "Proposed program: not
  yet adopted by Pima County. Not an official county form." Switch it to `'adopted'`
  only once the county has adopted the program and approved use of its seal.
- The 2-inch recording margin on deed page 1 stays free of branding.

## Reading codes from files

`src/qrscan.ts` reads QR codes from the signed PDF (pdf.js, run in-page by
importing its worker module, so the CSP is unchanged), a scanned PDF, or a photo.
jsQR reads one code at a time, so the reader paints out each code it finds,
searches size-matched tiles, skips white areas, ignores empty or bogus detections
(the seal can fool it), reads pages last-first and stops once complete. Keep
signature codes small (`PART_SIZE` = 320, about version 14): large dense codes fail
at fractional pixel sizes, which real scans and photos produce.

## Layout

- `src/crypto.ts`: openpgp.js wrappers: generate, read, unlock, sign, payload, verify
- `src/pdf.ts`: pdf-lib layouts for the form, verification page, print copy and backup
- `src/codes.ts`: QR (`qrcode`) and Code 128 (`jsbarcode` encoder) as module data,
  drawn as vector shapes
- `src/text.ts`: printable-text mapping and the canonical form that gets signed
- `src/templates.ts`: deed templates
- `src/brand.ts`: program name, web address, proposed/adopted notice
- `src/qrscan.ts`: QR reading from PDFs, scans and photos
- `src/main.ts`, `index.html`, `src/style.css`: the UI (plain TypeScript, no framework)
- `tests/`: vitest. Includes GnuPG interop and a test that rasterizes the PDFs and
  decodes the codes with `zbarimg` (both skipped if the tools are missing)

## Commands

- `npm run dev`: dev server
- `npm test`: unit, interop and scan tests
- `npm run typecheck`
- `npm run build`: writes `dist/index.html` (single file)

## Working agreements

- The page must work inside sandboxed previews and embedded viewers. Use
  `type="button"` buttons wired with `action()` in `main.ts`, never rely on form
  submission (sandboxes without `allow-forms` drop it silently), and guard
  `history`/`top` access. Failures must show visibly (the `#boot` banner or the
  form's `[data-error]` slot), never silently.

- Commit after each milestone.
- Keep the PDFs on US Letter, and use only the standard fonts (WinAnsi). User text is
  passed through `safeText`.
- After any layout change, regenerate the PDFs and look at them, including the
  replacement variant, which has an extra row. Page 1 of the form must stay one page.

## Open questions (for the owner of this project)

1. **Paper vs. file.** Resolved: the signature now covers the document's canonical
   text, and the text travels in the QR codes.
2. **Parcel binding.** Resolved for text documents: the parcel number is part of
   the signed text. OCR (for example Tesseract.js, bundled for offline use) could
   later fill the "compare with the paper" box automatically.
3. **Notary certificate space.** Arizona acknowledgment wording is long. Keep the
   box, or put a loose notarial certificate on a separate page?
4. **County wording and branding.** Branded as the Pima County S.T.O.P. Initiative,
   with the county seal and a "proposed program" notice. Before adoption: is the
   county's permission to use its seal in hand? Should the forms follow the
   Recorder's own wording or form numbers? The project URL is still a placeholder.
5. **Hosting.** Should it be published (for example, GitHub Pages) or handed out as
   the single HTML file?
6. **Camera scanning.** Not needed for now: the Recorder already scans every
   document it records, and "Check a filing" accepts that scan (PDF or image) and
   reads all the codes from it. Handheld scanners also work. Live phone-camera
   scanning could be added later if counter staff want it.
8. **Entity verification.** Which office confirms business and trust signers
   (`BRAND.entityAuthority`, currently "Pima County Business Licensing Authority")?
   Should trusts use a certification of trust instead?
7. **License.** Resolved: MIT with an express government-use grant (see `LICENSE`),
   shown in README.md and the site footer. Keep all three in sync if it changes.
