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
  type SignaturePageInfo,
} from './pdf';

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
}
const state: State = { key: null, signer: null, privateArmored: null, unsaved: false, signed: null };

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
const TABS = ['key', 'register', 'sign', 'verify'] as const;
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
const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

/** Reads a key from a PDF made by this tool, or from any OpenPGP key file or text. */
async function keyFromFile(file: File): Promise<AnyKey> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdfBytes(bytes)) return readAnyKey(await keyTextFromPdf(bytes));
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
  $('sign-form').hidden = !state.signer;
  if (!input('sign-parcels').value && input('reg-parcels').value) input('sign-parcels').value = input('reg-parcels').value;

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
  $('sign-result').hidden = true;
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
    const key = file ? await keyFromFile(file) : await readAnyKey(pasted);
    // Keep the protected form for downloads before anything is unlocked.
    setKey(key, isPrivate(key) ? key.armor() : null, false, null);
    textarea('load-text').value = '';
    input('load-file').value = '';
    if (isPrivate(key) && !key.isDecrypted()) input('unlock-pass').focus();
  },
  'Loading...',
);

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
    info.textContent = 'Or choose the registration form PDF; the key is embedded in it.';
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
  try {
    showVerifyKey((await keyFromFile(f)).toPublic());
  } catch (err) {
    showVerifyKey(null, (err as Error).message);
  }
});
$('v-use-mine').addEventListener('click', async () => {
  if (!state.key) return;
  input('v-key-file').value = '';
  textarea('v-key').value = summarize(state.key).publicArmored;
  await loadVerifyKeyText(textarea('v-key').value);
});

const VERDICT: Record<Verdict, { title: string; action: string }> = {
  good: { title: 'GOOD SIGNATURE. Matches the registered key.', action: 'Record as usual.' },
  bad: {
    title: 'DOES NOT VERIFY.',
    action: 'Hold the filing. Flag as suspected forgery, preserve the submission, and notify the owner of record.',
  },
  incomplete: {
    title: 'NOT CHECKED YET.',
    action: 'Load the signed document file to finish. Do not record a filing on a registered parcel until it passes.',
  },
};

action(
  'verify-btn',
  async () => {
    if (!verifyKey && textarea('v-key').value.trim()) await loadVerifyKeyText(textarea('v-key').value);
    if (!verifyKey) throw new UserError('Scan, paste or choose the public key registered for the parcel.');
    const payload = textarea('v-payload').value;
    if (!payload.trim()) {
      throw new UserError(
        'No signature code. If this filing is for a parcel with a registered key and has no signature page, hold it, notify the owner and investigate.',
      );
    }
    const file = input('v-doc').files?.[0];
    const r = await verifyFiling({
      payload,
      registeredKey: verifyKey,
      document: file ? new Uint8Array(await file.arrayBuffer()) : undefined,
    });
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

const initial = location.hash.slice(1) as Tab;
showTab(TABS.includes(initial) ? initial : 'key');
$('boot').hidden = true;
