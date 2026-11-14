# Pima County S.T.O.P. Initiative (Stop Theft of Property)

A free, voluntary safeguard against **deed fraud and title theft**. A property owner
registers a digital signing key with the County Recorder once. After that, any deed
filed against the parcel has to carry that key's signature. A forged deed without it
is held for investigation instead of being recorded.

This repository is the **website that makes it work**: owners create keys, register
them and sign documents, and Recorder staff check filings. It is a single HTML file
that runs entirely in the browser, works offline, and **stores and sends nothing**.

**Try it: https://pimastopinitiative.jasonajensen.workers.dev/**

> **Status: proposed.** The program has not been adopted by Pima County. Every page
> and PDF says so until the county adopts it (see [Rebranding](#rebranding-for-another-jurisdiction)).

![About the program](docs/images/01-about.png)

## Contents

- [The problem it solves](#the-problem-it-solves)
- [Features](#features)
- [How to use it](#how-to-use-it): [owners](#for-owners) and [Recorder staff](#for-recorder-staff)
- [What the printed documents look like](#what-the-printed-documents-look-like)
- [Security model and limits](#security-model-and-limits)
- [Rebranding for another jurisdiction](#rebranding-for-another-jurisdiction)
- [Running, hosting and development](#running-hosting-and-development)
- [Changelog](CHANGELOG.md) and [License](#license)

## The problem it solves

In deed fraud, someone forges an owner's signature, often with a forged notary stamp
too, records a deed, and then sells or borrows against a property they don't own.
Once recorded, the transfer can't simply be undone: the real owner has to bring a
quiet title action in court, which is slow and expensive.

With S.T.O.P., the owner's **digital signature** (OpenPGP, an open standard used for
decades) must appear on any deed for a registered parcel. Only the holder of the
private key and its passphrase can make it. It prints on paper as QR codes that carry
the signature **and the exact text that was signed**, so the Recorder can check a
paper filing by scanning it. The existing paper process is unchanged; the ink
signatures and notarizations are still required. The digital signature is an extra
layer on equal footing with them.

## Features

**For owners**
- **Keys that say who signs with them**: an individual; a **group** (one key, every
  named person signs, e.g. a married couple, with a clear warning that a shared key
  can't prevent fraud between members); or a **position** in a business, trust or
  other entity (e.g. the Secretary of an LLC), naming its current holder.
- **The private key is a PDF**: print it for a safe, keep the file on a USB drive.
  It loads back from the PDF, a scan, or a **phone photo** of the printed page.
- **Registration forms, one per parcel**, listing every key for the parcel (all must
  sign), with a signature and identity-verification section for every signer: notary
  plus law enforcement officer for individuals, notary plus a business authority for
  position holders.
- **Proof of key possession**: every listed key digitally signs the registration
  itself, on one computer or each on their own.
- **Position holder updates**: when a position changes hands, the new holder signs a
  short update with the same key, notarized, filed with the registration.
- **Document templates**: warranty, quitclaim and beneficiary deeds (from Arizona's
  statutory short forms), plus a lease, an offer to sell or acceptance, a statement of
  ownership, and an authorization, or blank. Signature lines and a notary
  acknowledgment for every signer are generated from the registration.
- **Sign a file**: a PDF, Word (.docx), OpenDocument (.odt) or text file, one or
  more images, or a scanned PDF. It is recreated as a printable package (a cover page
  with the signature codes, the file's pages each stamped with the document ID and
  page number, and a signatures page) and that recreation is what's signed, so it
  can be checked from paper. Images and scans are signed with the signer's written
  description of them.
- **Binary file signature** (advanced): signs a file's exact bytes, for files sent
  directly to a tenant, buyer or bank. Not for recording: the Recorder takes paper.
- **Several owners, one document**: owners sign the same text on one computer, or
  pass the partly signed PDF along ("Sign exactly as others"). The text locks after
  the first signature.

**For the Recorder, and anyone given a signed document**
- **Check a document** from the signed PDF, the Recorder's own scan, a phone photo, or
  a handheld scanner. Several copies can be checked together; all must carry the same
  text.
- The check requires **every registered key** to have signed **the same text**, **no
  unregistered key**, the **registered parcel** named in the text, and a **fully
  proven registration**. The signed text is shown to compare with the paper.
- A printable **verification certificate** for the checker to sign and append to the
  filing.
- A **checked copy**: the checked file (PDF pages or images), every page stamped with
  the result, the date and the document ID.
- Tenants, buyers and banks can check a lease, offer or statement against the owner's
  registration or public key card, and check binary-signed files.

**Built to be trusted**
- Runs entirely in the browser; a Content-Security-Policy blocks every network
  connection. No server, no accounts, nothing stored.
- Standard OpenPGP: every signature also verifies with stock GnuPG.
- One self-contained HTML file that works offline.
- Free and open source, with an express license grant for governments.

## How to use it

Open the site (or the downloaded `index.html`) in Chrome, Edge, Safari or Firefox.
Opening it inside an email or chat preview may block downloads; open it directly.

### For owners

**1. Create your key.** Choose who signs with it, enter the name(s), and a passphrase.
Download the **private key PDF** and keep it safe; the site keeps nothing. Give
co-owners your **public key card** so they can list your key.

| Create a key | Your key |
|---|---|
| ![Create a key](docs/images/02-create-key.png) | ![Your key](docs/images/03-your-key.png) |

**2. Register.** Enter the parcel number(s) (one form per parcel) and add any other
keys for the parcels (optional: one key is enough for any owner). Choose **Sign the
registration with my key**. If there are other keys, each holder signs too, on the
same computer or by loading the partly signed PDF with **Continue a registration**.
Print the form; each signer signs in ink before a notary and has their identity
checked; file it with the Recorder.

| Registration form | Every key has signed |
|---|---|
| ![Register](docs/images/04-register.png) | ![Registration signed](docs/images/05-registration-signed.png) |

**3. Sign a document.** Load the parcel's registration, pick a template (or blank),
fill it in, and **Sign**. Co-owners add their signatures. Print the document: it has a
signature block and notary acknowledgment for every signer, and a final page of QR
codes. Sign in ink before a notary as usual.

| Writing a lease | Signed |
|---|---|
| ![Sign a lease](docs/images/06-sign-lease.png) | ![Signed](docs/images/07-signed.png) |

**Or sign a file.** Under **Sign a file**, load a PDF, Word or text file, or images.
Its text appears, locked, as what will be signed. For an image or a scan, write what
it shows (include the parcel number). Sign, and print the package: cover page, the
file's pages (each stamped "page i of n" with the document ID), and the signatures
page.

**Binary file signature** (advanced, at the bottom of the Sign tab): for a file you
send to someone directly, not for recording. Download the `.sig` and the verification
page and send both with the file.

### For Recorder staff, tenants, buyers and banks

**Check a document**: load the parcel's registration (the form PDF, a scan or a photo),
then the filed document (or several copies), or scan its QR codes. The result is
**GOOD** (compare the signed text with the paper, then record as usual), **DOES NOT
VERIFY** (hold the filing; suspected forgery), or **NOT CHECKED YET** (codes missing).
Then print the **verification certificate**, sign it, and append it to the filing,
or download a **checked copy** of the file with every page stamped with the result.
A tenant, buyer or bank can load the owner's public key card instead of a
registration. For a binary-signed file, open **Check a binary-signed file** and load
the file with its `.sig` or verification page.

![Check a filing](docs/images/08-check.png)

Anyone can also check a signature without this site, with GnuPG: save the signed text
(`.txt`) and signature (`.sig`) from the document, import the registered public keys,
and run `gpg --verify document.txt.sig document.txt`.

## What the printed documents look like

| Registration (page 1) | Signed lease (page 1) | Signature page | Verification certificate | Private key |
|---|---|---|---|---|
| ![](docs/images/pdf-registration.png) | ![](docs/images/pdf-lease.png) | ![](docs/images/pdf-signature-page.png) | ![](docs/images/pdf-certificate.png) | ![](docs/images/pdf-private-key.png) |

## Security model and limits

- **What it stops:** a forged deed on a registered parcel. The forger can copy a
  signature or a notary stamp, but cannot make the owner's digital signature without
  the private key **and** its passphrase. Altering any word or number after signing
  breaks the signature. A valid signature for one document or parcel can't be reused
  on another (the text, including the parcel number, is what's signed).
- **Registration** is the weak point any such system has, so it takes two independent
  identity checks (a notary and a law enforcement officer, or a business authority
  for entity positions), a Recorder callback to the verifying agency, and a digital
  signature from every listed key proving its holder has it.
- **It does not protect against** someone who has both the private key file and the
  passphrase; fraud between members of a **group key** (anyone in the group can make
  the digital signature); or collusion by the people verifying identity at
  registration. Keep the key and passphrase apart; use separate keys for the
  strongest protection.
- **Templates are starting points, not legal advice.** Have the wording checked.

## Rebranding for another jurisdiction

Everything specific to Pima County and Arizona is in a few places:

1. **`src/brand.ts`**: program name and acronym, county, **state**, project web
   address (`projectUrl`, printed on every PDF), the office that verifies entity positions
   (`entityAuthority`), and the **proposed/adopted status**. While `status` is
   `'proposed'`, every page and PDF says the program has not been adopted. Change it
   to `'adopted'` only once the jurisdiction has adopted the program and approved use
   of its seal.
2. **The seal or logo**: embedded in `index.html` as base64 in `<img id="brand-seal">`.
   The comment above that tag explains how to replace it (Mac, Linux and Windows
   commands). The PDFs use the same image. Set `src=""` for no seal.
3. **Document templates**: `src/templates.ts`. The deed templates follow Arizona's
   statutory short forms (A.R.S. 33-402 and 33-405) and the lease note mentions
   Arizona landlord-tenant law; replace them with your state's forms. The state name
   in the text comes from `BRAND.state`.
4. **Notary acknowledgment wording**: `src/pdf.ts` (search for "acknowledged before
   me"). The venue uses `BRAND.state`; adjust the wording to your state's form.
5. **About page text**: the "About the program" section of `index.html`.

Then run `npm run build`; `dist/index.html` is the finished site.

## Running, hosting and development

- **Use it**: open `dist/index.html` in a browser, or host that single file on any
  web server or GitHub Pages. It needs no server-side code.
- **Develop**:

```sh
npm install
npm run dev        # local dev server
npm test           # unit, GnuPG interop, and printed-code scan tests
npm run typecheck
npm run build      # dist/index.html: one self-contained file that works offline
```

The scan tests need `pdftoppm` (poppler-utils), `zbarimg` (zbar-tools) and
ImageMagick `convert`; the interop tests need `gpg`. Each is skipped if missing.

**Layout**: `src/crypto.ts` (OpenPGP: keys, signing, registration proof, checks),
`src/pdf.ts` (every printed document), `src/qrscan.ts` (reading codes from PDFs,
scans and photos), `src/text.ts` (the canonical text that gets signed),
`src/templates.ts`, `src/brand.ts`, `src/main.ts` and `index.html` (the site).
`CLAUDE.md` holds the detailed project brief and the open questions.

## License

Created by **Jason Adam Jensen** (project creator and grantor). Contact:
jasonajensen@gmail.com. Source: https://github.com/temperne/Open-Pgp-Registrar

This project uses the MIT License, with an express grant allowing states,
counties and other governments (including Pima County, the Pima County Recorder
and the State of Arizona, but not limited to them) to host the solution and
provide it to their residents. All warranties are disclaimed and no liability is
accepted. The full text is below and in [`LICENSE`](LICENSE).

```
Pima County S.T.O.P. Initiative (Stop Theft of Property) - Open PGP Registrar
MIT License, with an express grant for government use

Copyright (c) 2026 Jason Adam Jensen

Project creator and grantor: Jason Adam Jensen
Contact: jasonajensen@gmail.com
Source code: https://github.com/temperne/Open-Pgp-Registrar

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, host, operate and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following
condition:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

GOVERNMENT USE. Without limiting the grant above, permission is expressly
granted to every state, county, city, town, municipality, tribal government,
special district, and other government body or agency, and to any contractor
or vendor acting on its behalf, including without limitation Pima County,
Arizona, the Pima County Recorder, and the State of Arizona, to use, copy,
modify, rebrand, host and operate the Software, and to provide it to the public
and to their residents, with or without charge, for the purpose of offering
this solution or for any other purpose. No fee, registration, notice to the
grantor, or further permission is required.

NO WARRANTY. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT,
ALL OF WHICH ARE EXPRESSLY DISCLAIMED. THE SOFTWARE, INCLUDING ITS DOCUMENT
TEMPLATES AND DOCUMENTATION, IS NOT LEGAL ADVICE.

NO LIABILITY. IN NO EVENT SHALL THE AUTHOR, GRANTOR OR COPYRIGHT HOLDER BE
LIABLE FOR ANY CLAIM, DAMAGES, LOSS OF PROPERTY OR TITLE, OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
ANYONE WHO USES, HOSTS OR PROVIDES THE SOFTWARE DOES SO AT THEIR OWN RISK.

THIRD-PARTY COMPONENTS. The built application includes the following libraries,
each under its own license, which continues to apply to that library:
  - OpenPGP.js: GNU LGPL-3.0-or-later (https://github.com/openpgpjs/openpgpjs).
    Its source is available there, and this project can be rebuilt with a
    modified copy of it from the source code above.
  - PDF.js (pdfjs-dist): Apache-2.0 (https://github.com/mozilla/pdf.js)
  - jsQR: Apache-2.0 (https://github.com/cozmo/jsQR)
  - pdf-lib: MIT (https://github.com/Hopding/pdf-lib)
  - node-qrcode: MIT (https://github.com/soldair/node-qrcode)
  - JsBarcode: MIT (https://github.com/lindell/JsBarcode)
```
