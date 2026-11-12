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
   existing key. Loading accepts the private key PDF made by this tool, or an
   armored or binary key file from GnuPG, Kleopatra, etc. A locked key is unlocked
   with its passphrase. **The key's main output is a PDF.** The private key PDF
   embeds the passphrase-protected key file as a PDF attachment (so the tool can
   load it back to sign) and prints it as a QR code and as text. `.asc` downloads
   are a secondary "for GnuPG users" option.
2. **Register** (Exhibit A): a PDF registration form. It covers new or replacement
   registration, owner, parcels, addresses and county, and shows the key type,
   creation date, user ID, fingerprint and a fingerprint QR code. It has an owner
   request statement, an owner signature line and two identity boxes (notary
   acknowledgment and law enforcement attestation), plus the callback rule and a
   "Recorder use only" box. Page 2 attaches the full public key as text and as a
   `PGPKEY1|<base64 binary key>` QR code. The public key is also embedded as an
   attachment, so the Recorder's check can load it straight from the form PDF.
3. **Sign** (Exhibit B): the signature covers the document's **text**, not a file,
   so it can be checked from paper. The owner picks a template (warranty, quitclaim
   or beneficiary deed, based on A.R.S. 33-402/33-405, or blank), fills in the
   fields, and can edit the text freely. The signed bytes are the *canonical* text
   (`src/text.ts`): mapped to printable WinAnsi characters, upper-cased, all
   whitespace collapsed to single spaces. Words, numbers and punctuation count;
   case, line breaks and spacing don't. The output is the printed instrument:
   a 2-inch recording margin on page 1 ("when recorded, mail to"), the title and text,
   **ink signature lines and a notary acknowledgment (still required; the digital
   signature is only an extra layer)**, then a signature page. That page has the
   fingerprint, the document ID (Code 128) and QR codes carrying
   `PGPDOC1|FPR|base64sig|z|base64(deflate-raw(canonical text))`, split into
   `PGPQ1|GROUP|i/n|chunk` codes of at most 700 characters. The `.txt` and `.sig`
   files verify with stock `gpg`. Signing a file byte-for-byte (`PGPSIG1`) remains
   as a secondary option for electronic filing.
4. **Check a filing** (Exhibit C): load the registered public key (scan the form's
   QR code, paste it, or load the registration PDF), then scan every QR code on the
   signature page in any order. Progress shows which codes are missing. The tool
   recovers the signed text, checks the signature, and shows the exact signed text
   for the clerk to compare with the paper. An optional "compare with the paper"
   box shows the first difference. The result is good, bad (hold: suspected
   forgery) or incomplete (codes missing).

## Layout

- `src/crypto.ts`: openpgp.js wrappers: generate, read, unlock, sign, payload, verify
- `src/pdf.ts`: pdf-lib layouts for the form, verification page, print copy and backup
- `src/codes.ts`: QR (`qrcode`) and Code 128 (`jsbarcode` encoder) as module data,
  drawn as vector shapes
- `src/text.ts`: printable-text mapping and the canonical form that gets signed
- `src/templates.ts`: deed templates
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
4. **County wording and branding.** The form says "County Recorder", with an
   optional county name. Should it follow wording or a form number from the actual
   Recorder?
5. **Hosting.** Should it be published (for example, GitHub Pages) or handed out as
   the single HTML file?
6. **Camera scanning.** Handheld scanners work now, because they type into the
   text boxes. Should we add phone-camera QR scanning?
7. **License.** None has been chosen yet.
