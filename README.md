# Open PGP Registrar: Owner Key Registration

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
   load that PDF and enter your passphrase. Keys from GnuPG, Kleopatra or similar
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

Anyone can check a signature without this tool:

```sh
gpg --import owner-public-key.asc
gpg --verify deed.txt.sig deed.txt   # the app saves both from the signed document
```

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
