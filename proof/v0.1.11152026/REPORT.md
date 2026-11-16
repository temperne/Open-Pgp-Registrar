# Build proof: v0.1.11152026

- Build: `dist/index.html` SHA-256 `05c614bcac7bcbf0ba4c98db19fe6fe5365a5860519f6690675101d93047ccd7`
- Run: 2026-11-16 05:11:00 UTC
- Result: **ALL PASSED** (38 checks)

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
| PASS | 3b. Another county’s site refuses them | the registration and the deed name Pima County, Arizona in their signed text (and as a COUNTY barcode); a site set to Maricopa County says DOES NOT VERIFY. |  |
| PASS | 4. Filing as registration (original + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 0D3E71BCBB9A86CBA4775 | 03-sale-1-filing-original-and-certificate.pdf |
| PASS | 4. Filing as registration (original + checked copy + certificate) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 0D3E71BCBB9A86CBA4775 | 03b-sale-1-filing-original-checked-copy-certificate.pdf |
| PASS | 4. Filing as registration (certificate only) | Parcel 222-33-4444: 2 keys, all must sign. Registered by sale: the deed with document ID 0D3E71BCBB9A86CBA4775 | 03c-sale-1-filing-certificate-only.pdf |
| PASS | 4. Scanned filing as registration | Proof of key possession: by sale. | 04-sale-1-filing-SCANNED.pdf |
| PASS | 5. Second seller signs on their own computer | registration carried with the document, proof included; deed complete | 05-sale-2-deed-partly-signed.pdf, 05-sale-2-deed-to-ivy.pdf |
| PASS | 6. Recorder checks sale 2 against the sale-1 filing | GOOD. Every registered key signed. | 06-sale-2-filing-certificate-only.pdf |
| PASS | 7. Ivy loads the sale-2 certificate as her registration | Parcel 222-33-4444: 1 key, all must sign. Registered by sale: the deed with document ID 5C2C9672A11FC3E37DEF6D | 06-sale-2-filing-certificate-only.pdf |
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
| PASS | 13b. Signed release statement | the statement says who releases which version for which county, what's new and how to use it, then the file's SHA-256 (c3552d05b6b3e676...) and the zip's, then the user guide (17 pages in all); gpg --verify index.html.sig passes; the program's check with only the file and the statement: GOOD. Every registered key signed.; a changed file: DOES NOT VERIFY.; the copy names its publisher | 13b-signed-program.zip, 13b-release-statement.pdf |
| PASS | 12. Sign together in a signing room | unavailable in a saved copy; on https://pimastopinitiative.jasonajensen.workers.dev/ off until the terms of service and waiver are accepted and it is turned on, and only with an unlocked key; the link asks before joining; peers proven by their keys; 18 relay messages, all encrypted; the result checks GOOD. Every registered key signed. | 12-signed-together-in-a-room.pdf |
| PASS | 12b. Sign together with four signers | four tabs (an individual, two groups, a company position) in one room, each seeing the other three proven by their keys; two signed at the same moment and every tab still ended with all 4 signatures; gpg --verify: 4 good signatures | 12b-four-signers-in-a-room.pdf, 12b-four-signers.txt, 12b-four-signers.txt.sig |
| PASS | 12c. A registration signed together in a room | the second key holder joined by pasting the room link into the page they had open (key still unlocked) and took the starter's settings ("Working for Maricopa County, Arizona Change county or state"; "Settings from Ann Smith, who started this room: Maricopa Cou..."), which they can't change while in the room; the room offered their proven key ("Add the key of the signing room: Bob Jones and Carol Jones...") and signing asked to add it; the second key holder's tab received the registration (owner "Ann Smith, Bob Jones and Carol Jones"), the room card followed them to the Register tab, both signed, and the form reads "Parcel 444-55-6666: 2 keys, all must sign.Ann Smithindividual8E27 0F28 318C BB7A 3906 5611" | 12c-registration-signed-in-a-room.pdf |
| PASS | 12d. A file signed together in a room | the second owner's tab received the file itself ("pet-addendum-photo.png: image, 1 page. It has no t") and the first signature, added theirs, and the package checks GOOD. Every registered key signed.; the ~200 KB file crossed the relay 1 time while both signed (then signatures only), and 1 more time for someone who joined afterwards and asked for it | 12d-file-signed-in-a-room.pdf |
| PASS | 12. Signing rooms carry only ciphertext | 105 relay messages in steps 12b-12d, none readable |  |
| PASS | 12e. A large file through a room, in parts | a 6.9 MB scan went through the room in 18 encrypted parts (largest message 683 KB, under Cloudflare's 1 MB), arrived whole (checked against its SHA-256), both signed, and the package checks GOOD. Every registered key signed. | 12e-large-file-signed-in-a-room.pdf |
| PASS | 16. Failover to the backup relay | the project's server refused 2 connections; both tabs moved to Cloudflare's relay on their own (one loaded from the program's address, one from the project's server: "This page was loaded from https://84-46-239-112.sslip.io, the program’..."), signed together through it (16 messages, all encrypted), and the result checks GOOD. Every registered key signed. | 16-signed-through-the-backup-relay.pdf |
| PASS | 15. Update check | the version is on line 4 of index.html; a county copy asks nothing until Sign together is turned on, then makes one request to the master site; a newer version is offered with the same settings (https://pimastopinitiative.jasonajensen.workers.dev/?name=Harris+County+S.T.O.P.+Initiativ...); an older one is not; the copy always offers signing together on the master site with its settings |  |
| PASS | 18. User guide | the About tab's "Download the user guide" gives a 15-page guide with screenshots: key, registration, signing, signing together, checking, adoption, verifying the program | 18-user-guide.pdf |
| PASS | 17. Demonstration until adopted | no county is in the adoption list yet, so the page and its PDFs say "Demonstration system: not adopted by Pima County, Arizona. Not an offi..." and the seal carries a DEMO band (also on the PDFs); the About tab shows the status and a letter to the Pima County Recorder, and links to the Arizona legislature (Open States) | 00-key-ann-card.pdf |
| PASS | 14. Usage analytics asked first | asked on the web, never in a saved copy; nothing loaded before an answer; "No thanks": no requests; "Allow": only static.cloudflareinsights.com |  |
| PASS | No page errors or network requests | none |  |
