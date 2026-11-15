# Build proof: v0.1.11152026

- Build: `dist/index.html` SHA-256 `671fc55f164ef552cd5c47877d36f8f4bbd738de19306acf9295900778cdbf97`
- Run: 2026-11-15 23:23:27 UTC
- Result: **ALL PASSED** (26 checks)

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
| PASS | 4. Filing as registration (original + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 934C4E3C4BCB63F0E55C8 | 03-sale-1-filing-original-and-certificate.pdf |
| PASS | 4. Filing as registration (original + checked copy + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 934C4E3C4BCB63F0E55C8 | 03b-sale-1-filing-original-checked-copy-certificate.pdf |
| PASS | 4. Filing as registration (certificate only) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 934C4E3C4BCB63F0E55C8 | 03c-sale-1-filing-certificate-only.pdf |
| PASS | 4. Scanned filing as registration | Proof of key possession: by sale. | 04-sale-1-filing-SCANNED.pdf |
| PASS | 5. Second seller signs on their own computer | registration carried with the document, proof included; deed complete | 05-sale-2-deed-partly-signed.pdf, 05-sale-2-deed-to-ivy.pdf |
| PASS | 6. Recorder checks sale 2 against the sale-1 filing | GOOD. Every registered key signed. | 06-sale-2-filing-certificate-only.pdf |
| PASS | 7. Ivy loads the sale-2 certificate as her registration | Parcel 222-33-4444: 1 key, all must sign. Registered by sale: the deed with document ID DE3B2E98E92C90FFA1E450 | 06-sale-2-filing-certificate-only.pdf |
| PASS | 8. Ivy’s document checks against her filing | GOOD. Every registered key signed. | 07-ivy-statement-of-ownership.pdf, 08-ivy-statement-filing-all-parts.pdf |
| PASS | 9. Ivy’s document against the ORIGINAL registration fails | DOES NOT VERIFY. |  |
| PASS | 9. Forged deed (unregistered key) against Ivy’s filing fails | DOES NOT VERIFY. | 09-FORGED-deed-signed-by-an-unregistered-key.pdf |
| PASS | 10. Change county from the header (Sign tab) | chosen from the list; office "Maricopa County Recorder"; heading "Maricopa County S.T.O.P. Initiative"; PDF footer names Maricopa County, no "Pima" | 10-another-county-key-card-maricopa.pdf |
| PASS | 10b. Recording offices and county names by state | Texas: "Harris County Clerk"; Louisiana: "Orleans Parish Clerk of Court"; the deed says "Orleans Parish, Louisiana"; program "Orleans Parish S.T.O.P. Initiative" |  |
| PASS | 11. Settings from the link (with an embedded seal) | heading "Yavapai County S.T.O.P. Program"; seal from the link; PDF names Yavapai County; "Copy a link" round-trips | 11-link-settings-key-card-yavapai.pdf |
| PASS | 11. A seal at a web address is refused | "The settings in this link could not be used: The seal in the link must be the image itself"; requests: 0 |  |
| PASS | 13. State seal switches with the state | choosing a Texas county shows the Texas seal in the preview and the header |  |
| PASS | 13. Link builder | "https://pimastopinitiative.jasonajensen.workers.dev/?county=Harris+County&state=Texas&recorder=Harris+County+Clerk&name=..." opens as "Harris County S.T.O.P. Initiative" |  |
| PASS | 13. Download this county’s program | zip: public/index.html, src/index.ts, wrangler.toml, package.json, README.md; the copy opens as "Harris County S.T.O.P. Initiative", office "Harris County Clerk", Texas seal; its policy connects only to its own address; its PDFs name Harris County and its address | 13-harris-county-program.zip, 13-harris-county-copy-key-card.pdf |
| PASS | 12. Sign together in a signing room | unavailable in a saved copy; on https://pimastopinitiative.jasonajensen.workers.dev/ off until the terms of service and waiver are accepted and it is turned on, and only with an unlocked key; the link asks before joining; peers proven by their keys; 13 relay messages, all encrypted; the result checks GOOD. Every registered key signed. | 12-signed-together-in-a-room.pdf |
| PASS | No page errors or network requests | none |  |
