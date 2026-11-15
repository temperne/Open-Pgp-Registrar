# Build proof: v0.1.11152026

- Build: `dist/index.html` SHA-256 `af56c5f3e389433fe42923ff53f7e9954d20670a2c5db70b5bf702b2b6b9d0af`
- Run: 2026-11-15 23:59:24 UTC
- Result: **ALL PASSED** (33 checks)

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
| PASS | 4. Filing as registration (original + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID E0BD980E9BDABB8A1A19A | 03-sale-1-filing-original-and-certificate.pdf |
| PASS | 4. Filing as registration (original + checked copy + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID E0BD980E9BDABB8A1A19A | 03b-sale-1-filing-original-checked-copy-certificate.pdf |
| PASS | 4. Filing as registration (certificate only) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID E0BD980E9BDABB8A1A19A | 03c-sale-1-filing-certificate-only.pdf |
| PASS | 4. Scanned filing as registration | Proof of key possession: by sale. | 04-sale-1-filing-SCANNED.pdf |
| PASS | 5. Second seller signs on their own computer | registration carried with the document, proof included; deed complete | 05-sale-2-deed-partly-signed.pdf, 05-sale-2-deed-to-ivy.pdf |
| PASS | 6. Recorder checks sale 2 against the sale-1 filing | GOOD. Every registered key signed. | 06-sale-2-filing-certificate-only.pdf |
| PASS | 7. Ivy loads the sale-2 certificate as her registration | Parcel 222-33-4444: 1 key, all must sign. Registered by sale: the deed with document ID C3BBC0DAE1C0A902993113 | 06-sale-2-filing-certificate-only.pdf |
| PASS | 8. Ivy’s document checks against her filing | GOOD. Every registered key signed. | 07-ivy-statement-of-ownership.pdf, 08-ivy-statement-filing-all-parts.pdf |
| PASS | 9. Ivy’s document against the ORIGINAL registration fails | DOES NOT VERIFY. |  |
| PASS | 9. Forged deed (unregistered key) against Ivy’s filing fails | DOES NOT VERIFY. | 09-FORGED-deed-signed-by-an-unregistered-key.pdf |
| PASS | 10. Change county from the header (Sign tab) | chosen from the list; office "Maricopa County Recorder"; heading "Maricopa County S.T.O.P. Initiative"; PDF footer names Maricopa County, no "Pima" | 10-another-county-key-card-maricopa.pdf |
| PASS | 10b. Recording offices and county names by state | Texas: "Harris County Clerk"; Louisiana: "Orleans Parish Clerk of Court"; the deed says "Orleans Parish, Louisiana"; program "Orleans Parish S.T.O.P. Initiative" |  |
| PASS | 11. Settings from the link (with an embedded seal) | heading "Yavapai County S.T.O.P. Program"; seal from the link; PDF names Yavapai County; "Copy a link" round-trips | 11-link-settings-key-card-yavapai.pdf |
| PASS | 11. A seal at a web address is refused | "The settings in this link could not be used: The seal in the link must be the image itself"; requests: 0 |  |
| PASS | 13. State seal switches with the state | choosing a Texas county shows the Texas seal in the preview and the header |  |
| PASS | 13. Link builder | "https://pimastopinitiative.jasonajensen.workers.dev/?county=Harris+County&state=Texas&recorder=Harris+County+Clerk&name=..." opens as "Harris County S.T.O.P. Initiative" |  |
| PASS | 13. Download this county’s program | zip: public/index.html, src/index.ts, wrangler.toml, package.json, README.md; the copy opens as "Harris County S.T.O.P. Initiative", office "Harris County Clerk", Texas seal; its rooms connect only to its own address (the master site only over https, for the update check); its PDFs name Harris County and its address | 13-harris-county-program.zip, 13-harris-county-copy-key-card.pdf |
| PASS | 13b. Signed release statement | the statement names the publisher and carries the file's SHA-256 (0495f4e05fbd4f37...) and the zip's; gpg --verify index.html.sig passes; the program's check with only the file and the statement: GOOD. Every registered key signed.; a changed file: DOES NOT VERIFY.; the copy names its publisher | 13b-signed-program.zip, 13b-release-statement.pdf |
| PASS | 12. Sign together in a signing room | unavailable in a saved copy; on https://pimastopinitiative.jasonajensen.workers.dev/ off until the terms of service and waiver are accepted and it is turned on, and only with an unlocked key; the link asks before joining; peers proven by their keys; 13 relay messages, all encrypted; the result checks GOOD. Every registered key signed. | 12-signed-together-in-a-room.pdf |
| PASS | 12b. Sign together with four signers | four tabs (an individual, two groups, a company position) in one room, each seeing the other three proven by their keys; two signed at the same moment and every tab still ended with all 4 signatures; gpg --verify: 4 good signatures | 12b-four-signers-in-a-room.pdf, 12b-four-signers.txt, 12b-four-signers.txt.sig |
| PASS | 12c. A registration signed together in a room | the second key holder's tab received the registration (owner "Ann Smith, Bob Jones and Carol Jones"), the room card followed them to the Register tab, both signed, and the form reads "Parcel 444-55-6666: 2 keys, all must sign.Ann SmithindividualDE81 3F94 6BB6 083A 9818 9214" | 12c-registration-signed-in-a-room.pdf |
| PASS | 12d. A file signed together in a room | the second owner's tab received the file itself ("lease-addendum.txt: text file. Its text is shown below, exac") and the first signature, added theirs, and the package checks GOOD. Every registered key signed. | 12d-file-signed-in-a-room.pdf |
| PASS | 12. Signing rooms carry only ciphertext | 64 relay messages in steps 12b-12d, none readable |  |
| PASS | 15. Update check | the version is on line 4 of index.html; a county copy asks nothing until Sign together is turned on, then makes one request to the master site; a newer version is offered with the same settings (https://pimastopinitiative.jasonajensen.workers.dev/?name=Harris+County+S.T.O.P.+Initiativ...); an older one is not; the copy always offers signing together on the master site with its settings |  |
| PASS | 14. Usage analytics asked first | asked on the web, never in a saved copy; nothing loaded before an answer; "No thanks": no requests; "Allow": only static.cloudflareinsights.com |  |
| PASS | No page errors or network requests | none |  |
