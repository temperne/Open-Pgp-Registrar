import './style.css';
import type * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  summarize,
  isPrivate,
  signDocument,
  verifyFiling,
  signText,
  verifyScannedText,
  keyFromCodes,
  codesHaveKey,
  scanProgress,
  type SignedText,
  formatFingerprint,
  type AnyKey,
  type SignedDocument,
  type Verdict,
} from './crypto';
import {
  registrationPdf,
  signaturePagePdf,
  printCopyPdf,
  privateKeyPdf,
  keyTextFromPdf,
  isPdfBytes,
  instrumentPdf,
  setBrandSeal,
  type SignaturePageInfo,
} from './pdf';
import { BRAND } from './brand';
import { TEMPLATES, DISCLAIMER, type TemplateFields } from './templates';
import { firstDifference, canonicalText } from './text';

// ---------------------------------------------------------------------------
// In-memory state only. Nothing is written to storage or sent anywhere.
// ---------------------------------------------------------------------------
interface State {
  key: AnyKey | null;
  /** Unlocked private key, ready to sign. */
  signer: openpgp.PrivateKey | null;
  /** Private key exactly as it should be saved (passphrase-protected if it had one). */
  privateArmored: string | null;
  /** A freshly generated key that has not been downloaded yet. */
  unsaved: boolean;
  signed: { doc: SignedDocument; file: File; bytes: Uint8Array; info: SignaturePageInfo } | null;
  /** Last signed text document. */
  signedText: { result: SignedText; title: string; text: string; returnTo: string; signers: string } | null;
}
const state: State = { key: null, signer: null, privateArmored: null, unsaved: false, signed: null, signedText: null };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const textarea = (id: string) => $<HTMLTextAreaElement>(id);

/** Shows a problem in the banner at the top, so failures are never silent. */
function banner(message: string) {
  const b = $('boot');
  b.hidden = false;
  b.textContent = message;
}
window.addEventListener('error', (e) => banner(`Something went wrong: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => banner(`Something went wrong: ${(e.reason as Error)?.message ?? e.reason}`));

// ---------------------------------------------------------------------------
// Actions
//
// Buttons are type="button" with click handlers instead of relying on form
// submission: preview windows and embedded viewers often sandbox the page in a
// way that silently blocks form submits. Enter in a field still works where
// the browser allows it.
// ---------------------------------------------------------------------------
class UserError extends Error {}

function errorSlot(btn: HTMLElement) {
  return (btn.closest('form, .card') ?? document.body).querySelector<HTMLElement>('[data-error]');
}

function action(buttonId: string, handler: (btn: HTMLButtonElement) => Promise<void> | void, busyLabel = 'Working...') {
  const btn = $<HTMLButtonElement>(buttonId);
  const run = async () => {
    if (btn.disabled) return;
    const slot = errorSlot(btn);
    if (slot) slot.textContent = '';
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await handler(btn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (slot) {
        slot.textContent = msg;
        slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        banner(msg);
      }
      if (!(err instanceof UserError)) console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  btn.addEventListener('click', run);
  btn.closest('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
}

function need(value: string, message: string) {
  if (!value.trim()) throw new UserError(message);
  return value.trim();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ['about', 'key', 'register', 'sign', 'verify'] as const;
type Tab = (typeof TABS)[number];

function showTab(name: Tab, focus = false) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
  try {
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  } catch {
    /* not allowed in some sandboxed previews; the hash is only a convenience */
  }
  refresh();
  window.scrollTo({ top: 0 });
}

TABS.forEach((t, i) => {
  const btn = $(`tab-${t}`);
  btn.addEventListener('click', () => showTab(t));
  btn.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step) showTab(TABS[(i + step + TABS.length) % TABS.length], true);
  });
});
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
  if (a) {
    e.preventDefault();
    showTab(a.dataset.goto as Tab);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function download(data: Uint8Array | string, filename: string, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileSlug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'parcel'
  );
}

/** "Jane Doe <jane@x>" -> "Jane Doe" */
function nameFromUserID(uid: string) {
  return uid.replace(/\s*<[^>]*>\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

const shortFpr = (fpr: string) => fpr.slice(-16);

function fromBase64Text(b64: string) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

/** Reads a key from a PDF made by this tool, or from any OpenPGP key file or text. */
function isImage(f: File) {
  return f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?)$/i.test(f.name);
}

/**
 * Reads a key from any of: a PDF made by this tool (key embedded), a photo or
 * scan of a printed key page or registration form (QR codes), or a key file.
 */
async function keyFromFile(file: File, onProgress?: (msg: string) => void): Promise<AnyKey> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fromCodes = async () => {
    const { readCodesFromFile } = await import('./qrscan');
    return keyFromCodes(await readCodesFromFile(file, onProgress, codesHaveKey));
  };
  if (isImage(file)) return fromCodes();
  if (isPdfBytes(bytes)) {
    try {
      return await readAnyKey(await keyTextFromPdf(bytes));
    } catch {
      return fromCodes(); // a scanned PDF of the printed page
    }
  }
  return readAnyKey(bytes);
}

/** state.key keeps the key as loaded; unlocking makes a separate copy, so this reflects the file itself. */
function isUnprotected(k: AnyKey) {
  return isPrivate(k) && k.isDecrypted();
}

function isReplacement() {
  return document.querySelector<HTMLInputElement>('input[name="reg-kind"]:checked')?.value === 'replacement';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function refresh() {
  const k = state.key;
  $('key-current').hidden = !k;
  $('key-choose').hidden = !!k;

  if (k) {
    const s = summarize(k);
    $('key-fpr').textContent = formatFingerprint(s.fingerprint);
    $('key-uid').textContent = s.userIDs.join(', ') || '(none)';
    $('key-alg').textContent = s.algorithm;
    $('key-created').textContent = s.created.toISOString().slice(0, 10);
    const status = $('key-status');
    if (!s.hasPrivate) {
      status.textContent = 'Public key only';
      status.className = 'pill';
    } else if (state.signer) {
      status.textContent = 'Unlocked, ready to sign';
      status.className = 'pill good';
    } else {
      status.textContent = 'Locked';
      status.className = 'pill';
    }
    $('unlock-form').hidden = !s.hasPrivate || !!state.signer;
    $('save-warning').hidden = !state.unsaved;
    $('nopass-warning').hidden = !isUnprotected(k);
    $('dl-private').hidden = !state.privateArmored;
    $('dl-private-asc').hidden = !state.privateArmored;
    $('private-hint').hidden = !state.privateArmored;
  }

  // Register
  document.querySelector<HTMLElement>('#panel-register .needs-key')!.hidden = !!k;
  $('reg-form').hidden = !k;
  if (k && !input('reg-owner').value) input('reg-owner').value = nameFromUserID(k.getUserIDs()[0] ?? '');
  $('reg-prev-wrap').hidden = !isReplacement();

  // Sign
  const needEl = document.querySelector<HTMLElement>('#panel-sign .needs-private')!;
  if (!k) {
    needEl.innerHTML = 'First <a href="#key" data-goto="key">create or load your private key</a>.';
  } else if (!isPrivate(k)) {
    needEl.innerHTML =
      'Signing needs the <strong>private</strong> key. The key loaded in <a href="#key" data-goto="key">step 1</a> is public only.';
  } else if (!state.signer) {
    needEl.innerHTML = 'Unlock your private key with its passphrase in <a href="#key" data-goto="key">step 1</a> first.';
  }
  needEl.hidden = !!state.signer;
  $('sign-area').hidden = !state.signer;
  if (!input('sign-parcels').value && input('reg-parcels').value) input('sign-parcels').value = input('reg-parcels').value;
  // Carry details from the registration step into the document fields.
  let carried = false;
  for (const [from, to] of [
    ['reg-parcels', 'f-parcels'],
    ['reg-owner', 'f-grantor'],
    ['reg-property', 'f-propertyAddress'],
    ['reg-county', 'f-county'],
  ] as const) {
    const v = input(from).value.trim().replace(/\s+County$/i, '');
    if (v && !input(to).value) {
      input(to).value = v;
      carried = true;
    }
  }
  if (carried) syncTemplate();

  // Verify
  $('v-use-mine').hidden = !k;
}

// ---------------------------------------------------------------------------
// Step 1: key
// ---------------------------------------------------------------------------
function setKey(key: AnyKey, privateArmored: string | null, unsaved: boolean, signer: openpgp.PrivateKey | null) {
  state.key = key;
  state.signer = signer ?? (isPrivate(key) && key.isDecrypted() ? key : null);
  state.privateArmored = privateArmored;
  state.unsaved = unsaved;
  state.signed = null;
  state.signedText = null;
  $('sign-result').hidden = true;
  $('text-result').hidden = true;
  $('dl-note').textContent = '';
  input('reg-owner').value = '';
  refresh();
}

action(
  'gen-btn',
  async () => {
    const name = need(input('gen-name').value, 'Enter your full name.');
    const pass = input('gen-pass').value;
    if (pass.length < 8) throw new UserError('Use a passphrase of at least 8 characters.');
    if (pass !== input('gen-pass2').value) throw new UserError('The two passphrases do not match.');
    const { privateArmored } = await generateKeyPair({ name, email: input('gen-email').value, passphrase: pass });
    const key = (await readAnyKey(privateArmored)) as openpgp.PrivateKey;
    const unlocked = await unlockKey(key, pass);
    input('gen-pass').value = '';
    input('gen-pass2').value = '';
    setKey(key, privateArmored, true, unlocked);
    $('key-current').scrollIntoView({ block: 'start' });
  },
  'Creating key...',
);

action(
  'load-btn',
  async () => {
    const file = input('load-file').files?.[0];
    const pasted = textarea('load-text').value.trim();
    if (!file && !pasted) throw new UserError('Choose your key PDF or key file, or paste a key.');
    const status = $('load-status');
    const key = file ? await keyFromFile(file, (m) => (status.textContent = m)).finally(() => (status.textContent = '')) : await readAnyKey(pasted);
    // Keep the protected form for downloads before anything is unlocked.
    setKey(key, isPrivate(key) ? key.armor() : null, false, null);
    textarea('load-text').value = '';
    input('load-file').value = '';
    if (isPrivate(key) && !key.isDecrypted()) input('unlock-pass').focus();
  },
  'Loading...',
);
// Picking a file (or taking a photo) loads it straight away.
input('load-file').addEventListener('change', () => {
  if (input('load-file').files?.length) $('load-btn').click();
});

action(
  'unlock-btn',
  async () => {
    const k = state.key;
    if (!k || !isPrivate(k)) return;
    const pass = need(input('unlock-pass').value, 'Enter the passphrase.');
    state.signer = await unlockKey(k, pass);
    input('unlock-pass').value = '';
    refresh();
  },
  'Unlocking...',
);

action(
  'dl-private',
  async () => {
    if (!state.key || !state.privateArmored) return;
    const s = summarize(state.key);
    const name = `private-key-${shortFpr(s.fingerprint)}-KEEP-SECRET.pdf`;
    const pdf = await privateKeyPdf({
      fingerprint: s.fingerprint,
      userID: s.userIDs[0] ?? '',
      created: s.created,
      protectedByPassphrase: !isUnprotected(state.key),
      privateArmored: state.privateArmored,
    });
    download(pdf, name, 'application/pdf');
    $('dl-note').textContent = `Downloaded ${name}. Check your Downloads folder.`;
    state.unsaved = false;
    refresh();
  },
  'Preparing PDF...',
);

action('dl-private-asc', () => {
  if (!state.key || !state.privateArmored) return;
  download(state.privateArmored, `private-key-${shortFpr(summarize(state.key).fingerprint)}-KEEP-SECRET.asc`, 'application/pgp-keys');
});

action('dl-public-asc', () => {
  if (!state.key) return;
  const s = summarize(state.key);
  download(s.publicArmored, `public-key-${shortFpr(s.fingerprint)}.asc`, 'application/pgp-keys');
});

$('forget-key').addEventListener('click', () => {
  if (state.unsaved && !confirm('You have not downloaded your new private key. Forget it anyway?')) return;
  state.key = null;
  state.signer = null;
  state.privateArmored = null;
  state.unsaved = false;
  state.signed = null;
  $('sign-result').hidden = true;
  refresh();
});

window.addEventListener('beforeunload', (e) => {
  if (state.unsaved) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Step 2: registration form
// ---------------------------------------------------------------------------
document.querySelectorAll('input[name="reg-kind"]').forEach((r) => r.addEventListener('change', refresh));

action(
  'reg-btn',
  async () => {
    const k = state.key;
    if (!k) return;
    const owner = need(input('reg-owner').value, 'Enter the owner(s) of record.');
    const parcels = need(input('reg-parcels').value, 'Enter the parcel number.');
    const s = summarize(k);
    const pdf = await registrationPdf({
      ownerName: owner,
      parcels,
      propertyAddress: input('reg-property').value.trim(),
      mailingAddress: input('reg-mailing').value.trim(),
      county: input('reg-county').value.trim(),
      replacement: isReplacement(),
      previousFingerprint: input('reg-prev').value.trim(),
      fingerprint: s.fingerprint,
      algorithm: s.algorithm,
      created: s.created,
      userID: s.userIDs[0] ?? '',
      publicKeyBinary: k.toPublic().write(),
      publicArmored: s.publicArmored,
    });
    download(pdf, `key-registration-${fileSlug(parcels)}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

// ---------------------------------------------------------------------------
// Step 3: sign
// ---------------------------------------------------------------------------
action(
  'sign-btn',
  async () => {
    if (!state.signer) return;
    const file = input('sign-file').files?.[0];
    if (!file) throw new UserError('Choose the document file to sign.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await signDocument(state.signer, bytes);
    const info: SignaturePageInfo = {
      documentTitle: input('sign-title').value.trim(),
      fileName: file.name,
      fileSize: bytes.length,
      parcels: input('sign-parcels').value.trim(),
      userID: doc.userID,
      fingerprint: doc.fingerprint,
      signedAt: doc.signedAt,
      sha256: doc.sha256,
      documentId: doc.documentId,
      payload: doc.payload,
    };
    state.signed = { doc, file, bytes, info };
    $('sr-file').textContent = `${file.name} (${bytes.length.toLocaleString()} bytes)`;
    $('sr-id').textContent = doc.documentId;
    $('sr-hash').textContent = doc.sha256;
    const pdf = isPdfBytes(bytes);
    $('dl-printcopy').hidden = !pdf;
    $('printcopy-note').textContent = pdf
      ? 'The combined PDF is only for printing. It is a new file, so check signatures against the original.'
      : 'This file is not a PDF, so print the verification page and attach it to the printed document.';
    $('sign-dl-error').textContent = '';
    $('sign-result').hidden = false;
    $('sign-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

action('dl-sigpage', async () => {
  const s = state.signed;
  if (!s) return;
  download(await signaturePagePdf(s.info), `${baseName(s.file.name)}-verification-page.pdf`, 'application/pdf');
});

action('dl-printcopy', async () => {
  const s = state.signed;
  if (!s) return;
  download(await printCopyPdf(s.bytes, s.info), `${baseName(s.file.name)}-print-copy.pdf`, 'application/pdf');
});

action('dl-sig', () => {
  const s = state.signed;
  if (!s) return;
  download(s.doc.signature, `${s.file.name}.sig`, 'application/pgp-signature');
});

// ---------------------------------------------------------------------------
// Step 3: sign document text (paper workflow)
// ---------------------------------------------------------------------------
const FIELD_IDS: (keyof TemplateFields)[] = ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'legal', 'consideration', 'date'];
const fieldEl = (f: keyof TemplateFields) => document.getElementById(`f-${f}`) as HTMLInputElement | HTMLTextAreaElement;
const tplSelect = $<HTMLSelectElement>('tpl');
for (const t of TEMPLATES) tplSelect.append(new Option(t.label, t.id));
input('f-date').value = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
$('disclaimer').textContent = DISCLAIMER;

/** Fields the user typed into directly; templates stop overwriting them. */
const edited = new Set<string>();
const currentTemplate = () => TEMPLATES.find((t) => t.id === tplSelect.value) ?? TEMPLATES[0];

function fields(): TemplateFields {
  const f = {} as TemplateFields;
  for (const id of FIELD_IDS) f[id] = fieldEl(id).value;
  return f;
}

function updateCount() {
  const n = canonicalText(textarea('doc-text').value).length;
  $('doc-count').textContent = n ? `${n.toLocaleString()} characters signed.` : '';
}

/** Rebuilds the document text from the template, unless the user has edited it. */
function syncTemplate(force = false) {
  const t = currentTemplate();
  $('tpl-note').textContent = t.note;
  document.querySelectorAll<HTMLElement>('#tpl-fields [data-field]').forEach((el) => {
    el.hidden = !t.uses.includes(el.dataset.field as keyof TemplateFields);
  });
  $('tpl-fields').hidden = t.uses.length === 0;
  const f = fields();
  if (force || !edited.has('doc-text')) {
    textarea('doc-text').value = t.body(f);
    if (force) edited.delete('doc-text');
  }
  if (!edited.has('doc-title')) input('doc-title').value = t.title ? t.title.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) : '';
  if (!edited.has('doc-signers')) textarea('doc-signers').value = t.uses.includes('grantor') ? f.grantor.replace(/,.*$/, '').trim() : '';
  if (!edited.has('doc-return')) {
    textarea('doc-return').value = t.uses.includes('grantee')
      ? [f.grantee.replace(/,.*$/, '').trim(), f.propertyAddress.trim()].filter(Boolean).join('\n')
      : '';
  }
  $('rebuild').hidden = !edited.has('doc-text') || t.uses.length === 0;
  updateCount();
}

tplSelect.addEventListener('change', () => {
  const docText = textarea('doc-text').value.trim();
  if (edited.has('doc-text') && docText && !confirm('Replace the document text you edited with the new template?')) return;
  syncTemplate(true);
});
for (const id of FIELD_IDS) fieldEl(id).addEventListener('input', () => syncTemplate());
for (const id of ['doc-text', 'doc-title', 'doc-signers', 'doc-return']) {
  $(id).addEventListener('input', () => {
    edited.add(id);
    if (id === 'doc-text') {
      $('rebuild').hidden = currentTemplate().uses.length === 0;
      updateCount();
    }
  });
}
$('rebuild').addEventListener('click', () => syncTemplate(true));
syncTemplate();

action(
  'text-sign-btn',
  async () => {
    if (!state.signer) return;
    const text = textarea('doc-text').value;
    if (!canonicalText(text)) throw new UserError('Write the document text first.');
    const placeholder = text.match(/\[[A-Z][A-Z ]+\]/);
    if (placeholder) throw new UserError(`Fill in ${placeholder[0]} before signing.`);
    const result = await signText(state.signer, text);
    state.signedText = {
      result,
      text,
      title: input('doc-title').value.trim() || currentTemplate().title || 'Instrument',
      returnTo: textarea('doc-return').value,
      signers: textarea('doc-signers').value,
    };
    $('tr-id').textContent = result.documentId;
    $('tr-codes').textContent = `${result.codes.length} QR code${result.codes.length === 1 ? '' : 's'} on the signature page at the end`;
    $('text-result').hidden = false;
    await downloadInstrument();
    $('text-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

async function downloadInstrument() {
  const s = state.signedText;
  if (!s) return;
  const pdf = await instrumentPdf({
    title: s.title,
    text: s.text,
    returnTo: s.returnTo,
    signers: s.signers,
    fingerprint: s.result.fingerprint,
    userID: s.result.userID,
    signedAt: s.result.signedAt,
    documentId: s.result.documentId,
    codes: s.result.codes,
  });
  download(pdf, `${fileSlug(s.title)}-signed-${s.result.documentId.slice(0, 8)}.pdf`, 'application/pdf');
}

action('dl-instrument', downloadInstrument, 'Preparing PDF...');
action('dl-text-txt', () => {
  const s = state.signedText;
  if (s) download(s.result.canonical, `${fileSlug(s.title)}-${s.result.documentId.slice(0, 8)}.txt`, 'text/plain');
});
action('dl-text-sig', () => {
  const s = state.signedText;
  if (s) download(s.result.signature, `${fileSlug(s.title)}-${s.result.documentId.slice(0, 8)}.txt.sig`, 'application/pgp-signature');
});

// ---------------------------------------------------------------------------
// Step 4: verify
// ---------------------------------------------------------------------------
let verifyKey: AnyKey | null = null;

function showVerifyKey(key: AnyKey | null, error?: string) {
  const info = $('v-key-info');
  verifyKey = key;
  info.innerHTML = '';
  if (error) {
    info.textContent = error;
    info.className = 'hint error';
    return;
  }
  if (!key) {
    info.textContent = 'Or choose the registration form PDF, or a scan or photo of its page 2.';
    info.className = 'hint';
    return;
  }
  const s = summarize(key);
  info.append(
    'Key on file: ',
    Object.assign(document.createElement('strong'), { className: 'mono', textContent: formatFingerprint(s.fingerprint) }),
    ` (${s.userIDs[0] ?? 'no name'}). Compare it with the fingerprint printed on the registration form.`,
  );
  info.className = 'hint ok';
}

async function loadVerifyKeyText(text: string) {
  if (!text.trim()) return showVerifyKey(null);
  try {
    showVerifyKey((await readAnyKey(text)).toPublic());
  } catch (err) {
    showVerifyKey(null, (err as Error).message);
  }
}

textarea('v-key').addEventListener('input', () => loadVerifyKeyText(textarea('v-key').value));
input('v-key-file').addEventListener('change', async () => {
  const f = input('v-key-file').files?.[0];
  if (!f) return;
  textarea('v-key').value = '';
  const info = $('v-key-info');
  info.className = 'hint';
  try {
    const key = await keyFromFile(f, (m) => (info.textContent = m));
    showVerifyKey(key.toPublic());
  } catch (err) {
    showVerifyKey(null, (err as Error).message);
  } finally {
    input('v-key-file').value = ''; // so choosing the same file again still works
  }
});


input('v-codes-file').addEventListener('change', async () => {
  const f = input('v-codes-file').files?.[0];
  if (!f) return;
  const el = $('v-progress');
  el.className = 'hint';
  try {
    const { readCodesFromFile } = await import('./qrscan');
    const codes = await readCodesFromFile(
      f,
      (m) => (el.textContent = m),
      (c) => {
        const p = scanProgress(c.join('\n'));
        return (p.total > 0 && p.missing.length === 0) || c.some((x) => x.startsWith('PGPSIG1|'));
      },
    );
    const sigCodes = codes.filter((c) => /^(PGPQ1|PGPSIG1)\|/.test(c.trim()));
    if (!sigCodes.length) {
      el.className = 'hint error';
      el.textContent = codes.length
        ? 'Found QR codes, but none are signature codes. Load the signed document, including its signature page.'
        : 'No QR codes found. If this is a scan or photo, make sure the signature page is included, sharp and well lit.';
      return;
    }
    textarea('v-payload').value = sigCodes.join('\n') + '\n';
    textarea('v-payload').dispatchEvent(new Event('input'));
    // Check right away when everything needed is there.
    if (verifyKey && scanProgress(textarea('v-payload').value).missing.length === 0) $('verify-btn').click();
  } catch (err) {
    el.className = 'hint error';
    el.textContent = (err as Error).message;
  } finally {
    input('v-codes-file').value = '';
  }
});
$('v-use-mine').addEventListener('click', async () => {
  if (!state.key) return;
  input('v-key-file').value = '';
  textarea('v-key').value = summarize(state.key).publicArmored;
  await loadVerifyKeyText(textarea('v-key').value);
});

let verifiedText = '';

function compareWithPaper() {
  const out = $('vr-compare-result');
  const paper = textarea('vr-compare').value;
  out.innerHTML = '';
  if (!paper.trim() || !verifiedText) return;
  const d = firstDifference(verifiedText, paper);
  if (!d) {
    out.className = 'hint ok';
    out.textContent = 'Matches: the paper text is exactly what the owner signed.';
    return;
  }
  out.className = 'hint error';
  out.append(
    `Different, starting at character ${d.index + 1}.`,
    Object.assign(document.createElement('span'), { className: 'diff', textContent: `Signed: ${d.signed}` }),
    Object.assign(document.createElement('span'), { className: 'diff', textContent: `Paper:  ${d.other}` }),
  );
}
textarea('vr-compare').addEventListener('input', compareWithPaper);

textarea('v-payload').addEventListener('input', () => {
  const v = textarea('v-payload').value;
  const p = scanProgress(v);
  const el = $('v-progress');
  if (!p.total) {
    el.textContent = '';
  } else if (p.groups.length > 1) {
    el.textContent = 'Codes from more than one document were scanned. Clear the box and scan one document.';
  } else if (p.missing.length) {
    el.textContent = `Scanned ${p.have} of ${p.total} codes. Still need: ${p.missing.join(', ')}.`;
  } else {
    el.textContent = `All ${p.total} code${p.total === 1 ? '' : 's'} scanned.`;
  }
});

const VERDICT: Record<Verdict, { title: string; action: string }> = {
  good: { title: 'GOOD SIGNATURE. Matches the registered key.', action: 'Compare the signed text below with the paper. If it matches, record as usual.' },
  bad: {
    title: 'DOES NOT VERIFY.',
    action: 'Hold the filing. Flag as suspected forgery, preserve the submission, and notify the owner of record.',
  },
  incomplete: {
    title: 'NOT CHECKED YET.',
    action: 'Scan the remaining codes (or, for an electronic filing, load the signed file). Do not record a filing on a registered parcel until it passes.',
  },
};

action(
  'verify-btn',
  async () => {
    if (!verifyKey && textarea('v-key').value.trim()) await loadVerifyKeyText(textarea('v-key').value);
    if (!verifyKey) throw new UserError('Scan, paste or choose the public key registered for the parcel.');
    const payload = textarea('v-payload').value;
    $('vr-text-wrap').hidden = true;
    if (!payload.trim()) {
      throw new UserError(
        'No signature codes. If this filing is for a parcel with a registered key and has no signature page, hold it, notify the owner and investigate.',
      );
    }
    let r;
    if (payload.includes('PGPQ1|')) {
      // Paper filing: the codes carry the signed text.
      r = await verifyScannedText({ scanned: payload, registeredKey: verifyKey });
      verifiedText = r.signedText ?? '';
      if (r.signedText && r.verdict === 'good') {
        $('vr-text').textContent = r.signedText;
        $('vr-text-wrap').hidden = false;
        compareWithPaper();
      }
    } else {
      // Electronic filing: a PGPSIG1 code plus the signed file.
      const file = input('v-doc').files?.[0];
      r = await verifyFiling({
        payload,
        registeredKey: verifyKey,
        document: file ? new Uint8Array(await file.arrayBuffer()) : undefined,
      });
    }
    const b = $('vr-banner');
    b.className = `verdict ${r.verdict}`;
    b.innerHTML = '';
    b.append(
      Object.assign(document.createElement('strong'), { textContent: VERDICT[r.verdict].title }),
      Object.assign(document.createElement('span'), { textContent: VERDICT[r.verdict].action }),
    );
    const list = $('vr-checks');
    list.innerHTML = '';
    for (const c of r.checks) {
      const li = document.createElement('li');
      li.className = c.state;
      const mark = c.state === 'pass' ? 'Pass' : c.state === 'fail' ? 'Fail' : 'Not checked';
      li.append(
        Object.assign(document.createElement('span'), { className: 'mark', textContent: mark }),
        Object.assign(document.createElement('strong'), { textContent: c.label }),
        Object.assign(document.createElement('span'), { className: 'detail', textContent: c.detail }),
      );
      list.append(li);
    }
    $('vr-id').textContent = r.documentId ?? '-';
    $('vr-when').textContent = r.signedAt ? r.signedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-';
    $('verify-result').hidden = false;
    $('verify-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'Checking...',
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let framed = true;
try {
  framed = window.self !== window.top;
} catch {
  /* cross-origin parent: framed */
}
$('frame-note').hidden = !framed;

// Branding (src/brand.ts) and the seal embedded in index.html.
document.title = `${BRAND.name} (${BRAND.expansion})`;
document.querySelectorAll<HTMLElement>('[data-brand]').forEach((el) => {
  const v = BRAND[el.dataset.brand as keyof typeof BRAND];
  if (typeof v === 'string') el.textContent = v;
});
$('proposed-note').hidden = BRAND.status !== 'proposed';
{
  const holder = $('project-url');
  holder.textContent = '';
  if (/^https?:\/\//.test(BRAND.projectUrl)) {
    holder.append(Object.assign(document.createElement('a'), { href: BRAND.projectUrl, textContent: BRAND.projectUrl, rel: 'noopener' }));
  } else {
    holder.textContent = BRAND.projectUrl;
  }
}
{
  const seal = $<HTMLImageElement>('brand-seal');
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(seal.getAttribute('src') ?? '');
  if (m) {
    try {
      setBrandSeal(fromBase64Text(m[2]));
    } catch {
      /* bad image data: PDFs are made without the seal */
    }
  } else {
    seal.hidden = true;
  }
}
if (!input('reg-county').value) input('reg-county').value = BRAND.county;
if (!input('f-county').value) input('f-county').value = BRAND.county.replace(/\s+County$/i, '');
syncTemplate();

const initial = location.hash.slice(1) as Tab;
showTab(TABS.includes(initial) ? initial : 'about');
$('boot').hidden = true;
