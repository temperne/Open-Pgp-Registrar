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
3. **Sign a document.** Choose the deed (or any file). You get a verification page
   to print and attach, with a QR code that carries the signature and a barcode
   with the document ID. You also get a combined print copy and a `.sig` file.
   Give the Recorder the original file as well. The signature covers that exact file.

## What the Recorder does

Use **Check a filing**. Scan the public-key code from the registration form (or
load the form PDF, which has the key embedded), scan
the QR code on the verification page, and load the filed document. The result is
**good** (record as usual), **does not verify** (hold, suspected forgery) or
**not checked yet** (the document file is still needed). A handheld barcode
scanner works because it types into the boxes.

Anyone can check a signature without this tool:

```sh
gpg --import owner-public-key.asc
gpg --verify deed.pdf.sig deed.pdf
```

The QR text is `PGPSIG1|<fingerprint>|<sha256>|<base64 detached signature>`.

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
