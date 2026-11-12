# Pima County S.T.O.P. Initiative (Stop Theft of Property)

A browser tool for a voluntary, no-fee deed-fraud safeguard. A property owner
registers an OpenPGP signing key with the County Recorder on paper and then signs
each instrument. The paper filing carries a QR code and a barcode that staff can
scan to check the signature.

**Nothing is stored or sent.** Everything runs in the browser tab. There is no
server and no account, and nothing is saved. The built page blocks all network
connections with a Content-Security-Policy.

## What owners do

1. **Your key.** Create a new key (protected by a passphrase) and download it as
   a PDF. Print it for your safe and keep the file on a USB drive. To sign later,
   load that PDF, or on a phone take a photo of the printed page, and enter your
   passphrase. Keys from GnuPG, Kleopatra or similar
   work too.
2. **Register.** Download the registration form (PDF). Print it, sign it before a
   notary, have a local law enforcement officer complete the attestation box, and
   file it with the Recorder. The Recorder calls the officer's agency to confirm
   before activating the key.
3. **Sign a document.** Start from a template (warranty, quitclaim or beneficiary
   deed, or blank), fill in the details, and sign. The app prints the document
   with the usual ink signature lines and notary block, plus a signature page
   whose QR codes carry the digital signature *and the exact text signed*. Sign it
   in ink before the notary as usual. The digital signature is an extra layer.

## What the Recorder does

Use **Check a filing**. Load the owner's registered key (scan the code on the
registration form, or load the form PDF), then scan every QR code on the
signature page. The tool checks the signature and shows exactly what the owner
signed, so staff can compare it with the paper. Capital letters and spacing don't
matter; every word and number does. The result is **good**, **does not verify**
(hold, suspected forgery) or **not checked yet** (codes missing). A handheld 2D
scanner works because it types into the box.

Staff can also load the Recorder's scan of the filing, or take a phone photo,
instead of scanning codes one by one. After the check, **print a verification
certificate**: it states that agency personnel found the parcel protected by the
program and checked the owner's signature, shows the result, the document ID
barcode and the full signed text, and has lines for the checker's name, title,
signature and date. Sign it and append it to the filing.

Anyone can check a signature without this tool:

```sh
gpg --import owner-public-key.asc
gpg --verify deed.txt.sig deed.txt   # the app saves both from the signed document
```

## Branding

Program name, web address (currently the placeholder `[PROJECT URL]`) and the
"proposed program" notice are set in `src/brand.ts`. The seal image is embedded in
`index.html`; the comment above `<img id="brand-seal">` explains how to replace it.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests, GnuPG interop, and printed-code scan tests
npm run typecheck
npm run build      # dist/index.html: one self-contained file that works offline
```

The scan tests need `pdftoppm` (poppler-utils) and `zbarimg` (zbar-tools). The
interop tests need `gpg`. Each is skipped if its tool is missing.

See `CLAUDE.md` for the project brief and open questions.

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
