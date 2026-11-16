// Screenshots for the user guide (docs/guide/*.jpg), taken from the built app (dist/index.html)
// with the proof's test keys and documents. Run after `npm run build` and `npm run proof`:
//   npm run guide:shots && npm run guide
// Needs Playwright with Chromium and poppler-utils (pdftoppm).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'guide');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PROOF = join(ROOT, 'proof', `v${pkg.version}`);
const OFFICIAL = 'https://pimastopinitiative.jasonajensen.workers.dev/';
const PASS = 'proof-passphrase-1';
const { chromium } = createRequire(import.meta.url)('playwright');

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.jpg')) rmSync(join(OUT, f));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
page.on('dialog', (d) => d.accept());
// Served at the program's address, as people see it (nothing goes to the internet).
const html = readFileSync(join(ROOT, 'dist', 'index.html'));
await page.route(`${OFFICIAL}**`, (r) => r.fulfill({ body: html, contentType: 'text/html' }));
await page.goto(OFFICIAL);
await page.waitForTimeout(500);

/** An element (its top part at most), as a compact JPEG. */
async function shot(name, selector, maxHeight = 1100) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  const scroll = await page.evaluate(() => window.scrollY);
  await page.screenshot({
    path: join(OUT, `${name}.jpg`),
    type: 'jpeg',
    quality: 30,
    fullPage: true,
    clip: { x: Math.max(0, box.x - 6), y: box.y + scroll - 6, width: Math.min(900, box.width + 12), height: Math.min(maxHeight, box.height + 12) },
  });
  console.log('shot', name);
}

// 1. About: the header and the problem it solves.
await page.screenshot({ path: join(OUT, '01-about.jpg'), type: 'jpeg', quality: 30, clip: { x: 0, y: 0, width: 900, height: 760 } });
await shot('02-adoption', '#adoption', 760);

// 2. Your key.
await page.click('#tab-key');
await page.selectOption('#gen-kind', 'individual');
await page.fill('#gen-name', 'Ann Smith');
await page.fill('#gen-pass', PASS);
await page.fill('#gen-pass2', PASS);
await shot('03-create-key', '#gen-form');
await page.click('#gen-btn');
await page.waitForSelector('#key-current:not([hidden])', { timeout: 120000 });
await shot('04-your-key', '#key-current', 900);

// 3. Register the parcel.
await page.click('#tab-register');
await page.fill('#reg-owner', 'Ann Smith');
await page.fill('#reg-parcels', '222-33-4444');
await page.fill('#reg-property', '100 Example Road, Tucson, AZ');
{
  // The form itself (new or replacement, owner, parcel, keys), down to its Sign button.
  const top = await page.locator('#reg-form fieldset.choice').first().boundingBox();
  const btn = await page.locator('#reg-btn').boundingBox();
  const scroll = await page.evaluate(() => window.scrollY);
  await page.screenshot({
    path: join(OUT, '05-register.jpg'),
    type: 'jpeg',
    quality: 30,
    fullPage: true,
    clip: { x: 0, y: top.y + scroll - 16, width: 900, height: Math.min(1100, btn.y - top.y + 70) },
  });
  console.log('shot 05-register');
}
await page.click('#reg-btn');
await page.waitForSelector('#reg-result:not([hidden])');
await shot('06-registration-signed', '#reg-result', 600);

// 4. Sign a document.
await page.click('#tab-sign');
await page.selectOption('#tpl', 'warranty');
await page.fill('#f-grantee', 'Bob Buyer, a single man');
await page.fill('#f-parcels', '222-33-4444');
await page.fill('#f-legal', 'Lot 7, Example Tract, per the recorded plat.');
await page.fill('#f-consideration', 'Ten Dollars and other valuable consideration');
{
  // The document itself: the template and its fields, down to the Sign button.
  const top = await page.locator('#tpl').boundingBox();
  const btn = await page.locator('#text-sign-btn').boundingBox();
  const scroll = await page.evaluate(() => window.scrollY);
  await page.screenshot({
    path: join(OUT, '07-sign.jpg'),
    type: 'jpeg',
    quality: 30,
    fullPage: true,
    clip: { x: 0, y: top.y + scroll - 40, width: 900, height: Math.min(1100, btn.y - top.y + 90) },
  });
  console.log('shot 07-sign');
}
await page.click('#text-sign-btn');
await page.waitForSelector('#text-result:not([hidden])', { timeout: 60000 });
await shot('08-signed', '#text-result', 700);
// Signing together.
await page.check('#room-agree');
await page.check('#room-enable');
await shot('09-sign-together', '#room-card', 900);

// 5. Check a document (the proof's registration and sale deed).
await page.click('#tab-verify');
await page.setInputFiles('#v-reg-file', join(PROOF, '01-registration-ann-and-bob-carol.pdf'));
await page.waitForFunction(() => /Proof of key possession/.test(document.getElementById('v-reg-info').textContent), null, { timeout: 240000 });
await page.setInputFiles('#v-codes-file', join(PROOF, '02-sale-1-deed-to-dan-eve-and-acme.pdf'));
await page.waitForFunction(() => !document.getElementById('verify-result').hidden && /GOOD|DOES NOT/.test(document.getElementById('vr-banner').textContent), null, { timeout: 240000 });
await page.waitForTimeout(500);
await shot('10-check', '#verify-result', 900);

// 6. Another county or state.
await page.click('#j-open');
await shot('11-another-county', '#jurisdiction', 700);
await browser.close();

// The PDFs themselves (first page of each), from the proof run.
const pdfShot = (name, file, pageNo = 1) => {
  execFileSync('pdftoppm', ['-jpeg', '-jpegopt', 'quality=32', '-r', '50', '-f', String(pageNo), '-l', String(pageNo), '-singlefile', join(PROOF, file), join(OUT, name)]);
  console.log('pdf', name);
};
pdfShot('12-pdf-private-key', '00-key-ann-PRIVATE-test-only.pdf');
pdfShot('13-pdf-registration', '01-registration-ann-and-bob-carol.pdf');
const deedPages = +execFileSync('pdfinfo', [join(PROOF, '02-sale-1-deed-to-dan-eve-and-acme.pdf')]).toString().match(/Pages:\s+(\d+)/)[1];
pdfShot('14-pdf-deed', '02-sale-1-deed-to-dan-eve-and-acme.pdf');
pdfShot('15-pdf-signature-page', '02-sale-1-deed-to-dan-eve-and-acme.pdf', Math.min(deedPages, 3));
const total = readdirSync(OUT).filter((f) => f.endsWith('.jpg')).reduce((n, f) => n + readFileSync(join(OUT, f)).length, 0);
console.log(`${readdirSync(OUT).filter((f) => f.endsWith('.jpg')).length} images, ${(total / 1024).toFixed(0)} KB`);
