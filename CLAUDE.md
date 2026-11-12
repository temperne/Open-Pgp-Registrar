# Project brief: Owner Key Registration Tool

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
   existing key (armored or binary, from GnuPG, Kleopatra, etc.). A locked key is
   unlocked with its passphrase. Users can download the public key, the private key
   (passphrase-protected) and a printable private-key paper backup.
2. **Register** (Exhibit A): a PDF registration form. It covers new or replacement
   registration, owner, parcels, addresses and county, and shows the key type,
   creation date, user ID, fingerprint and a fingerprint QR code. It has an owner
   request statement, an owner signature line and two identity boxes (notary
   acknowledgment and law enforcement attestation), plus the callback rule and a
   "Recorder use only" box. Page 2 attaches the full public key as text and as a
   `PGPKEY1|<base64 binary key>` QR code.
3. **Sign** (Exhibit B): a detached signature over the exact bytes of the chosen
   file. The outputs are a verification-page PDF, an original-plus-verification-page
   print copy (PDF inputs only) and a `.sig` file. The verification page has a QR
   code with `PGPSIG1|FINGERPRINT|sha256hex|base64sig`, a Code 128 barcode with the
   document ID (first 24 hex digits of the SHA-256, uppercase), the payload as text
   for manual entry, and GnuPG instructions.
4. **Check a filing** (Exhibit C): takes the registered public key (scanned, pasted
   or from a file), the signature code (scanned or pasted) and, optionally, the
   document file. The result is good (record), bad (hold, suspected forgery), or
   incomplete (document file still needed).

## Layout

- `src/crypto.ts`: openpgp.js wrappers: generate, read, unlock, sign, payload, verify
- `src/pdf.ts`: pdf-lib layouts for the form, verification page, print copy and backup
- `src/codes.ts`: QR (`qrcode`) and Code 128 (`jsbarcode` encoder) as module data,
  drawn as vector shapes
- `src/main.ts`, `index.html`, `src/style.css`: the UI (plain TypeScript, no framework)
- `tests/`: vitest. Includes GnuPG interop and a test that rasterizes the PDFs and
  decodes the codes with `zbarimg` (both skipped if the tools are missing)

## Commands

- `npm run dev`: dev server
- `npm test`: unit, interop and scan tests
- `npm run typecheck`
- `npm run build`: writes `dist/index.html` (single file)

## Working agreements

- Commit after each milestone.
- Keep the PDFs on US Letter, and use only the standard fonts (WinAnsi). User text is
  passed through `safeText`.
- After any layout change, regenerate the PDFs and look at them, including the
  replacement variant, which has an extra row. Page 1 of the form must stay one page.

## Open questions (for the owner of this project)

1. **Paper vs. file.** The signature covers the exact file. At a paper counter, the
   Recorder can confirm the key fingerprint from the QR alone, but checking the
   signature needs the original file (on USB, by email, or through e-recording).
   Is that acceptable? Or should the signature cover text that can be recovered from
   the paper (for example, a canonical summary of grantor, grantee, parcel and date
   printed on the page)?
2. **Parcel binding.** The parcel number on the verification page is printed but
   not signed. Should it go inside the signature (as an OpenPGP notation), so a
   valid signature can't be moved to another parcel's filing?
3. **Notary certificate space.** Arizona acknowledgment wording is long. Keep the
   box, or put a loose notarial certificate on a separate page?
4. **County wording and branding.** The form says "County Recorder", with an
   optional county name. Should it follow wording or a form number from the actual
   Recorder?
5. **Hosting.** Should it be published (for example, GitHub Pages) or handed out as
   the single HTML file?
6. **Camera scanning.** Handheld scanners work now, because they type into the
   text boxes. Should we add phone-camera QR scanning?
7. **License.** None has been chosen yet.
