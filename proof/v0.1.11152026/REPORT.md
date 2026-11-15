# Build proof: v0.1.11152026

- Build: `dist/index.html` SHA-256 `b93a72d276c9fc8d3d1b31eeab99076cf9a0bd39936d8a2e382c876f549d71f1`
- Run: 2026-11-15 17:31:36 UTC
- Result: **ALL PASSED** (18 checks)

The app itself (the built single file, in Chromium) went through the full ownership chain. Every PDF it
made is in this folder. All keys are test keys made for this run (passphrase in `e2e/proof.mjs`).

| | Step | Result | Files |
|---|---|---|---|
| PASS | Keys | six test keys made: individual, two groups, a company position, two more individuals |  |
| PASS | 1. Registration | individual + group key, both signed (5 pages) | 01-registration-ann-and-bob-carol.pdf |
| PASS | 2. Grantee from buyer keys | "Dan Lee, Eve Lee and Acme Holdings LLC" |  |
| PASS | 2. Sale 1 deed signed by both sellers | Signed by every owner; 0 of 2 buyer keys proven | 02a-sale-1-deed-signed-by-sellers-buyers-not-yet-proven.pdf |
| PASS | 2. Buyers prove their keys | button "Prove my buyer key"; Dan/Eve from the PDF, Acme on the same computer; the deed's registration-by-sale page says COMPLETE | 02-sale-1-deed-to-dan-eve-and-acme.pdf |
| PASS | 2. Unproven buyers: no registration by sale | Proof of key possession NOT COMPLETE (2 of the buyers’ 2 keys have not proven possession (signed the new registration). |  |
| PASS | 3. Recorder checks sale 1 | GOOD. Every registered key signed. | 03-sale-1-filing-original-and-certificate.pdf |
| PASS | 4. Filing as registration (original + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 2FDF485C3104BA7A25024 | 03-sale-1-filing-original-and-certificate.pdf |
| PASS | 4. Filing as registration (original + checked copy + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 2FDF485C3104BA7A25024 | 03b-sale-1-filing-original-checked-copy-certificate.pdf |
| PASS | 4. Filing as registration (certificate only) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 2FDF485C3104BA7A25024 | 03c-sale-1-filing-certificate-only.pdf |
| PASS | 4. Scanned filing as registration | Proof of key possession: by sale. | 04-sale-1-filing-SCANNED.pdf |
| PASS | 5. Second seller signs on their own computer | registration carried with the document, proof included; deed complete | 05-sale-2-deed-partly-signed.pdf, 05-sale-2-deed-to-ivy.pdf |
| PASS | 6. Recorder checks sale 2 against the sale-1 filing | GOOD. Every registered key signed. | 06-sale-2-filing-certificate-only.pdf |
| PASS | 7. Ivy loads the sale-2 certificate as her registration | Parcel 222-33-4444: 1 key, all must sign. Registered by sale: the deed with document ID 4F812C0F9CAF9CB348C08A | 06-sale-2-filing-certificate-only.pdf |
| PASS | 8. Ivy’s document checks against her filing | GOOD. Every registered key signed. | 07-ivy-statement-of-ownership.pdf, 08-ivy-statement-filing-all-parts.pdf |
| PASS | 9. Ivy’s document against the ORIGINAL registration fails | DOES NOT VERIFY. |  |
| PASS | 9. Forged deed (unregistered key) against Ivy’s filing fails | DOES NOT VERIFY. | 09-FORGED-deed-signed-by-an-unregistered-key.pdf |
| PASS | No page errors or network requests | none |  |
