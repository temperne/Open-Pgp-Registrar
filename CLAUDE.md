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

- **Nothing is stored, and nothing is sent except through a signing room the person
  turns on.** No accounts, no localStorage/IndexedDB/cookies, no analytics in the page.
  Keys and documents exist only in memory while the tab is open. Private keys never
  leave the tab.
- **Signing rooms** (`src/room.ts`, the owner's decision, Nov 2026): the only network
  use. Works only when the page was loaded from exactly the program's address
  (`BRAND.relayUrl`'s origin, https; `roomsAvailableHere`): a saved copy, another host
  or a preview can't open or join rooms and links to the official address instead. Off
  until the person has an unlocked key, agrees to the terms of service and waiver of
  liability (`#room-terms`, `#room-agree`), and turns on "Sign together"; a room link
  shows an invitation at the top of the page and asks before joining. The room key is
  read once at start-up (`INVITED_ROOM`): tab changes rewrite the "#". Messages are AES-GCM encrypted in the tab with a 32-byte key that
  is only in the link after `#`; the relay sees ciphertext and a hashed room name, and
  stores nothing. Participants prove their keys by signing a challenge. The room's
  **settings** (jurisdiction and logo) are the starter's (`room.host`): shared as a
  `settings` message signed with their key (`shareSettings`/`checkSettings`), applied by
  joiners (`applyRoomSettings`, first proven sender wins), and locked for joiners while in
  the room (`settingsLockedByRoom`). Joiners can also paste a room link or code
  (`#room-code`) to join without reloading. A registration in a room offers the proven
  peers' keys (`#co-room`, and a question before the first signature). A signed file's
  original (up to `ROOM_FILE_LIMIT`, 50 MB) goes through the room **once per file hash**
  (`roomFileSent`) as `file-part` messages of `ROOM_FILE_PART` (512 KB, under 1 MB each so
  Cloudflare takes them too), checked against the hash on arrival (`receiveFilePart`);
  later updates carry signatures only, and a late joiner asks with
  `need-file` naming the first signer, who answers at once; the others wait 3-5 s and
  stand down when it arrives.
  **Live editing** (`prep` messages): before anyone signs, changes to the Sign and
  Register forms (`prepFields`: every field with an id in `#text-form`/`#reg-form`, minus
  files and the room's own), the loaded registration, buyers' and co-owners' keys are
  sent as they happen (only what changed, `prepSeen`; a full snapshot to a newcomer) and
  applied as if typed (`applyPrep` dispatches input/change events; never into the focused
  field; the template first, title and text last). On a sale deed, proven peers who
  aren't sellers are offered as buyers (`#buyer-room`).
  **Meetup room** (the owner's decision, Nov 2026): one public room for everyone
  (`SigningRoom.meetup`, fixed `MEETUP_SECRET`, relays allow 500 tabs for its name). Each
  tab sends `hello` and a `profile` signed with its key (name from the key, county,
  optional contact, a fresh P-256 ECDH public key); unsigned or unproven listings are
  ignored. `invite` is encrypted for the invitee alone (`sealFor`/`openFrom`) and signed
  by the inviter; it carries a new private room's key and the county. Accepting joins that
  room, whose settings (and seal: `roomSettings` sends any seal that isn't a built-in
  state seal) come from the inviter. `bye` (signed) removes an entry at once; listings
  refresh every 60 s and expire after 150 s. "My county only" filters by county.
- The production build's Content-Security-Policy allows `connect-src` to `'self'`, the
  relay host in `BRAND.relayUrl`, the master site (`MASTER_URL`, for the update check), the
  master's backup server (`MASTER_FALLBACK_URL`, when relaying through the master) and the
  analytics endpoint **only**. Do not loosen it further.
- **The project's server** (`vps/`, the owner's decision, Nov 2026): `MASTER_FALLBACK_URL`
  (https://securerecorder.csproject.org) is a second official address for pages that relay
  through the master site (`officialOrigins`), and their **first** relay:
  `SigningRoom.connect` tries `relayBases()` in order (the project's server, then the
  master's Cloudflare relay as the backup) and moves on if one doesn't welcome the tab
  within 8 s or closes first. `vps/relay.mjs` speaks the Worker's protocol; it serves
  only the proven page (`update-page.sh` checks the README's SHA-256) and logs nothing.
  Set up with `sh vps/setup.sh` (Debian 13, as root).
- **Update check** (`checkForUpdate`): never on load. Only after the person turns on Sign
  together or allows analytics, and only when the page isn't on `MASTER_URL`: it reads
  the first few KB of `MASTER_URL/?check=1` for the comment the build puts near the top
  of `index.html` (`<!-- S.T.O.P. stop-version=v... built=... -->`), and if it is newer,
  offers `settingsLinkFor(MASTER_URL)` (the same settings as link parameters). The Worker
  answers `?check` with CORS and counts it as `update-check`.
- **Analytics:** (1) server-side in the Worker (Workers Analytics Engine): page loads,
  downloads and rooms by country; (2) Cloudflare Web Analytics in the page **only if the
  visitor allows it** (`#analytics-ask`, asked on every visit on https, never in a saved
  copy; no cookies). Token: `MASTER_ANALYTICS_TOKEN` in `src/brand.ts` (public); county
  copies carry their own or the master's. The CSP allows `script-src
  https://static.cloudflareinsights.com` and `connect-src https://cloudflareinsights.com`
  for it. Never count anything about keys or documents.
- Keys are never published anywhere (no keyservers, no WKD). The public key only
  goes onto the printed registration form.
- Use standard OpenPGP only. Every signature must also verify with stock GnuPG
  (`gpg --verify document.sig document`).
- The build is one self-contained HTML file that works offline from `file://`.

## What it does

1. **Your key**: the key records **who signs with it**, in its OpenPGP user ID, so
   every registration, deed and check builds its signature lines from the key:
   *individual* ("Jane Doe"); *group* ("Jane Doe and John Doe (group: Jane Doe; John
   Doe)": one key, every member signs in ink, notarized and officer-checked; the
   page warns that a shared key cannot prevent fraud between members); or
   *position* in a business, trust or other entity ("Doe Holdings LLC (position:
   Secretary; holder: Jane Doe)": the current holder is named on every signature
   block, so the ink signature and the digital signature match, and the business
   authority verifies them with documentation at registration). When the position
   changes hands, the key tab makes a **position holder update**
   (`signHolderUpdate`, `holderUpdatePdf`): signed with the same key, with a
   signature line and notary acknowledgment for the new holder only, filed with the
   registration. Signing loads holder updates, checks them against the registered
   key, and names the newest holder. See `keyIdentity`,
   `signatoriesForKey`, `signerBlocksForKey`.
   Create an Ed25519 key, which must have a passphrase, or load an
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
   rule and a "Recorder use only" box. **Every key is enumerated**: page 1 lists each
   key (with a QR of all fingerprints), the key page has a code and the armored text
   for every key, and the footer names every key. When the first signer's section
   doesn't fit on page 1, every signer gets their own page. **Everyone who signs the registration** (e.g.
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
   and `stop-registration-N.json` per parcel. **Proof of key possession**: every
   listed key must digitally sign the parcel's registration statement
   (`registrationStatement`: parcel plus keys in fingerprint order, so every holder
   signs the same text). Holders sign on one computer ("Next key holder signs on
   this computer") or apart ("Continue a registration": the PDF embeds
   `stop-registration-draft.json`). The key page prints a COMPLETE / NOT COMPLETE
   banner and the proof as `PGPQ1` codes; the JSON carries `proof`. The check page
   shows each registration's proof status, and a deed check fails unless the
   registration is fully proven (`checkRegistrationProof`). The key tab also offers a **public key
   card** PDF for sharing with co-owners.
   **Jurisdiction** (the owner's decision, Nov 2026): a registration names its county
   (`jurisdiction`, "Pima County, Arizona", fixed from the site's county when the first
   key holder signs) in `registrationStatement` ("JURISDICTION: ..."), its codes' fifth
   field, its JSON and drafts, and a sale's buyers' registration takes the sellers'. New
   documents and files start their signed text with the same line (`jurisdictionLine`).
   Registrations and documents print it as a COUNTY Code 128 barcode
   (`jurisdictionBarcode`; under 30 points tall, never a document ID). The check
   (`verifyScannedText`'s `jurisdiction`) fails a registration or document for another
   county, or one that names none; the Sign tab refuses them (`requireThisCounty`). Keys
   carry no county.
   **Roles**: a registration is for the owner of record (default) or a **lien holder**
   (`role: 'lienholder'`, `interest` names the lien); the role is in
   `registrationStatement`, the codes (the fifth field becomes a JSON object
   `{labels, role, interest, transfer}`; a plain label array is still read) and the
   embedded JSON. A release of lien is checked against the lien holder's registration.
   **Registration by sale** (`transfer`): a warranty or quitclaim deed can name buyers'
   keys (`transferClause`, part of the signed text); the deed PDF embeds them as
   `stop-registration-1.json` with `transfer: {documentId, from}` and prints them as
   `PGPR1` codes. **Every buyer key proves possession** by signing the new
   registration's statement ("Prove my buyer key"; `buyerProof` in the document draft,
   `proof` in the embedded JSON, printed as `PGPQ1` codes on the sale page *before* the
   key codes, so a reader going last page first meets the keys first and waits for
   both groups). Loaded as a registration, it is proven by the deed itself and the
   buyers' proof (`checkTransfer`: every previous key signed the deed, it names the
   parcel and every new key, and every new key signed the statement). The Recorder's index decides which registration or deed is current.
   Templates also include **Release of lien** and **Deregistration** (leave the
   program; signed by every registered key).
3. **Sign** (Exhibit B): the signature covers the document's **text** (title plus
   body), not a file, so it can be checked from paper. Load the parcel's registration
   first (PDF, scan or photo) so the tool knows every owner who must sign, and refuses
   a key that isn't listed, and a recordable document (deed) that doesn't name the
   parcel. A file or a non-recorded document that doesn't name the parcel can be
   signed, with a warning: **for third parties only, not for recording** (also printed
   on the cover / signature page banner). Or tick **Ready this document for parcel
   filing** (`parcelFilingStatement`): a signed statement that the signers sign it for
   use with the registered parcel, put at the start of a document's text or in a
   file's signed text (`fileSignedText`'s third argument, `source.parcelStatement`,
   boxed on the cover), so the check matches the parcel. Pick a template
   (warranty, quitclaim or beneficiary deed, based on A.R.S. 33-402/33-405, or blank)
   and edit freely. The signed bytes are the *canonical* text (`src/text.ts`):
   printable WinAnsi characters, upper-cased, whitespace collapsed. **Several owners
   sign the same text**: on one computer ("Next owner signs on this computer" keeps the
   document while switching keys) or apart ("**Sign exactly as others**": load the
   partly signed PDF, which embeds `stop-document.json`, or a scan or photo of its
   signature page). The text locks after the first signature. Signatures are standard
   detached OpenPGP signatures, concatenated; codes carry
   `PGPDOC2|FPR1,FPR2|sigs|z|text` (one signer: `PGPDOC1`), split into `PGPQ1` codes of
   at most 320 characters. There is no length limit: above `LONG_TEXT` (30,000
   characters) the Sign tab warns with the code and page count (`estimateCodes`) and
   needs "Sign it anyway"; reading stops at `MAX_DECODED_BYTES` while unpacking. The printed instrument has a 2-inch recording margin, the
   title and text, **one complete signature block per signer (signature line with
   that signer's notary acknowledgment directly below; still required)**, then a signature page with every signer, a COMPLETE / NOT COMPLETE
   banner against the registration, the document ID barcode and the codes. The `.txt`
   and `.sig` files verify with stock `gpg` (it checks each signature).
   **Signing a file** ("Sign a file", `src/extract.ts`, `filePackagePdf`): paper is
   the proof, so a file is *recreated* as a printable package and the recreation is
   signed, not the file's bytes. Supported: PDF with text (its pages are reprinted,
   shrunk slightly so nothing is covered), Word .docx and OpenDocument .odt (text
   recreated as plain pages), plain text, images (one page each; several at once),
   and scanned PDFs without text. Images and scans have no text, so the signer writes
   a description or transcription, which is signed and printed after the file. The
   signed text is `fileSignedText`: file name, SHA-256 of the original file(s), page
   count, then the file's text or the description. The package: a **cover page**
   (explanation, document ID barcode, signature codes), the **file's pages**, each
   stamped with the document ID, "page i of n" and a small barcode, and a **final
   page** of ink signature blocks and notary acknowledgments. The originals are
   embedded so the next owner can sign exactly the same package; everything else
   (registration, co-signers, the check, the certificate) works as for documents.
   **Binary file signature** (advanced, `#bin-sign`, `signDocument`): a standard
   detached signature over a file's exact bytes (`.sig`, plus a verification page
   carrying a `PGPSIG1|FPR|sha256|sig` code). The page recommends against it for
   filing: the Recorder takes paper (e-recording goes through approved submitters),
   and paper cannot carry the bytes. It is for files sent directly to third parties
   (a tenant, buyer, bank).
4. **Check a document** (Exhibit C; for Recorder staff and anyone a document is
   given to, such as a tenant checking a lease): load the parcel registration (any owner's form
   PDF, scan or photo; several may be loaded and must agree), then the signature
   codes: scanned in any order, or read from the signed PDF, the Recorder's scan or a
   phone photo. **Several files can be loaded at once** (the filed document and each
   owner's copy): each is listed with its document ID and signature count, every copy
   must carry the same text (a different one fails the check), and their signatures
   are combined. Good only if **every registered key** made a valid signature, no
   unregistered key signed, all over the same text. If the text does not name the
   registered parcel, the result is "signed by the owners, for third parties only:
   not for recording" (`notForRecording`), a warning rather than a failure. When registrations for several parcels are loaded, the parcel
   named in the signed text is used. The signed text is shown for comparison with the
   paper (there is no typed-comparison box). Staff can then print a **verification
   certificate** (`certificatePdf`) listing each scanned copy (same text) and each owner's result, their name, title and
   agency, ink signature and date lines, the document ID barcode, the signed text and
   the codes reprinted. It is appended to the filing. A public key card can stand in
   for the registration (the result then says it was checked against a key only).
   **Combined filing** (`combinedFilingPdf`): two checkboxes add the original (pages
   copied untouched) and the checked copy before the certificate, which lists the page
   ranges and each original's SHA-256.
   **Check a binary-signed file** (`#bin-check`, `verifyBinaryFile`): the file plus
   its `.sig` or verification page (PDF, scan, photo). After any check, a **checked
   copy** (`checkedCopyPdf`) reprints the checked file(s), PDF pages or images, with
   every page stamped with the result, date, document ID, "page i of n" and a barcode.

5. **About the program** (first tab, the default): explains the problem (deed
   fraud and the cost of quiet title), why the program exists, how it works, how it
   solves the problem, and an FAQ.

## Branding

- **Session override** (the header's "Change county or state" button or the seal,
  on every tab, opens `#jurisdiction`;
  `applyJurisdiction` in `brand.ts`): program name, county, state, web address,
  business verification office and logo, in memory only, with an optional settings
  file (`stop-jurisdiction-1`), or from the link (`settingsFromLink`: `name`,
  `expansion`, `county`, `state`, `url`, `authority`, `seal` as a `data:` image only;
  a seal at a web address is refused, never fetched). An override always shows the
  proposed notice for the chosen county.

- Program name, acronym expansion, county, web address (test site:
  https://pimastopinitiative.jasonajensen.workers.dev/) and the proposed/adopted status live in `src/brand.ts`, with
  instructions. They appear on the site and in every PDF footer and header.
- The seal image is embedded in `index.html` (`<img id="brand-seal">`, base64), with
  a comment explaining how to replace it. The PDFs read the seal from there, so
  there is one copy.
- **Adoption list** (`src/adoptions.json`, `src/adoption.ts`; the owner's decision, Nov
  2026): only the project owner adds entries, in this way: an entry, a proven build, a
  deploy. A **state** entry (no county) adopts every county in that state; a **county**
  entry adopts one county; `seal: true` also approves the seal. `refreshStatus()` sets
  `BRAND.status` ('demo' or 'adopted') and `BRAND.sealApproved` for the current county.
  Everywhere not adopted, the site and every PDF say "Demonstration system: not adopted
  by <county>, <state>. Not an official county form." and the seal carries a DEMO band
  (`demoBand` in pdf.ts, `#seal-wrap[data-band]` on the page; "SEAL NOT APPROVED" when
  adopted without the seal). Never mark a place adopted any other way. The About tab
  (`#adoption`) lists adoptions by state and county and, where not adopted, how to ask:
  the county's recording office and board, a letter, and for a state, Open States links
  (find your legislators; `openstates.org/<state>/`) with steps and a letter.
- The 2-inch recording margin on deed page 1 stays free of branding.

## Code maps (PDF417)

Every page the tool prints with QR codes also carries a **code map**: a PDF417
symbol (a different symbology, so the reader can look for it alone) in the left
margin, running up the page from just above the footer (`finish()` in `pdf.ts`
draws it before every save, from the positions `drawQr` recorded). Its text,
`PGPMAP1|<columns>|<document ID or ->|<QR size>|u,v[,size];...` (`codes.ts`),
lists each QR code's corner relative to the map, in map modules, so the reader
works out the scan's scale, position and tilt from the map and cuts each code out
directly. The document ID is the one in the page's body barcode (continuation code
pages inherit it); the check fails a file whose maps name a different document
than its codes. Footer stamps (Code 128) don't count: the tool never reads them.
A page with no map, or a map whose codes don't all decode, still gets the full
search. Keep the map in the left margin, clear of the content (x >= 54).

## Reading codes from files

`src/qrscan.ts` first looks for each page's code map (ZXing, `@zxing/library`):
the left margin strip turned upright (or the right one, for an upside-down scan),
then decodes each listed code from its predicted box (ZXing, then jsQR, trying a
few framings). PDFs are read in two passes: the quick map pass on every page
(last page first, stopping once complete), then the full search only on pages that
need it. The full search: `src/qrscan.ts` reads QR codes from the signed PDF (pdf.js, run in-page by
importing its worker module, so the CSP is unchanged), a scanned PDF, or a photo.
jsQR reads one code at a time, so the reader paints out each code it finds,
searches size-matched tiles, skips white areas, ignores empty or bogus detections
(the seal can fool it), reads pages last-first and stops once complete. Keep
signature codes small (`PART_SIZE` = 320, about version 14): large dense codes fail
at fractional pixel sizes, which real scans and photos produce.

## Worker (`worker/`)

Cloudflare Worker for the hosted site: serves `dist/index.html` (assets binding), relays
signing rooms (`/relay/<room>`, one Durable Object per room, WebSocket hibernation, no
storage, at most 16 tabs and 4 MB per message) and counts usage (`stop_usage` dataset).
Deploy: `cd worker && npm install && npx wrangler deploy` (after `npm run build`). See
`worker/README.md`. `npx wrangler dev` runs it locally (the relay and the page together).

## User guide and release statement

`docs/guide/user-guide.pdf` is built by `scripts/build-guide.mjs` from screenshots that
`scripts/guide-shots.mjs` takes of the built app (served at the official address, with the
proof's test keys and documents). Retake them when the screens change (`npm run build &&
npm run guide:shots && npm run guide`, then build and prove again). The build carries the
guide as `__GUIDE_PDF__` (About tab download; appended to a county's release statement).
Keep the JPEGs small: deploying from a session sends the page inside the Worker script,
which Cloudflare's free plan caps at 3 MB compressed (now about 2.8 MB).
`releaseStatementPdf`: page 1 is the statement (publisher releases version X for the
county, status, what's new, how to use and deploy, ink signature line), page 2 the
verification (hashes, fingerprint, PGPSIG1 code), then the guide.

## The project's server (`vps/`)

The project's VPS (Debian 13): Caddy (https, no access log) in front of `relay.mjs` (Node,
`ws`) on 127.0.0.1:8787, run by systemd as a throwaway user, behind an nftables firewall
(22, 80, 443 only). `setup.sh` installs and updates it; `update-page.sh` installs the page
from the master site only if it matches the README's SHA-256, so deploy to the master
first, then pull and update the VPS. `tests/relay.test.ts` runs the real relay.

## County copies, seals, master site

- **Link API** (GET parameters on the page; documented and built live in the panel's
  "Link settings (API) and link builder"): `name`, `expansion`, `county`, `state`,
  `recorder`, `url`, `authority`, `seal` (data: image only), and a `#tab`.
- **Download this county's program** (`src/deploy.ts`): the page's own HTML captured at
  start-up (`src/pristine.ts`), with a `<script type="application/json" id="stop-config">`
  settings block (read at start-up as that copy's defaults; a copy is always
  "proposed"), the seal swapped in, the CSP's connect-src set to the copy's own address
  (only if "Sign together runs at this address" is ticked; otherwise `MASTER_URL`), and
  the Worker source (`__WORKER_SOURCE__`) with a wrangler.toml and README, zipped.
  Optional **publisher** (`lb-pub-*`, baked in as `publisher`, shown on About) and
  **signing** (`lb-sign`, needs an unlocked key): `signDocument` over the exact
  `index.html` bytes; the zip adds `index.html.sig` and `publisher-key.asc`; a separate
  **release statement** (`releaseStatementPdf`) carries both SHA-256s, the publisher, the
  fingerprint and the `PGPSIG1` code, with the key and .sig attached. The hash never goes
  in the HTML (it would change it). `#bin-check` uses the statement's attached key when no
  registration is loaded.
- **`MASTER_URL`** (`src/brand.ts`, fixed in every copy): the original site. Copies
  without their own rooms send Sign together there; a copy whose relay can't be reached
  offers "Continue this room on the main site" (same room key).
- **State seals** (`src/seals.ts`, generated; credits in SEALS.md and on the page): shown
  when the county isn't the build's default; an uploaded logo wins. Many are insignia.

## County list

`src/counties.ts` is generated from the Census Bureau's 2020 county list (public
domain): every county and equivalent by state, plus each state's usual title for the
office that records deeds (`recordingOffice`, with `OFFICE_EXCEPTIONS`). Titles are
defaults to confirm; the page lets them be corrected. Don't replace it with a
commercial database whose license forbids republishing (simplemaps' free license does).

## Layout

- `src/crypto.ts`: openpgp.js wrappers: generate, read, unlock, sign, payload, verify
- `src/pdf.ts`: pdf-lib layouts for the form, verification page, print copy and backup
- `src/codes.ts`: QR (`qrcode`) and Code 128 (`jsbarcode` encoder) as module data,
  drawn as vector shapes; the PDF417 code map (`bwip-js`) and its text format
- `src/text.ts`: printable-text mapping and the canonical form that gets signed
- `src/templates.ts`: document templates
- `src/extract.ts`: reading files to sign (PDF, Word, OpenDocument, text, images)
- `src/brand.ts`: program name, web address, proposed/adopted notice
- `src/qrscan.ts`: QR reading from PDFs, scans and photos
- `src/main.ts`, `index.html`, `src/style.css`: the UI (plain TypeScript, no framework)
- `tests/`: vitest. Includes GnuPG interop and a test that rasterizes the PDFs and
  decodes the codes with `zbarimg` (both skipped if the tools are missing)

## Versioning

- Versions are `v<major>.<minor>.<mmddyyyy>` (for example `v0.1.11152026`). **Only the
  project owner changes major or minor.** The last part is always the date the
  version is tagged.
- A release: set `version` in `package.json` (without the `v`), move the CHANGELOG's
  Unreleased items under a heading for the version, build, put the printed SHA-256 in
  the README's "Download and verify" table, commit, and tag that commit (annotated
  tag, with the SHA-256 in its message). Two releases on one day: add `-2`, `-3`.
- The build bakes the version, build date and CHANGELOG into the page ("About this
  software" on the About tab, and the footer).

## Build directives (provability)

Every build that is released, or pushed for a pull request, must be proven:

1. `npm run typecheck` and `npm test` pass.
2. Update the CHANGELOG **before** building: it is built into the page, so editing it
   changes the file's SHA-256. (README and CLAUDE.md are not built in.)
3. `npm run proof`: builds `dist/index.html`, then `e2e/proof.mjs` runs the built app in
   Chromium through the full ownership chain and asserts every result:
   - a complex registration (an individual + a group key, both signing)
   - a sale to a group + a company position key, with the grantee filled from the keys;
     the buyers prove their keys (one from the PDF on another computer, one on the
     same computer), and a deed with unproven buyers does not hand over the registration
   - the Recorder's filing in all three forms (original + certificate; original +
     checked copy + certificate; certificate only) and a tilted JPEG scan of it, each
     loaded as the new registration ("proven by sale")
   - the second seller signing on their own computer ("Sign exactly as others")
   - a sale to an individual checked against the previous filing, and the new owner's
     document checked against the certificate-only filing
   - checks that must fail: the new owner's document against the original
     registration, a deed signed by a key that isn't registered, and a Pima County
     registration and deed on a site set to Maricopa County
   - changing the county from the header on another tab, and settings from the link
     (with an embedded seal; "Copy a link" round-trips; a seal at a web address is
     refused with no request)
   - the county selector and recording offices in other states (Texas, Louisiana)
   - the state seal switching with the state, the link builder's link round-tripping,
     and "Download this county's program": the zip's HTML opens as that county (office,
     seal), its CSP allows only its own address, and its PDFs name it
   - a signed release: the statement names the publisher and carries the file's and the
     zip's SHA-256; `gpg --verify` passes; the program's check with the file and the
     statement is GOOD, and a changed file DOES NOT VERIFY
   - four signers in one room (two signing at the same moment; gpg verifies all four), a
     registration signed together in a room (the joiner pastes the link into the page they
     have open, takes the starter's county, and the room's keys are offered and asked
     for), and a file signed together in a room (the file crosses the relay once while
     both sign, and once more for someone who joins afterwards)
   - a 6.9 MB file through a room in parts (each message under 1 MB), checked GOOD
   - a sale in a signing room: the seller adds the buyer from the room (no key file),
     both sellers sign, the buyer proves their key from their own tab, COMPLETE
   - live editing in a room: a loaded registration, the template and fields typed in
     either tab, and the registration form reach the other tab
   - the meetup room: three people listed (proven, county, contact), "My county only",
     a group invitation for one county that switches the invitee from another county,
     and leaving removing an entry at once
   - failover: the project's server refuses, and two tabs (one on each official address)
     move to Cloudflare's relay on their own, sign together and check GOOD
   - the update check: nothing until Sign together is turned on, then one request to the
     master site; a newer version is offered with the same settings, an older one isn't
   - two owners signing together in a signing room through a test relay, with the app
     served at the program's exact address (and a saved copy refused): off until a
     key is unlocked and it is turned on, the link asks first, peers proven by their
     keys, every relay message encrypted, and the result checks GOOD
   - demonstration until adopted: the notice and the DEMO band on the page and the PDFs,
     and the About tab's status, letter and state legislature link
   - the user guide downloads from the About tab, and a release statement carries the
     statement, the verification and the guide
   - usage analytics: asked first on the web, never in a saved copy; nothing loaded
     before an answer or after "No thanks"; only the beacon after "Allow"
   - no page errors and no network requests
4. Every PDF the run made, plus `REPORT.md` (version, run time, the build's SHA-256,
   each check and its files), goes to `proof/<version>/`. Commit that folder. The
   SHA-256 in the report must match the README's "Download and verify" table and the
   file that is published. A failing proof is not released.
5. Any change to the code or the CHANGELOG after the proof means building and proving
   again. Add a step to `e2e/proof.mjs` for any new workflow worth guarding.

## Commands

- `npm run dev`: dev server
- `npm test`: unit, interop and scan tests
- `npm run typecheck`
- `npm run build`: writes `dist/index.html` (single file)
- `npm run proof`: build, then the end-to-end ownership chain in Chromium; writes
  `proof/<version>/` (needs Playwright with Chromium, poppler-utils, ImageMagick)

## Working agreements

- The page must work inside sandboxed previews and embedded viewers. Use
  `type="button"` buttons wired with `action()` in `main.ts`, never rely on form
  submission (sandboxes without `allow-forms` drop it silently), and guard
  `history`/`top` access. Failures must show visibly (the `#boot` banner or the
  form's `[data-error]` slot), never silently.

- Commit after each milestone, and add user-visible changes to `CHANGELOG.md`
  (Unreleased section). Refresh `docs/images` screenshots when the screens change.
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
   Recorder's own wording or form numbers? The project URL is the test site for now.
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
