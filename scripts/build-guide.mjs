// Builds the user guide (docs/guide/user-guide.pdf) from the screenshots in docs/guide.
// The app carries it (About tab: "Download the user guide") and appends it to a county's
// release statement. Run `npm run guide:shots` first when the screens change.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs', 'guide');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const W = 612, H = 792, M = 54, CW = W - 2 * M;
const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.38, 0.4, 0.45), ACCENT = rgb(0.12, 0.25, 0.5);

const doc = await PDFDocument.create();
doc.setTitle('S.T.O.P. User Guide');
doc.setSubject('How to protect your property from forged deeds with the S.T.O.P. program');
const reg = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
let page, y;
const newPage = () => {
  page = doc.addPage([W, H]);
  y = H - M;
};
const wrap = (text, font, size, width) => {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
};
const para = (text, { size = 10.5, font = reg, color = INK, gap = 6, indent = 0 } = {}) => {
  for (const line of wrap(text, font, size, CW - indent)) {
    if (y - size < M + 30) newPage();
    page.drawText(line, { x: M + indent, y: y - size, size, font, color });
    y -= size * 1.35;
  }
  y -= gap;
};
const heading = (text) => {
  if (y < M + 200) newPage();
  y -= 8;
  para(text, { size: 16, font: bold, color: ACCENT, gap: 4 });
};
const steps = (items) => items.forEach((t, i) => para(`${i + 1}.  ${t}`, { indent: 8, gap: 3 }));
const image = async (file, caption, maxH = 430) => {
  const path = join(DIR, file);
  if (!existsSync(path)) return;
  const img = await doc.embedJpg(readFileSync(path));
  const scale = Math.min(CW / img.width, maxH / img.height, 0.75);
  const w = img.width * scale, h = img.height * scale;
  if (y - h - 24 < M + 30) newPage();
  page.drawRectangle({ x: M + (CW - w) / 2 - 1, y: y - h - 1, width: w + 2, height: h + 2, borderColor: rgb(0.8, 0.82, 0.86), borderWidth: 0.75 });
  page.drawImage(img, { x: M + (CW - w) / 2, y: y - h, width: w, height: h });
  y -= h + 6;
  if (caption) para(caption, { size: 8.5, color: MUTED, gap: 12 });
};

// ---- Cover ----
newPage();
y -= 120;
para('S.T.O.P.', { size: 14, font: bold, color: ACCENT, gap: 2 });
para('User Guide', { size: 34, font: bold, gap: 10 });
para('Stop Theft of Property: how to protect a home or land from forged deeds, free.', { size: 14, color: MUTED, gap: 30 });
para(`Program version v${pkg.version}`, { size: 10.5, gap: 2 });
para('The screenshots show the program as it runs for Pima County, Arizona, as a demonstration. A county that adopts it shows its own name, office and seal.', { size: 10.5, color: MUTED, gap: 24 });
para('Contents', { size: 12, font: bold, gap: 4 });
steps([
  'What the program does',
  'Make your signing key',
  'Register your parcel',
  'Sign a deed or other document',
  'Sign together with co-owners',
  'Check a document',
  'Another county, and adoption',
  'Check that you have the real program',
  'Privacy and safety',
]);

// ---- 1 ----
newPage();
heading('1. What the program does');
para('Deed fraud is when someone records a forged deed that "sells" your property without you. Undoing it can take a quiet-title lawsuit, years and thousands of dollars. This program stops it before the deed is recorded.');
para('You register a digital signing key for your parcel with the county recorder, on a paper form with a notary. After that, any deed or other document filed against your parcel must carry your digital signature, printed on the paper as QR codes. A filing that is unsigned, or signed with a key that is not yours, is held and investigated instead of being recorded.');
para('It is free and voluntary, and it adds a layer on top of the usual paper process: ink signatures and notaries are still required.');
await image('01-about.jpg', 'The program’s website. Everything runs in your browser: nothing is uploaded or stored.');

// ---- 2 ----
heading('2. Make your signing key');
steps([
  'Open the "Your key" tab.',
  'Choose who signs with the key: one person, a group (for example a married couple using one key), or a position in a business or trust (for example "Secretary").',
  'Enter the name(s) and a passphrase you will remember. Write the passphrase down and keep it somewhere safe and separate.',
  'Choose "Create key", then download and print the private key PDF. Keep it like a passport: anyone with it and your passphrase could sign as you.',
]);
await image('03-create-key.jpg', 'Creating a key.', 330);
await image('04-your-key.jpg', 'Your key, ready to use. "Public key card" is the page to share with co-owners.', 330);
await image('12-pdf-private-key.jpg', 'The private key PDF. It carries the key as QR codes, so it can be loaded back from a scan or a photo.', 360);

// ---- 3 ----
heading('3. Register your parcel');
steps([
  'Open the "Register" tab and enter the owner(s) of record and the parcel number (several parcels: one per line, one form each).',
  'If others must sign too (a co-owner, a trustee), add their keys from their public key cards. Every key listed must sign any future deed.',
  'Choose "Sign the registration with my key". Each other key holder signs too: on your computer, from the PDF on theirs ("Continue a registration"), or together in a signing room.',
  'Download the registration form, print it, sign it in ink before a notary, and have your identity checked as the form describes.',
  'File it with the county recorder. They call you back to confirm before turning the protection on.',
]);
await image('05-register.jpg', 'The registration form.', 380);
await image('06-registration-signed.jpg', 'Every key on the registration has signed it, proving its holder has the key and passphrase.', 220);
await image('13-pdf-registration.jpg', 'The printed registration form (Exhibit A).', 400);

// ---- 4 ----
heading('4. Sign a deed or other document');
steps([
  'Open "Sign a document" and load your parcel’s registration form (the PDF, or a scan or photo of it). The program then knows every owner who must sign.',
  'Choose a template (warranty, quitclaim or beneficiary deed, a lease, and others) and fill it in, or write your own text. Or choose "Sign a file" to sign a PDF, Word file or images.',
  'Choose "Sign". Each other owner adds their signature: on the same computer, from the PDF ("Sign exactly as others"), or together in a signing room.',
  'Download the PDF, print it, sign it in ink before a notary as usual, and record it. The last page carries the QR codes.',
]);
await image('07-sign.jpg', 'Writing a deed from a template.', 430);
await image('08-signed.jpg', 'Signed. The status shows who still has to sign.', 260);
await image('14-pdf-deed.jpg', 'The printed deed: the text, with the usual ink signature and notary blocks.', 360);
await image('15-pdf-signature-page.jpg', 'The signature page: the signers, the document ID and county barcodes, and the QR codes that carry the signed text.', 360);

// ---- 5 ----
heading('5. Sign together with co-owners');
para('Co-owners, buyers and sellers can sign the same registration, document or file at the same time, each on their own computer. Unlock your key, agree to the terms, turn on "Sign together", start a room and send the link (or the code). Everyone who joins is shown with the key they proved they hold, and every signature appears in every tab. The room uses the settings of the person who started it. Messages are encrypted in your browser with a key that is only in the link; the relay cannot read them and stores nothing.');
await image('09-sign-together.jpg', 'The signing room card.', 400);

// ---- 6 ----
heading('6. Check a document');
para('For recorder staff, and for anyone a signed document is given to (a tenant checking a lease, a buyer, a bank).');
steps([
  'Open "Check a document" and load the parcel’s registration (any owner’s form, a scan or a photo).',
  'Load the signed document (the PDF, the recorder’s scan or a phone photo of its signature page), or scan its codes.',
  'GOOD means every registered owner signed exactly the text shown. Compare that text with the paper. Recorder staff can then print a verification certificate for the filing.',
]);
para('The check also fails a registration or document made for another county than the one the site is set to.');
await image('10-check.jpg', 'A deed checked against the parcel’s registration.', 430);

// ---- 7 ----
heading('7. Another county, and adoption');
para('"Change county or state" at the top of every page sets the county, state, recording office and names. Until a county (or its whole state) adopts the program, it runs as a demonstration: every page and PDF says so, and the seal carries a DEMO band. The About tab lists where the program is adopted, and shows how to ask your county, or your state legislators, to adopt it, with letters you can send.');
await image('11-another-county.jpg', 'Choosing the county and state.', 330);
await image('02-adoption.jpg', 'Where the program is adopted, and how to ask for it.', 400);

// ---- 8 ----
heading('8. Check that you have the real program');
para('The whole program is one file, index.html. Each release lists its SHA-256 fingerprint in the project’s README ("Download and verify"), and a county’s copy comes with a signed release statement. To check a copy you downloaded:');
steps([
  'Compute its SHA-256: on Mac or Linux, sha256sum index.html; on Windows, Get-FileHash index.html.',
  'Compare it with the fingerprint in the release statement or the README. If they differ, do not use that copy.',
  'With a release statement: in the program, "Check a document", "Check a binary-signed file": load index.html and the statement. Or with GnuPG: gpg --verify index.html.sig index.html.',
]);

// ---- 9 ----
heading('9. Privacy and safety');
steps([
  'Nothing is uploaded or stored. Your keys and documents exist only in your browser tab, and closing it forgets them: download what you need.',
  'Your private key never leaves your computer, not even in a signing room.',
  'Keep the private key PDF and your passphrase apart and safe. If you lose either, register a replacement key with the recorder.',
  'A key shared by a group cannot stop one member from signing without the others: use one key per person if that matters.',
  'The digital signature is an extra layer. Ink signatures, notaries and the recorder’s own checks still apply.',
]);

// ---- Footers ----
const pages = doc.getPages();
pages.forEach((p, i) => {
  if (i === 0) return;
  const left = `S.T.O.P. User Guide  |  v${pkg.version}`;
  p.drawText(left, { x: M, y: 30, size: 8, font: reg, color: MUTED });
  const right = `Page ${i + 1} of ${pages.length}`;
  p.drawText(right, { x: W - M - reg.widthOfTextAtSize(right, 8), y: 30, size: 8, font: reg, color: MUTED });
});
const bytes = await doc.save();
writeFileSync(join(DIR, 'user-guide.pdf'), bytes);
console.log(`docs/guide/user-guide.pdf: ${pages.length} pages, ${(bytes.length / 1024).toFixed(0)} KB`);
