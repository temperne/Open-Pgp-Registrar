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
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  // ---- 10. Another county: the header button, on any tab; the PDFs follow ----
  p = await newPage();
  await loadKey(p, keys.ivy.priv);
  await p.click('#tab-sign');
  await p.click('#j-open');
  await p.selectOption('#j-county', 'Maricopa County');
  const office = await p.inputValue('#j-recorder');
  await p.click('#j-apply');
  await p.waitForTimeout(300);
  const heading = flat(await p.textContent('h1'));
  const bar = flat(await p.textContent('.jbar'));
  await p.click('#tab-key');
  const card = await save(p, '#dl-card', '10-another-county-key-card-maricopa.pdf');
  const cardText = flat(execFileSync('pdftotext', [card, '-']).toString());
  await p.close();
  check(
    '10. Change county from the header (Sign tab)',
    heading === 'Maricopa County S.T.O.P. Initiative' && office === 'Maricopa County Recorder' && /Working for Maricopa County, Arizona/.test(bar) && /not yet adopted by Maricopa County/.test(cardText) && !/Pima/.test(cardText),
    `chosen from the list; office "${office}"; heading "${heading}"; PDF footer names Maricopa County, no "Pima"`,
    [card],
  );

  // ---- 10b. Other states: the recording office and the county's own kind of name ----
  {
    const sp = await newPage();
    await loadKey(sp, keys.ivy.priv);
    await sp.click('#j-open');
    await sp.selectOption('#j-state', 'Texas');
    await sp.selectOption('#j-county', 'Harris County');
    const tx = await sp.inputValue('#j-recorder');
    await sp.selectOption('#j-state', 'Louisiana');
    await sp.selectOption('#j-county', 'Orleans Parish');
    const la = await sp.inputValue('#j-recorder');
    await sp.click('#j-apply');
    await sp.click('#tab-sign');
    await sp.selectOption('#tpl', 'warranty');
    const deedText = await sp.inputValue('#doc-text');
    const progName = flat(await sp.textContent('h1'));
    await sp.close();
    check(
      '10b. Recording offices and county names by state',
      tx === 'Harris County Clerk' && la === 'Orleans Parish Clerk of Court' && /Orleans Parish, Louisiana/.test(deedText) && !/Parish County/.test(deedText) && progName === 'Orleans Parish S.T.O.P. Initiative',
      `Texas: "${tx}"; Louisiana: "${la}"; the deed says "Orleans Parish, Louisiana"; program "${progName}"`,
    );
  }

  // ---- 11. Settings from the link, including a seal embedded in it ----
  {
    const seal = 'data:image/png;base64,' + execFileSync('convert', ['-size', '120x120', 'xc:white', '-fill', '#7a1f1f', '-draw', 'circle 60,60 60,6', 'png:-']).toString('base64');
    const q = new URLSearchParams({ county: 'Yavapai County', state: 'Arizona', name: 'Yavapai County S.T.O.P. Program', seal });
    const lp = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
    lp.on('pageerror', (e) => errors.push(e.message));
    lp.on('request', (r) => {
      if (!/^(file|blob|data):/.test(r.url())) errors.push(`network request: ${r.url()}`);
    });
    await lp.goto(`${APP}?${q}#key`);
    const heading = flat(await lp.textContent('h1'));
    const sealSrc = (await lp.getAttribute('#brand-seal', 'src')) ?? '';
    await loadKey(lp, keys.ivy.priv);
    const card = await save(lp, '#dl-card', '11-link-settings-key-card-yavapai.pdf');
    const cardText = flat(execFileSync('pdftotext', [card, '-']).toString());
    // The settings come back from the link the page makes.
    await lp.click('#j-open');
    await lp.click('#j-link');
    await lp.waitForTimeout(300);
    const made = await lp.textContent('#j-link-out');
    await lp.close();
    const again = await browser.newPage();
    await again.goto(`file://${new URL(made).pathname}${new URL(made).search}`);
    const heading2 = flat(await again.textContent('h1'));
    await again.close();
    check(
      '11. Settings from the link (with an embedded seal)',
      heading === 'Yavapai County S.T.O.P. Program' && sealSrc === seal && /not yet adopted by Yavapai County/.test(cardText) && heading2 === heading,
      `heading "${heading}"; seal from the link; PDF names Yavapai County; "Copy a link" round-trips`,
      [card],
    );
    // A seal at a web address is refused: the page never loads images from other servers.
    const bad = await browser.newPage();
    const badRequests = [];
    bad.on('request', (r) => {
      if (!/^(file|blob|data):/.test(r.url())) badRequests.push(r.url());
    });
    await bad.goto(`${APP}?${new URLSearchParams({ county: 'Pinal County', seal: 'https://example.com/seal.png' })}`);
    const msg = flat(await bad.textContent('#boot'));
    await bad.close();
    check('11. A seal at a web address is refused', /never loads images from other servers/.test(msg) && badRequests.length === 0, `"${msg.slice(0, 90)}"; requests: ${badRequests.length}`);
  }

  // ---- 13. Link builder, state seals, and "Download this county's program" ----
  {
    const pg = await newPage();
    const pimaSeal = await pg.getAttribute('#brand-seal', 'src');
    await pg.click('#j-open');
    await pg.selectOption('#j-state', 'Texas');
    await pg.selectOption('#j-county', 'Harris County');
    const preview = await pg.getAttribute('#j-seal-preview', 'src');
    await pg.click('#link-api summary');
    await pg.selectOption('#lb-tab', 'register');
    await pg.waitForTimeout(100);
    const built = await pg.inputValue('#lb-out');
    await pg.fill('#lb-host', 'https://harris-county-stop.example.workers.dev');
    await pg.check('#lb-rooms');
    const zip = await save(pg, '#lb-package', '13-harris-county-program.zip');
    await pg.click('#j-apply');
    const sealNow = await pg.getAttribute('#brand-seal', 'src');
    await pg.close();
    // The link it built opens with the same settings.
    const lp = await browser.newPage();
    await lp.goto(`${APP}${built.slice(built.indexOf('?'))}`);
    const linkHeading = flat(await lp.textContent('h1'));
    await lp.close();
    // The package: unzip it and open its HTML.
    const unz = join(WORK, 'pkg');
    mkdirSync(unz);
    execFileSync('unzip', ['-q', zip, '-d', unz]);
    const dir = join(unz, readdirSync(unz)[0]);
    const files = ['public/index.html', 'src/index.ts', 'wrangler.toml', 'package.json', 'README.md'].filter((f) => {
      try {
        readFileSync(join(dir, f));
        return true;
      } catch {
        return false;
      }
    });
    const html = readFileSync(join(dir, 'public/index.html'), 'utf8');
    const csp = /connect-src [^;"]*/.exec(html)?.[0] ?? '';
    const cp = await browser.newPage({ acceptDownloads: true });
    cp.on('pageerror', (e) => errors.push(e.message));
    await cp.goto(pathToFileURL(join(dir, 'public/index.html')).href);
    const copyHeading = flat(await cp.textContent('h1'));
    const copySeal = await cp.getAttribute('#brand-seal', 'src');
    await cp.click('#j-open');
    const copyOffice = await cp.inputValue('#j-recorder');
    await loadKey(cp, keys.ivy.priv);
    const card = await save(cp, '#dl-card', '13-harris-county-copy-key-card.pdf');
    await cp.close();
    const cardText = flat(execFileSync('pdftotext', [card, '-']).toString());
    check(
      '13. State seal switches with the state',
      preview !== pimaSeal && sealNow === preview && /^data:image\/png/.test(sealNow ?? ''),
      'choosing a Texas county shows the Texas seal in the preview and the header',
    );
    check('13. Link builder', /county=Harris\+County|county=Harris%20County/.test(built) && built.endsWith('#register') && linkHeading === 'Harris County S.T.O.P. Initiative', `"${built.slice(0, 120)}..." opens as "${linkHeading}"`);
    check(
      '13. Download this county\u2019s program',
      files.length === 5 &&
        csp.includes('harris-county-stop.example.workers.dev') &&
        csp.includes('wss://harris-county-stop.example.workers.dev') &&
        !csp.includes('wss://pimastopinitiative') &&
        copyHeading === 'Harris County S.T.O.P. Initiative' &&
        copyOffice === 'Harris County Clerk' &&
        copySeal === sealNow &&
        /not yet adopted by Harris County/.test(cardText) &&
        /harris-county-stop\.example\.workers\.dev/.test(cardText),
      `zip: ${files.join(', ')}; the copy opens as "${copyHeading}", office "${copyOffice}", Texas seal; its rooms connect only to its own address (the master site only over https, for the update check); its PDFs name Harris County and its address`,
      [zip, card],
    );
  }

  // ---- 13b. A signed release: the maker names themselves, signs the program file, and posts a statement ----
  {
    const pg = await newPage();
    await loadKey(pg, keys.ivy.priv);
    await pg.click('#j-open');
    await pg.selectOption('#j-state', 'Texas');
    await pg.selectOption('#j-county', 'Harris County');
    await pg.click('#link-api summary');
    await pg.fill('#lb-host', 'https://harris-county-stop.example.workers.dev');
    await pg.fill('#lb-pub-name', 'Harris County Clerk Office');
    await pg.fill('#lb-pub-title', 'Chief Deputy Clerk');
    await pg.fill('#lb-pub-site', 'https://clerk.example.gov/stop');
    await pg.check('#lb-sign');
    const zip = await save(pg, '#lb-package', '13b-signed-program.zip');
    const statement = await save(pg, '#lb-statement', '13b-release-statement.pdf');
    await pg.close();
    const unz = join(WORK, 'pkg-signed');
    mkdirSync(unz);
    execFileSync('unzip', ['-q', zip, '-d', unz]);
    const dir = join(unz, readdirSync(unz)[0]);
    const htmlPath = join(dir, 'public/index.html');
    const sha = createHash('sha256').update(readFileSync(htmlPath)).digest('hex');
    const zipSha = createHash('sha256').update(readFileSync(zip)).digest('hex');
    const stText = flat(execFileSync('pdftotext', [statement, '-']).toString()).replace(/\s+/g, '');
    // Stock GnuPG, with the files in the zip.
    const home = join(WORK, 'gnupg-release');
    mkdirSync(home, { mode: 0o700 });
    const gpg = (...a) => execFileSync('gpg', ['--homedir', home, '--batch', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
    gpg('--import', join(dir, 'publisher-key.asc'));
    let gpgOk = false;
    try {
      gpg('--verify', join(dir, 'index.html.sig'), htmlPath);
      gpgOk = true;
    } catch {
      gpgOk = false;
    }
    // The program's own check, with only the file and the statement (its key is attached).
    const tampered = join(WORK, 'index-tampered.html');
    writeFileSync(tampered, readFileSync(htmlPath, 'utf8').replace('Harris County', 'Harris  County'));
    const binCheck = async (file) => {
      const r = await newPage();
      await r.click('#tab-verify');
      await r.click('#bin-check summary');
      await r.setInputFiles('#bin-v-file', file);
      await r.setInputFiles('#bin-v-sig', statement);
      await r.click('#bin-v-btn');
      await r.waitForSelector('#vr-banner strong', { timeout: 60000 });
      const v = flat(await r.textContent('#vr-banner strong'));
      const shown = flat(await r.textContent('#verify-result').catch(() => ''));
      await r.close();
      return { v, shown };
    };
    const good = await binCheck(htmlPath);
    const bad = await binCheck(tampered);
    const copy = await browser.newPage();
    await copy.goto(pathToFileURL(htmlPath).href);
    const pub = flat(await copy.textContent('#copy-publisher'));
    await copy.close();
    check(
      '13b. Signed release statement',
      gpgOk &&
        stText.includes(sha) &&
        stText.includes(zipSha) &&
        stText.includes('HarrisCountyClerkOffice') &&
        stText.includes('ChiefDeputyClerk') &&
        /GOOD/.test(good.v) &&
        /DOES NOT VERIFY/.test(bad.v) &&
        /Harris County Clerk Office/.test(pub),
      `the statement names the publisher and carries the file's SHA-256 (${sha.slice(0, 16)}...) and the zip's; gpg --verify index.html.sig passes; the program's check with only the file and the statement: ${good.v}; a changed file: ${bad.v}; the copy names its publisher`,
      [zip, statement],
    );
  }

  // ---- 12. Sign together, live: two owners in a signing room, through a test relay ----
  {
    const sockets = new Map(); // room -> Set of server-side routes
    const seen = [];
    const relay = async (page) => {
      await page.routeWebSocket(/\/relay\//, (ws) => {
        const id = new URL(ws.url()).pathname.split('/').pop();
        const set = sockets.get(id) ?? new Set();
        sockets.set(id, set);
        for (const other of set) other.send(JSON.stringify({ relay: 'joined', tabs: set.size + 1 }));
        set.add(ws);
        ws.send(JSON.stringify({ relay: 'welcome', tabs: set.size }));
        ws.onMessage((m) => {
          seen.push(String(m));
          for (const other of set) if (other !== ws) other.send(m);
        });
        ws.onClose(() => set.delete(ws));
      });
    };
    // Sign together works only on the program's exact address: serve the built file there
    // (answered locally by the test; nothing goes to the internet).
    const OFFICIAL = 'https://pimastopinitiative.jasonajensen.workers.dev/';
    const html = readFileSync(DIST);
    const atOfficial = async (page) => {
      await page.route(`${OFFICIAL}**`, (r) => r.fulfill({ body: html, contentType: 'text/html' }));
      await relay(page);
      page.on('pageerror', (e) => errors.push(e.message));
    };
    // A saved copy (file://) can't sign together, even with a key unlocked.
    const local = await newPage();
    await loadKey(local, keys.ann.priv);
    await local.click('#tab-sign');
    const localBlocked = (await local.isDisabled('#room-enable')) && /works only on the program/.test(await local.textContent('#room-where'));
    await local.close();
    const a = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
    await atOfficial(a);
    await a.goto(OFFICIAL);
    await loadKey(a, keys.ann.priv);
    await loadSignRegistration(a, R0);
    // Off until the terms are accepted and it is turned on.
    const offFirst = (await a.isDisabled('#room-start')) && (await a.isDisabled('#room-enable'));
    await a.check('#room-agree');
    const agreedNotOn = (await a.isEnabled('#room-enable')) && (await a.isDisabled('#room-start'));
    await a.check('#room-enable');
    await a.click('#room-start');
    await a.waitForFunction(() => /Connected/.test(document.getElementById('room-status').textContent), null, { timeout: 30000 });
    const link = await a.inputValue('#room-link');
    const b = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
    await atOfficial(b);
    await b.goto(link);
    // Asked first, and not possible without an unlocked key.
    const invited = (await b.isVisible('#room-invite-top')) && (await b.isDisabled('#room-enable'));
    await loadKey(b, keys['bob-carol'].priv);
    await b.click('#tab-sign');
    await b.check('#room-agree');
    await b.check('#room-enable');
    await b.click('#room-join');
    await b.waitForFunction(() => /2 tabs/.test(document.getElementById('room-status').textContent), null, { timeout: 30000 });
    await a.waitForFunction(() => /proven by their key/.test(document.getElementById('room-peers').textContent), null, { timeout: 30000 });
    // Ann writes and signs; Bob and Carol's tab receives it and adds their signature.
    await a.click('#tab-sign');
    await a.selectOption('#tpl', 'ownership');
    await a.fill('#f-grantor', 'Ann Smith, Bob Jones and Carol Jones');
    await a.fill('#f-terms', 'For the bank.');
    await a.click('#text-sign-btn');
    await b.waitForFunction(() => /Not complete: 1 of 2/.test(document.getElementById('tr-status').textContent), null, { timeout: 30000 });
    await b.click('#text-sign-btn');
    await a.waitForFunction(() => /Complete/.test(document.getElementById('tr-status').textContent), null, { timeout: 30000 });
    const roomDoc = await save(a, '#dl-instrument', '12-signed-together-in-a-room.pdf');
    await a.close();
    await b.close();
    const leaked = seen.some((m) => /OWNERSHIP|222-33-4444|BEGIN PGP/i.test(m));
    const c = await checkDocument(R0, roomDoc, null);
    check(
      '12. Sign together in a signing room',
      localBlocked && link.startsWith(`${OFFICIAL}#room=`) && offFirst && agreedNotOn && invited && !leaked && /GOOD/.test(c.verdict),
      `unavailable in a saved copy; on ${OFFICIAL} off until the terms of service and waiver are accepted and it is turned on, and only with an unlocked key; the link asks before joining; peers proven by their keys; ${seen.length} relay messages, all encrypted; the result checks ${c.verdict}`,
      [roomDoc],
    );
  }

  // ---- Signing rooms with more people, registrations and files (12b-12d), through a test relay ----
  const OFFICIAL_URL = 'https://pimastopinitiative.jasonajensen.workers.dev/';
  const roomSeen = [];
  const roomSockets = new Map();
  const distHtml = readFileSync(DIST);
  async function roomTab() {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.route(`${OFFICIAL_URL}**`, (r) => r.fulfill({ body: distHtml, contentType: 'text/html' }));
    await page.routeWebSocket(/\/relay\//, (ws) => {
      const id = new URL(ws.url()).pathname.split('/').pop();
      const set = roomSockets.get(id) ?? new Set();
      roomSockets.set(id, set);
      for (const other of set) other.send(JSON.stringify({ relay: 'joined', tabs: set.size + 1 }));
      set.add(ws);
      ws.send(JSON.stringify({ relay: 'welcome', tabs: set.size }));
      ws.onMessage((m) => {
        roomSeen.push(String(m));
        for (const other of set) if (other !== ws) other.send(m);
      });
      ws.onClose(() => set.delete(ws));
    });
    return page;
  }
  /** Opens one tab per key, all in one room, each seeing the others proven by their keys. */
  async function openRoom(ids, prepare, paste = false) {
    const tabs = [];
    let link = '';
    for (const [i, id] of ids.entries()) {
      const p = await roomTab();
      // Joiners open the link, or (paste) already have the page open and paste the link in.
      await p.goto(i && !paste ? link : OFFICIAL_URL);
      await loadKey(p, keys[id].priv);
      if (prepare) await prepare(p, i);
      await p.click('#tab-sign');
      await p.check('#room-agree');
      await p.check('#room-enable');
      if (i === 0) {
        await p.click('#room-start');
        await p.waitForFunction(() => /Connected/.test(document.getElementById('room-status').textContent), null, { timeout: 30000 });
        link = await p.inputValue('#room-link');
      } else if (paste) {
        // The key is already unlocked, and stays: no reload.
        await p.fill('#room-code', link);
        await p.click('#room-code-join');
        await p.waitForFunction(() => /Connected/.test(document.getElementById('room-status').textContent), null, { timeout: 30000 });
      } else {
        await p.click('#room-join');
        await p.waitForFunction(() => /Connected/.test(document.getElementById('room-status').textContent), null, { timeout: 30000 });
      }
      tabs.push(p);
    }
    for (const p of tabs) {
      await p.waitForFunction((n) => (document.getElementById('room-peers').textContent.match(/proven by their key/g) ?? []).length >= n, ids.length - 1, { timeout: 30000 });
    }
    const peerCounts = await Promise.all(tabs.map((p) => p.evaluate(() => (document.getElementById('room-peers').textContent.match(/proven by their key/g) ?? []).length)));
    return { tabs, peerCounts };
  }
  const status = (p, id, re) => p.waitForFunction(([id, re]) => new RegExp(re).test(document.getElementById(id).textContent), [id, re], { timeout: 60000 });

  // ---- 12b. Four signers, each in their own tab; two sign at the same moment ----
  {
    const ids = ['ann', 'bob-carol', 'dan-eve', 'acme'];
    const { tabs, peerCounts } = await openRoom(ids);
    const [a, b, c, d] = tabs;
    await a.selectOption('#tpl', 'ownership');
    await a.fill('#f-grantor', 'Ann Smith, Bob Jones, Carol Jones, Dan Lee, Eve Lee and Acme Holdings LLC');
    await a.fill('#f-terms', 'A four-key agreement for the bank.');
    await a.fill('#f-parcels', '333-44-5555');
    await a.click('#text-sign-btn');
    for (const p of [b, c, d]) await status(p, 'tr-status', '^1 signed');
    await b.click('#text-sign-btn');
    for (const p of [c, d]) await status(p, 'tr-status', '^2 signed');
    // The third and fourth sign at the same moment: every tab must still end with all four.
    await Promise.all([c.click('#text-sign-btn'), d.click('#text-sign-btn')]);
    for (const p of tabs) await status(p, 'tr-status', '^4 signed');
    await a.click('summary:has-text("For GnuPG users: signed text")');
    const txt = await save(a, '#dl-text-txt', '12b-four-signers.txt');
    const sig = await save(a, '#dl-text-sig', '12b-four-signers.txt.sig');
    const roomDoc = await save(b, '#dl-instrument', '12b-four-signers-in-a-room.pdf');
    for (const p of tabs) await p.close();
    // Stock GnuPG: each of the four signatures verifies.
    // A short home directory: gpg's agent socket path has a length limit.
    const home = mkdtempSync(join(tmpdir(), 'stop-gpg-'));
    for (const id of ids) {
      const out = join(WORK, `card-${id}`);
      mkdirSync(out);
      execFileSync('pdfdetach', ['-saveall', '-o', out, keys[id].card]);
      for (const f of readdirSync(out)) if (f.endsWith('.asc')) execFileSync('gpg', ['--homedir', home, '--batch', '--import', join(out, f)], { stdio: 'ignore' });
    }
    let out = '';
    try {
      out = execFileSync('gpg', ['--homedir', home, '--batch', '--status-fd', '1', '--verify', sig, txt], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    const good = (out.match(/^\[GNUPG:\] GOODSIG/gm) ?? []).length;
    check(
      '12b. Sign together with four signers',
      peerCounts.every((n) => n === 3) && good === 4,
      `four tabs (an individual, two groups, a company position) in one room, each seeing the other three proven by their keys; two signed at the same moment and every tab still ended with all 4 signatures; gpg --verify: ${good} good signatures`,
      [roomDoc, txt, sig],
    );
  }

  // ---- 12c. A registration signed together in a room ----
  {
    // The second key holder already has the page open with their key unlocked: they paste the room link.
    const { tabs } = await openRoom(['ann', 'bob-carol'], null, true);
    const [a, b] = tabs;
    const keptKey = /Unlocked/.test(await b.textContent('#key-status'));
    await a.click('#tab-register');
    await a.fill('#reg-owner', 'Ann Smith, Bob Jones and Carol Jones');
    await a.fill('#reg-parcels', '444-55-6666');
    // Nobody adds the other key by hand: the room offers it, and signing asks to add it (the test says yes).
    const offer = flat(await a.textContent('#co-room'));
    const offered = (await a.isVisible('#co-room')) && /Bob Jones/.test(offer);
    const asked = [];
    a.on('dialog', (dlg) => asked.push(dlg.message()));
    await a.click('#reg-btn');
    await status(a, 'reg-status', 'Not complete: 1 of 2');
    await status(b, 'reg-status', 'Not complete: 1 of 2');
    await b.click('#tab-register');
    const owner = await b.inputValue('#reg-owner');
    const cardMoved = await b.evaluate(() => !!document.querySelector('[data-room-slot="register"] #room-card'));
    await b.click('#reg-btn');
    for (const p of tabs) await status(p, 'reg-status', 'Complete');
    const reg = await save(a, '#dl-reg', '12c-registration-signed-in-a-room.pdf');
    for (const p of tabs) await p.close();
    const r = await newPage();
    await r.click('#tab-verify');
    await r.setInputFiles('#v-reg-file', reg);
    await r.waitForFunction(() => /Proof of key possession|error|not a registration/i.test(document.getElementById('v-reg-info').textContent), null, { timeout: 240000 });
    const info = flat(await r.textContent('#v-reg-info'));
    await r.close();
    check(
      '12c. A registration signed together in a room',
      keptKey && offered && asked.some((m) => /in the signing room but not on this registration/.test(m)) &&
        owner === 'Ann Smith, Bob Jones and Carol Jones' && cardMoved && /Proof of key possession: every/.test(info),
      `the second key holder joined by pasting the room link into the page they had open (key still unlocked); the room offered their proven key ("${offer.slice(0, 60)}...") and signing asked to add it; the second key holder's tab received the registration (owner "${owner}"), the room card followed them to the Register tab, both signed, and the form reads "${info.slice(0, 90)}"`,
      [reg],
    );
  }

  // ---- 12d. A file signed together in a room ----
  {
    const file = join(WORK, 'lease-addendum.txt');
    writeFileSync(file, 'Lease addendum. The tenant may keep one small dog. Signed by the owners of record.\n');
    const { tabs } = await openRoom(['ann', 'bob-carol'], async (p, i) => {
      if (i === 0) await loadSignRegistration(p, R0);
    });
    const [a, b] = tabs;
    await a.click('#tab-sign');
    await a.setInputFiles('#src-file', file);
    await a.waitForSelector('#src-clear:not([hidden])', { timeout: 60000 });
    await a.check('#parcel-ready');
    await a.click('#text-sign-btn');
    await status(b, 'tr-status', 'Not complete: 1 of 2');
    const gotFile = flat(await b.textContent('#src-info'));
    await b.click('#text-sign-btn');
    for (const p of tabs) await status(p, 'tr-status', 'Complete');
    const pkgPdf = await save(b, '#dl-instrument', '12d-file-signed-in-a-room.pdf');
    for (const p of tabs) await p.close();
    const c = await checkDocument(R0, pkgPdf, null);
    check(
      '12d. A file signed together in a room',
      /lease-addendum/.test(gotFile) && /GOOD/.test(c.verdict),
      `the second owner's tab received the file itself ("${gotFile.slice(0, 60)}") and the first signature, added theirs, and the package checks ${c.verdict}`,
      [pkgPdf],
    );
    const leaked = roomSeen.some((m) => /LEASE ADDENDUM|small dog|OWNERSHIP|444-55-6666|BEGIN PGP/i.test(m));
    check('12. Signing rooms carry only ciphertext', !leaked && roomSeen.length > 0, `${roomSeen.length} relay messages in steps 12b-12d, none readable`);
  }

  // ---- 15. Update check: only once the person connects; offers the newest version with the same settings ----
  {
    const COPY = 'https://harris-county-stop.example.workers.dev/';
    const MASTER = 'https://pimastopinitiative.jasonajensen.workers.dev';
    const dist = readFileSync(DIST, 'utf8');
    const end = dist.lastIndexOf('</head>');
    const cfg = { name: 'Harris County S.T.O.P. Initiative', county: 'Harris County', state: 'Texas', recorderOffice: 'Harris County Clerk', projectUrl: COPY, relayUrl: COPY.slice(0, -1) };
    const copyHtml = `${dist.slice(0, end)}<script type="application/json" id="stop-config">${JSON.stringify(cfg)}</script>${dist.slice(end)}`;
    const visit = async (built) => {
      const pg = await browser.newPage({ acceptDownloads: true });
      pg.on('pageerror', (e) => errors.push(e.message));
      const toMaster = [];
      pg.on('request', (r) => {
        if (r.url().startsWith(MASTER)) toMaster.push(r.url());
      });
      await pg.route(`${COPY}**`, (r) => r.fulfill({ body: copyHtml, contentType: 'text/html' }));
      await pg.route(
        (u) => u.href.startsWith(`${MASTER}/?check`),
        (r) => r.fulfill({ body: `<!doctype html>\n<html lang="en">\n<head>\n    <!-- S.T.O.P. stop-version=v0.1.99999999 built=${built} -->\n`, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' } }),
      );
      await pg.goto(COPY);
      await loadKey(pg, keys.ivy.priv);
      await pg.click('#tab-sign');
      const masterLink = (await pg.getAttribute('#room-master-link', 'href')) ?? '';
      const before = toMaster.length;
      await pg.check('#room-agree');
      await pg.check('#room-enable');
      await pg.waitForTimeout(1500);
      const offered = await pg.isVisible('#update-offer');
      const link = offered ? ((await pg.getAttribute('#update-link', 'href')) ?? '') : '';
      await pg.close();
      return { before, after: toMaster.length, offered, link, masterLink };
    };
    const newer = await visit('2099-01-01T00:00:00Z');
    const older = await visit('2000-01-01T00:00:00Z');
    const versionLine = dist.split('\n').findIndex((l) => /stop-version=v/.test(l)) + 1;
    check(
      '15. Update check',
      versionLine > 0 &&
        versionLine <= 5 &&
        newer.before === 0 &&
        newer.after === 1 &&
        newer.offered &&
        newer.link.startsWith(`${MASTER}/?`) &&
        /county=Harris\+County/.test(newer.link) &&
        /recorder=Harris\+County\+Clerk/.test(newer.link) &&
        !older.offered &&
        newer.masterLink.startsWith(`${MASTER}/?`) &&
        /county=Harris\+County/.test(newer.masterLink),
      `the version is on line ${versionLine} of index.html; a county copy asks nothing until Sign together is turned on, then makes one request to the master site; a newer version is offered with the same settings (${newer.link.slice(0, 90)}...); an older one is not; the copy always offers signing together on the master site with its settings`,
    );
  }

  // ---- 14. Usage analytics: asked first, loaded only if allowed ----
  {
    const OFFICIAL = 'https://pimastopinitiative.jasonajensen.workers.dev/';
    const dist = readFileSync(DIST, 'utf8');
    const end = dist.lastIndexOf('</head>');
    // A test token, carried the way a county copy carries its settings.
    const withToken = `${dist.slice(0, end)}<script type="application/json" id="stop-config">{"analyticsToken":"0123456789abcdef0123456789abcdef"}</script>${dist.slice(end)}`;
    const visit = async (answer) => {
      const pg = await browser.newPage();
      const seen = [];
      pg.on('request', (r) => {
        if (!r.url().startsWith(OFFICIAL)) seen.push(r.url());
      });
      await pg.route(`${OFFICIAL}**`, (r) => r.fulfill({ body: withToken, contentType: 'text/html' }));
      await pg.route('https://static.cloudflareinsights.com/**', (r) => r.fulfill({ body: '/* test beacon */', contentType: 'text/javascript' }));
      await pg.goto(OFFICIAL);
      await pg.waitForTimeout(500);
      const asked = await pg.isVisible('#analytics-ask');
      const before = seen.length;
      if (answer) await pg.click(answer);
      await pg.waitForTimeout(500);
      const beacon = await pg.getAttribute('script[src*="cloudflareinsights"]', 'data-cf-beacon').catch(() => null);
      await pg.close();
      return { asked, before, after: [...seen], beacon };
    };
    const no = await visit('#analytics-no');
    const yes = await visit('#analytics-yes');
    const local = await newPage();
    const localAsked = await local.isVisible('#analytics-ask');
    await local.close();
    check(
      '14. Usage analytics asked first',
      no.asked && no.before === 0 && no.after.length === 0 && yes.asked && yes.before === 0 && yes.after.every((u) => u.startsWith('https://static.cloudflareinsights.com/')) && yes.after.length >= 1 && /0123456789abcdef/.test(yes.beacon ?? '') && !localAsked,
      `asked on the web, never in a saved copy; nothing loaded before an answer; "No thanks": no requests; "Allow": only ${yes.after.map((u) => new URL(u).host).join(', ') || 'none'}`,
    );
  }

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
