// Build proof: runs the real app (dist/index.html) in Chromium through the full
// ownership chain, asserts every result, and saves every PDF it made with a
// REPORT.md in proof/<version>/, tied to the build by its SHA-256.
//
//   npm run proof            (builds first; needs Playwright with Chromium, poppler-utils, ImageMagick)
//
// The chain: a complex registration (an individual + a group key) -> sale to a
// group + a company position key -> the Recorder's filing (original + certificate)
// loads as the new registration -> the second seller signs on their own computer ->
// sale to an individual, filed as the certificate only -> the new owner signs a
// document against that filing. Plus the filing with both boxes, a scan of a filing,
// and the checks that must fail (an old registration, a key that isn't registered).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not available. Install it (with Chromium) to run the build proof.');
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'index.html');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = `v${pkg.version}`;
const SHA = createHash('sha256').update(readFileSync(DIST)).digest('hex');
const OUT = join(ROOT, 'proof', VERSION);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const WORK = join(OUT, '.work');
mkdirSync(WORK);
const APP = pathToFileURL(DIST).href;
const PARCEL = '222-33-4444';
const PASS = 'proof-passphrase-1';

const steps = [];
let failed = 0;
function check(step, ok, detail, files = []) {
  steps.push({ step, ok, detail, files: files.map((f) => basename(f)) });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}
const pages = (f) => +execFileSync('pdfinfo', [f]).toString().match(/Pages:\s+(\d+)/)[1];
const flat = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
const errors = [];
async function newPage() {
  const p = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  p.on('request', (r) => {
    if (!/^(file|blob|data):/.test(r.url())) errors.push(`network request: ${r.url()}`);
  });
  await p.goto(APP);
  return p;
}
async function save(p, selector, name) {
  const [d] = await Promise.all([p.waitForEvent('download'), p.click(selector)]);
  const f = join(OUT, name);
  await d.saveAs(f);
  return f;
}
async function loadKey(p, file) {
  await p.click('#tab-key');
  if (await p.isVisible('#forget-key')) await p.click('#forget-key');
  await p.setInputFiles('#load-file', file);
  await p.waitForSelector('#unlock-form:not([hidden])');
  await p.fill('#unlock-pass', PASS);
  await p.click('#unlock-btn');
  await p.waitForFunction(() => /Unlocked/.test(document.getElementById('key-status').textContent));
}
async function loadSignRegistration(p, file) {
  await p.click('#tab-sign');
  await p.setInputFiles('#s-reg-file', file);
  await p.waitForFunction(() => /Parcel|could not|not a registration|error/i.test(document.getElementById('s-reg-info').textContent), null, { timeout: 240000 });
  return flat(await p.textContent('#s-reg-info'));
}
async function signUntilComplete(p) {
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => !document.getElementById('text-result').hidden, null, { timeout: 60000 });
}

// Checks a document against a registration file; optionally downloads the filing.
async function checkDocument(regFile, docFile, filing) {
  const r = await newPage();
  await r.click('#tab-verify');
  await r.setInputFiles('#v-reg-file', regFile);
  await r.waitForFunction(() => /Proof of key possession(: every|: by sale| NOT)|error|not a registration/i.test(document.getElementById('v-reg-info').textContent), null, {
    timeout: 240000,
  });
  const regInfo = flat(await r.textContent('#v-reg-info'));
  await r.setInputFiles('#v-codes-file', docFile);
  await r.waitForFunction(() => !document.getElementById('verify-result').hidden && /GOOD|DOES NOT|THIRD|NOT CHECKED/.test(document.getElementById('vr-banner').textContent), null, {
    timeout: 240000,
  });
  await r.waitForTimeout(500);
  const verdict = flat(await r.textContent('#vr-banner strong'));
  let filed = null;
  if (filing) {
    await r.fill('#c-name', 'Proof Clerk');
    await r.fill('#c-title', 'Recording Clerk');
    if (filing.original) await r.check('#c-with-original');
    if (filing.checked) await r.check('#c-with-checked');
    filed = await save(r, '#cert-btn', filing.name);
  }
  await r.close();
  return { regInfo, verdict, filed };
}

try {
  // ---- Keys (made in the app; test keys only) ----
  const keys = {};
  for (const [id, kind, fill] of [
    ['ann', 'individual', (p) => p.fill('#gen-name', 'Ann Smith')],
    ['bob-carol', 'group', (p) => p.fill('#gen-members', 'Bob Jones\nCarol Jones')],
    ['dan-eve', 'group', (p) => p.fill('#gen-members', 'Dan Lee\nEve Lee')],
    ['acme', 'position', async (p) => {
      await p.fill('#gen-name', 'Acme Holdings LLC');
      await p.fill('#gen-position', 'Manager');
      await p.fill('#gen-holder', 'Frank Moss');
    }],
    ['ivy', 'individual', (p) => p.fill('#gen-name', 'Ivy Chen')],
    ['mallory', 'individual', (p) => p.fill('#gen-name', 'Mallory Fake')],
  ]) {
    const p = await newPage();
    await p.click('#tab-key');
    await p.selectOption('#gen-kind', kind);
    await fill(p);
    await p.fill('#gen-pass', PASS);
    await p.fill('#gen-pass2', PASS);
    await p.click('#gen-btn');
    await p.waitForSelector('#key-current:not([hidden])');
    keys[id] = { priv: await save(p, '#dl-private', `00-key-${id}-PRIVATE-test-only.pdf`), card: await save(p, '#dl-card', `00-key-${id}-card.pdf`) };
    await p.close();
  }
  check('Keys', true, 'six test keys made: individual, two groups, a company position, two more individuals');

  // ---- 1. Complex registration: Ann (individual) + Bob and Carol (group); both keys sign ----
  let p = await newPage();
  await loadKey(p, keys.ann.priv);
  await p.click('#tab-register');
  await p.fill('#reg-owner', 'Ann Smith, Bob Jones and Carol Jones');
  await p.fill('#reg-parcels', PARCEL);
  await p.setInputFiles('#co-file', keys['bob-carol'].card);
  await p.waitForFunction(() => /Added/.test(document.getElementById('co-status').textContent), null, { timeout: 60000 });
  await p.click('#reg-btn');
  await p.waitForSelector('#reg-result:not([hidden])');
  await p.click('#reg-next');
  await loadKey(p, keys['bob-carol'].priv);
  await p.click('#tab-register');
  await p.click('#reg-btn');
  await p.waitForFunction(() => /Complete/.test(document.getElementById('reg-status').textContent));
  const R0 = await save(p, '#dl-reg', '01-registration-ann-and-bob-carol.pdf');
  await p.close();
  check('1. Registration', pages(R0) >= 2, `individual + group key, both signed (${pages(R0)} pages)`, [R0]);

  // ---- 2. Sale 1: Ann + Bob/Carol sell to Dan/Eve (group) + Acme (position) ----
  p = await newPage();
  await loadKey(p, keys.ann.priv);
  await loadSignRegistration(p, R0);
  await p.selectOption('#tpl', 'warranty');
  for (const c of [keys['dan-eve'].card, keys.acme.card]) {
    await p.evaluate(() => (document.getElementById('buyer-status').textContent = ''));
    await p.setInputFiles('#buyer-file', c);
    await p.waitForFunction(() => /Added/.test(document.getElementById('buyer-status').textContent), null, { timeout: 60000 });
  }
  const grantee = await p.inputValue('#f-grantee');
  check('2. Grantee from buyer keys', grantee === 'Dan Lee, Eve Lee and Acme Holdings LLC', `"${grantee}"`);
  await p.fill('#f-legal', 'Lot 7, Example Tract.');
  await p.fill('#f-consideration', '$10 and other value');
  await signUntilComplete(p);
  await p.click('#next-signer');
  await loadKey(p, keys['bob-carol'].priv);
  await p.click('#tab-sign');
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => /every owner/.test(document.getElementById('tr-status').textContent), null, { timeout: 60000 });
  const sellersOnly = flat(await p.textContent('#tr-status'));
  const D1unproven = await save(p, '#dl-instrument', '02a-sale-1-deed-signed-by-sellers-buyers-not-yet-proven.pdf');
  await p.close();
  check('2. Sale 1 deed signed by both sellers', /0 of 2 buyer keys proven/.test(sellersOnly), sellersOnly, [D1unproven]);

  // The buyers prove they hold the keys: Dan and Eve on their own computer (from the PDF), Acme on the same one.
  p = await newPage();
  await loadKey(p, keys['dan-eve'].priv);
  await p.click('#tab-sign');
  await p.setInputFiles('#continue-file', D1unproven);
  await p.waitForFunction(() => /Loaded|already/.test(document.getElementById('continue-status').textContent), null, { timeout: 60000 });
  const label = await p.textContent('#text-sign-btn');
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => /1 of 2 buyer keys proven/.test(document.getElementById('tr-status').textContent), null, { timeout: 60000 });
  await p.click('#next-signer');
  await loadKey(p, keys.acme.priv);
  await p.click('#tab-sign');
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => /Complete: every owner signed and every buyer key proven/.test(document.getElementById('tr-status').textContent), null, { timeout: 60000 });
  const D1 = await save(p, '#dl-instrument', '02-sale-1-deed-to-dan-eve-and-acme.pdf');
  await p.close();
  const d1text = execFileSync('pdftotext', [D1, '-']).toString();
  check(
    '2. Buyers prove their keys',
    label === 'Prove my buyer key' && /COMPLETE: every buyer key \(2\) proved possession/.test(d1text.replace(/\s+/g, ' ')),
    `button "${label}"; Dan/Eve from the PDF, Acme on the same computer; the deed's registration-by-sale page says COMPLETE`,
    [D1],
  );

  // A deed whose buyers haven't proven their keys doesn't hand over the registration.
  {
    const r = await newPage();
    await r.click('#tab-verify');
    await r.setInputFiles('#v-reg-file', D1unproven);
    await r.waitForFunction(() => /Proof of key possession/.test(document.getElementById('v-reg-info').textContent), null, { timeout: 240000 });
    await r.waitForTimeout(1500);
    const info = flat(await r.textContent('#v-reg-info'));
    check('2. Unproven buyers: no registration by sale', /NOT COMPLETE/.test(info), info.match(/Proof of key possession[^.]*\./)?.[0] ?? info.slice(0, 100));
    await r.close();
  }

  let c = await checkDocument(R0, D1, { name: '03-sale-1-filing-original-and-certificate.pdf', original: true });
  check('3. Recorder checks sale 1', /GOOD/.test(c.verdict), c.verdict, [c.filed]);
  const F1 = c.filed;
  const F1both = (await checkDocument(R0, D1, { name: '03b-sale-1-filing-original-checked-copy-certificate.pdf', original: true, checked: true })).filed;
  const F1cert = (await checkDocument(R0, D1, { name: '03c-sale-1-filing-certificate-only.pdf' })).filed;

  // ---- Every form of the filing loads as the new registration, proven by sale ----
  for (const [label, f] of [
    ['original + certificate', F1],
    ['original + checked copy + certificate', F1both],
    ['certificate only', F1cert],
  ]) {
    const r = await newPage();
    const info = await loadSignRegistration(r, f);
    check(`4. Filing as registration (${label})`, /2 keys/.test(info) && /Registered by sale/.test(info), info.slice(0, 110), [f]);
    await r.close();
  }
  // A scan of the filing (200 dpi, tilted, JPEG)
  const scanDir = join(WORK, 'scan');
  mkdirSync(scanDir);
  execFileSync('pdftoppm', ['-r', '200', '-gray', '-png', F1, join(scanDir, 'p')]);
  const jpgs = readdirSync(scanDir).sort().map((x) => {
    const j = join(scanDir, x.replace('.png', '.jpg'));
    execFileSync('convert', [join(scanDir, x), '-rotate', '0.5', '-quality', '75', j]);
    return j;
  });
  const F1scan = join(OUT, '04-sale-1-filing-SCANNED.pdf');
  execFileSync('convert', [...jpgs, F1scan]);
  {
    const r = await newPage();
    await r.click('#tab-verify');
    await r.setInputFiles('#v-reg-file', F1scan);
    await r.waitForFunction(() => /Proof of key possession/.test(document.getElementById('v-reg-info').textContent), null, { timeout: 240000 });
    await r.waitForTimeout(1500);
    const info = flat(await r.textContent('#v-reg-info'));
    check('4. Scanned filing as registration', /Proof of key possession: by sale/.test(info), info.match(/Proof of key possession[^.]*\./)?.[0] ?? info.slice(0, 100), [F1scan]);
    await r.close();
  }

  // ---- 5. Sale 2: Dan/Eve and Acme (registration = the filing) sell to Ivy; Acme signs on another computer ----
  p = await newPage();
  await loadKey(p, keys['dan-eve'].priv);
  await loadSignRegistration(p, F1);
  await p.selectOption('#tpl', 'quitclaim');
  await p.setInputFiles('#buyer-file', keys.ivy.card);
  await p.waitForFunction(() => /Added/.test(document.getElementById('buyer-status').textContent), null, { timeout: 60000 });
  await p.fill('#f-legal', 'Lot 7, Example Tract.');
  await p.fill('#f-consideration', '$10');
  await signUntilComplete(p);
  const D2partial = await save(p, '#dl-instrument', '05-sale-2-deed-partly-signed.pdf');
  await p.close();
  p = await newPage();
  await loadKey(p, keys.acme.priv);
  await p.click('#tab-sign');
  await p.setInputFiles('#continue-file', D2partial);
  await p.waitForFunction(() => /Loaded|already/.test(document.getElementById('continue-status').textContent), null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const falseWarning = /not fully signed by its keys/.test(await p.textContent('#s-reg-info'));
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => /every owner/.test(document.getElementById('tr-status').textContent), null, { timeout: 60000 });
  // Ivy proves her key on the same computer.
  await p.click('#next-signer');
  await loadKey(p, keys.ivy.priv);
  await p.click('#tab-sign');
  await p.click('#text-sign-btn');
  await p.waitForFunction(() => /Complete: every owner signed and every buyer key proven/.test(document.getElementById('tr-status').textContent), null, { timeout: 60000 });
  const D2 = await save(p, '#dl-instrument', '05-sale-2-deed-to-ivy.pdf');
  await p.close();
  check('5. Second seller signs on their own computer', !falseWarning, falseWarning ? 'false "not fully signed" warning shown' : 'registration carried with the document, proof included; deed complete', [D2partial, D2]);

  c = await checkDocument(F1, D2, { name: '06-sale-2-filing-certificate-only.pdf' });
  check('6. Recorder checks sale 2 against the sale-1 filing', /GOOD/.test(c.verdict), c.verdict, [c.filed]);
  const F2 = c.filed;

  // ---- 7. Ivy signs a document with the certificate-only filing as her registration ----
  p = await newPage();
  await loadKey(p, keys.ivy.priv);
  const ivyReg = await loadSignRegistration(p, F2);
  check('7. Ivy loads the sale-2 certificate as her registration', /1 key/.test(ivyReg) && /Registered by sale/.test(ivyReg), ivyReg.slice(0, 110), [F2]);
  await p.selectOption('#tpl', 'ownership');
  await p.fill('#f-grantor', 'Ivy Chen');
  await p.fill('#f-terms', 'For the bank.');
  await signUntilComplete(p);
  const D3 = await save(p, '#dl-instrument', '07-ivy-statement-of-ownership.pdf');
  await p.close();
  c = await checkDocument(F2, D3, { name: '08-ivy-statement-filing-all-parts.pdf', original: true, checked: true });
  check('8. Ivy’s document checks against her filing', /GOOD/.test(c.verdict), c.verdict, [D3, c.filed]);

  // ---- Checks that must fail ----
  c = await checkDocument(R0, D3, null);
  check('9. Ivy’s document against the ORIGINAL registration fails', /DOES NOT VERIFY/.test(c.verdict), c.verdict);
  p = await newPage();
  await loadKey(p, keys.mallory.priv);
  await p.click('#tab-sign');
  await p.selectOption('#tpl', 'quitclaim');
  await p.fill('#f-grantor', 'Ivy Chen');
  await p.fill('#f-grantee', 'Mallory Fake');
  await p.fill('#f-parcels', PARCEL);
  await p.fill('#f-legal', 'Lot 7, Example Tract.');
  await p.fill('#f-consideration', '$1');
  await signUntilComplete(p);
  const forged = await save(p, '#dl-instrument', '09-FORGED-deed-signed-by-an-unregistered-key.pdf');
  await p.close();
  c = await checkDocument(F2, forged, null);
  check('9. Forged deed (unregistered key) against Ivy’s filing fails', /DOES NOT VERIFY/.test(c.verdict), c.verdict, [forged]);

  check('No page errors or network requests', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'none');
} catch (e) {
  check('Run', false, `stopped: ${String(e.message ?? e).split('\n')[0]}`);
} finally {
  await browser.close();
  rmSync(WORK, { recursive: true, force: true });
}

const date = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const report = [
  `# Build proof: ${VERSION}`,
  '',
  `- Build: \`dist/index.html\` SHA-256 \`${SHA}\``,
  `- Run: ${date}`,
  `- Result: **${failed ? `${failed} FAILED` : 'ALL PASSED'}** (${steps.length} checks)`,
  '',
  'The app itself (the built single file, in Chromium) went through the full ownership chain. Every PDF it',
  'made is in this folder. All keys are test keys made for this run (passphrase in `e2e/proof.mjs`).',
  '',
  '| | Step | Result | Files |',
  '|---|---|---|---|',
  ...steps.map((s) => `| ${s.ok ? 'PASS' : '**FAIL**'} | ${s.step} | ${s.detail.replace(/\|/g, '/')} | ${s.files.join(', ')} |`),
  '',
].join('\n');
writeFileSync(join(OUT, 'REPORT.md'), report);
console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}: proof/${VERSION}/REPORT.md`);
process.exit(failed ? 1 : 0);
