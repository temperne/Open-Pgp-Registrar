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
import { registrationPdf, signaturePagePdf, printCopyPdf, privateKeyBackupPdf, type SignaturePageInfo } from './pdf';

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
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  refresh();
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
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function showError(id: string, err: unknown) {
  const el = $(id);
  el.textContent = err ? (err instanceof Error ? err.message : String(err)) : '';
}

async function busy<T>(button: HTMLButtonElement | null, label: string, fn: () => Promise<T>) {
  const old = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    return await fn();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = old ?? '';
    }
  }
}

function fileSlug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'owner'
  );
}

/** "Jane Doe <jane@x>" -> "Jane Doe" */
function nameFromUserID(uid: string) {
  return uid.replace(/\s*<[^>]*>\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function shortFpr(fpr: string) {
  return fpr.slice(-16);
}

const submitter = (e: SubmitEvent) => (e.submitter as HTMLButtonElement | null) ?? null;

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
    $('nopass-warning').hidden = !(s.hasPrivate && state.privateArmored && isUnprotected(k));
    $('dl-private').hidden = !state.privateArmored;
    $('dl-backup').hidden = !state.privateArmored;
  }

  // Register
  document.querySelector<HTMLElement>('#panel-register .needs-key')!.hidden = !!k;
  $('reg-form').hidden = !k;
  if (k && !input('reg-owner').value) input('reg-owner').value = nameFromUserID(k.getUserIDs()[0] ?? '');
  $('reg-prev-wrap').hidden = !isReplacement();

  // Sign
  const need = document.querySelector<HTMLElement>('#panel-sign .needs-private')!;
  if (!k) {
    need.innerHTML = 'First <a href="#key" data-goto="key">create or load a private key</a>.';
  } else if (!isPrivate(k)) {
    need.innerHTML =
      'Signing needs the <strong>private</strong> key. The key loaded in <a href="#key" data-goto="key">step 1</a> is public only.';
  } else if (!state.signer) {
    need.innerHTML = 'Unlock your private key with its passphrase in <a href="#key" data-goto="key">step 1</a> first.';
  }
  need.hidden = !!state.signer;
  $('sign-form').hidden = !state.signer;
  if (!input('sign-parcels').value && input('reg-parcels').value) input('sign-parcels').value = input('reg-parcels').value;

  // Verify
  $('v-use-mine').hidden = !k;
}

/** state.key keeps the key as loaded; unlocking makes a separate copy, so this reflects the file itself. */
function isUnprotected(k: AnyKey) {
  return isPrivate(k) && k.isDecrypted();
}

function isReplacement() {
  return document.querySelector<HTMLInputElement>('input[name="reg-kind"]:checked')?.value === 'replacement';
}

// ---------------------------------------------------------------------------
// Step 1: key
// ---------------------------------------------------------------------------
async function setKey(key: AnyKey, privateArmored: string | null, unsaved: boolean) {
  state.key = key;
  state.signer = isPrivate(key) && key.isDecrypted() ? key : null;
  state.privateArmored = privateArmored;
  state.unsaved = unsaved;
  state.signed = null;
  $('sign-result').hidden = true;
  input('reg-owner').value = '';
  refresh();
}

$('gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('key-error', null);
  const pass = input('gen-pass').value;
  if (pass !== input('gen-pass2').value) return showError('key-error', 'The two passphrases do not match.');
  if (pass.length < 8) return showError('key-error', 'Use a passphrase of at least 8 characters.');
  await busy(submitter(e as SubmitEvent), 'Creating...', async () => {
    try {
      const { privateArmored } = await generateKeyPair({
        name: input('gen-name').value,
        email: input('gen-email').value,
        passphrase: pass,
      });
      const key = (await readAnyKey(privateArmored)) as openpgp.PrivateKey;
      const unlocked = await unlockKey(key, pass);
      await setKey(key, privateArmored, true);
      state.signer = unlocked;
      input('gen-pass').value = '';
      input('gen-pass2').value = '';
      refresh();
    } catch (err) {
      showError('key-error', err);
    }
  });
});

$('load-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('key-error', null);
  const file = input('load-file').files?.[0];
  const pasted = $<HTMLTextAreaElement>('load-text').value.trim();
  if (!file && !pasted) return showError('key-error', 'Choose a key file or paste a key.');
  await busy(submitter(e as SubmitEvent), 'Loading...', async () => {
    try {
      const data = file ? new Uint8Array(await file.arrayBuffer()) : pasted;
      const key = await readAnyKey(data);
      // Keep the protected form for downloads before anything is unlocked.
      const armored = isPrivate(key) ? key.armor() : null;
      await setKey(key, armored, false);
      $<HTMLTextAreaElement>('load-text').value = '';
      input('load-file').value = '';
      if (isPrivate(key) && !key.isDecrypted()) input('unlock-pass').focus();
    } catch (err) {
      showError('key-error', err);
    }
  });
});

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('key-error', null);
  const k = state.key;
  if (!k || !isPrivate(k)) return;
  await busy(submitter(e as SubmitEvent), 'Unlocking...', async () => {
    try {
      state.signer = await unlockKey(k, input('unlock-pass').value);
      input('unlock-pass').value = '';
      refresh();
    } catch (err) {
      showError('key-error', err);
    }
  });
});

$('dl-private').addEventListener('click', () => {
  if (!state.key || !state.privateArmored) return;
  const s = summarize(state.key);
  download(state.privateArmored, `private-key-${shortFpr(s.fingerprint)}-KEEP-SECRET.asc`, 'application/pgp-keys');
  state.unsaved = false;
  refresh();
});

$('dl-public').addEventListener('click', () => {
  if (!state.key) return;
  const s = summarize(state.key);
  download(s.publicArmored, `public-key-${shortFpr(s.fingerprint)}.asc`, 'application/pgp-keys');
});

$('dl-backup').addEventListener('click', async () => {
  if (!state.key || !state.privateArmored) return;
  const s = summarize(state.key);
  const pdf = await privateKeyBackupPdf({
    fingerprint: s.fingerprint,
    userID: s.userIDs[0] ?? '',
    created: s.created,
    protectedByPassphrase: !isUnprotected(state.key),
    privateArmored: state.privateArmored,
  });
  download(pdf, `private-key-backup-${shortFpr(s.fingerprint)}-KEEP-SECRET.pdf`, 'application/pdf');
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

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('reg-error', null);
  const k = state.key;
  if (!k) return;
  await busy(submitter(e as SubmitEvent), 'Preparing...', async () => {
    try {
      const s = summarize(k);
      const pdf = await registrationPdf({
        ownerName: input('reg-owner').value.trim(),
        parcels: input('reg-parcels').value.trim(),
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
      download(pdf, `key-registration-${fileSlug(input('reg-parcels').value)}.pdf`, 'application/pdf');
    } catch (err) {
      showError('reg-error', err);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 3: sign
// ---------------------------------------------------------------------------
function isPdf(file: File, bytes: Uint8Array) {
  return file.type === 'application/pdf' || new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
}

$('sign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('sign-error', null);
  const file = input('sign-file').files?.[0];
  if (!state.signer) return;
  if (!file) return showError('sign-error', 'Choose the document file to sign.');
  await busy(submitter(e as SubmitEvent), 'Signing...', async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await signDocument(state.signer!, bytes);
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
      const pdf = isPdf(file, bytes);
      $('dl-printcopy').hidden = !pdf;
      $('printcopy-note').textContent = pdf
        ? 'The combined PDF is only for printing. It is a new file, so check signatures against the original.'
        : 'This file is not a PDF, so print the verification page and attach it to the printed document.';
      $('sign-result').hidden = false;
      $('sign-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError('sign-error', err);
    }
  });
});

const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

$('dl-sigpage').addEventListener('click', async () => {
  const s = state.signed;
  if (!s) return;
  download(await signaturePagePdf(s.info), `${baseName(s.file.name)}-verification-page.pdf`, 'application/pdf');
});

$('dl-printcopy').addEventListener('click', async () => {
  const s = state.signed;
  if (!s) return;
  showError('sign-error', null);
  try {
    download(await printCopyPdf(s.bytes, s.info), `${baseName(s.file.name)}-print-copy.pdf`, 'application/pdf');
  } catch (err) {
    showError('sign-error', err);
  }
});

$('dl-sig').addEventListener('click', () => {
  const s = state.signed;
  if (!s) return;
  download(s.doc.signature, `${s.file.name}.sig`, 'application/pgp-signature');
});

// ---------------------------------------------------------------------------
// Step 4: verify
// ---------------------------------------------------------------------------
let verifyKey: AnyKey | null = null;

async function loadVerifyKey(data: string | Uint8Array) {
  const info = $('v-key-info');
  verifyKey = null;
  if (typeof data === 'string' && !data.trim()) {
    info.textContent = '';
    return;
  }
  try {
    verifyKey = await readAnyKey(data);
    const s = summarize(verifyKey);
    info.innerHTML = '';
    info.append(
      'Key on file: ',
      Object.assign(document.createElement('strong'), { className: 'mono', textContent: formatFingerprint(s.fingerprint) }),
      ` (${s.userIDs[0] ?? 'no name'}). Compare it with the fingerprint printed on the registration form.`,
    );
    info.className = 'hint ok';
  } catch (err) {
    info.textContent = (err as Error).message;
    info.className = 'hint error';
  }
}

$<HTMLTextAreaElement>('v-key').addEventListener('input', (e) => loadVerifyKey((e.target as HTMLTextAreaElement).value));
input('v-key-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) {
    $<HTMLTextAreaElement>('v-key').value = '';
    await loadVerifyKey(new Uint8Array(await f.arrayBuffer()));
  }
});
$('v-use-mine').addEventListener('click', async () => {
  if (!state.key) return;
  input('v-key-file').value = '';
  $<HTMLTextAreaElement>('v-key').value = summarize(state.key).publicArmored;
  await loadVerifyKey($<HTMLTextAreaElement>('v-key').value);
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

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('verify-error', null);
  if (!verifyKey) {
    const raw = $<HTMLTextAreaElement>('v-key').value;
    if (raw.trim()) await loadVerifyKey(raw);
  }
  if (!verifyKey) return showError('verify-error', 'Scan, paste or choose the public key registered for the parcel.');
  const payload = $<HTMLTextAreaElement>('v-payload').value;
  if (!payload.trim()) {
    return showError(
      'verify-error',
      'No signature code. If this filing is for a parcel with a registered key and carries no signature page, hold it, notify the owner and investigate.',
    );
  }
  const file = input('v-doc').files?.[0];
  await busy(submitter(e as SubmitEvent), 'Checking...', async () => {
    try {
      const r = await verifyFiling({
        payload,
        registeredKey: verifyKey!,
        document: file ? new Uint8Array(await file.arrayBuffer()) : undefined,
      });
      const banner = $('vr-banner');
      banner.className = `verdict ${r.verdict}`;
      banner.innerHTML = '';
      banner.append(
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
    } catch (err) {
      showError('verify-error', err);
    }
  });
});

// ---------------------------------------------------------------------------
const initial = location.hash.slice(1) as Tab;
showTab(TABS.includes(initial) ? initial : 'key');
