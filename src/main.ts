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
  orderedCodes,
  scanProgress,
  signedFromCodes,
  assembleSigned,
  decodeCodes,
  decodeRegistrationCodes,
  mergeRegistrations,
  parcelKey,
  parsePayload,
  toBase64,
  fromBase64,
  type Registration,
  type DocSignature,
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
  certificatePdf,
  publicKeyCardPdf,
  registrationsFromPdf,
  draftFromPdf,
  splitParcels,
  type DocumentDraft,
  type SignaturePageInfo,
} from './pdf';
import { BRAND } from './brand';
import { TEMPLATES, DISCLAIMER, type TemplateFields } from './templates';
import { canonicalText } from './text';

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
  /**
   * The document being signed: its text and every owner's signature so far.
   * Kept when keys are switched, so several owners can sign on one computer.
   */
  draft: { signed: SignedText; title: string; text: string; returnTo: string; signers: string } | null;
  /** Registration of the parcel being signed for (who must sign). */
  signReg: Registration | null;
  /** Co-owners' public keys to list on this owner's registration forms. */
  coOwners: openpgp.PublicKey[];
}
const state: State = { key: null, signer: null, privateArmored: null, unsaved: false, signed: null, draft: null, signReg: null, coOwners: [] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const textarea = (id: string) => $<HTMLTextAreaElement>(id);

/** Shows a problem in the banner at the top, so failures are never silent. */
function banner(message: string) {
  const b = $('boot');
  b.hidden = false;
  b.className = 'callout warn';
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
  const firstParcel = splitParcels(textarea('reg-parcels').value)[0];
  if (!input('sign-parcels').value && firstParcel) input('sign-parcels').value = firstParcel;
  // Carry details from the registration step into the document fields.
  let carried = false;
  for (const [from, to] of [
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
  if (firstParcel && !input('f-parcels').value) {
    input('f-parcels').value = firstParcel;
    carried = true;
  }
  if (carried) syncTemplate();

  // Verify
  $('v-use-mine').hidden = !k;
  $('v-use-sign-reg').hidden = !state.signReg;
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

action(
  'dl-card',
  async () => {
    if (!state.key) return;
    const s = summarize(state.key);
    const pdf = await publicKeyCardPdf({
      fingerprint: s.fingerprint,
      userID: s.userIDs[0] ?? '',
      created: s.created,
      publicArmored: s.publicArmored,
      publicKeyBinary: state.key.toPublic().write(),
    });
    download(pdf, `public-key-card-${shortFpr(s.fingerprint)}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

window.addEventListener('beforeunload', (e) => {
  if (state.unsaved) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Step 2: registration form (one per parcel, listing every owner's key)
// ---------------------------------------------------------------------------
document.querySelectorAll('input[name="reg-kind"]').forEach((r) => r.addEventListener('change', refresh));

function keyItem(k: openpgp.PublicKey, extra?: Node) {
  const li = document.createElement('li');
  li.append(
    Object.assign(document.createElement('strong'), { textContent: k.getUserIDs()[0] ?? '(no name)' }),
    Object.assign(document.createElement('span'), { className: 'mono', textContent: formatFingerprint(k.getFingerprint()) }),
  );
  if (extra) li.append(extra);
  return li;
}

function renderCoOwners() {
  const list = $('co-list');
  list.innerHTML = '';
  state.coOwners.forEach((k, i) => {
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Remove' });
    remove.addEventListener('click', () => {
      state.coOwners.splice(i, 1);
      renderCoOwners();
    });
    list.append(keyItem(k, remove));
  });
}

input('co-file').addEventListener('change', async () => {
  const f = input('co-file').files?.[0];
  if (!f) return;
  const status = $('co-status');
  status.className = 'hint';
  try {
    const key = (await keyFromFile(f, (m) => (status.textContent = m))).toPublic();
    const fpr = key.getFingerprint().toUpperCase();
    if (state.key && state.key.getFingerprint().toUpperCase() === fpr) throw new Error('That is your own key; it is listed automatically.');
    if (state.coOwners.some((k) => k.getFingerprint().toUpperCase() === fpr)) throw new Error('That key is already listed.');
    state.coOwners.push(key);
    renderCoOwners();
    status.textContent = `Added ${key.getUserIDs()[0] ?? 'key'}. Check the fingerprint with your co-owner.`;
  } catch (err) {
    status.className = 'hint error';
    status.textContent = (err as Error).message;
  } finally {
    input('co-file').value = '';
  }
});

action(
  'reg-btn',
  async () => {
    const k = state.key;
    if (!k) return;
    const owner = need(input('reg-owner').value, 'Enter the owner(s) of record.');
    const parcels = need(textarea('reg-parcels').value, 'Enter the parcel number.');
    const s = summarize(k);
    const pdf = await registrationPdf({
      ownerName: owner,
      parcels,
      coOwnerKeys: state.coOwners,
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
    const list = splitParcels(parcels);
    download(pdf, `key-registration-${fileSlug(list[0])}${list.length > 1 ? `-and-${list.length - 1}-more` : ''}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

/**
 * Reads parcel registrations from a registration form PDF (embedded), a scan or
 * photo of its page 2 (codes), or a bare key (old forms, key files).
 */
async function registrationsFromFile(file: File, onProgress?: (msg: string) => void): Promise<Registration[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdfBytes(bytes)) {
    const regs = await registrationsFromPdf(bytes);
    if (regs.length) return regs;
  }
  if (isPdfBytes(bytes) || isImage(file)) {
    const { readCodesFromFile } = await import('./qrscan');
    const codes = await readCodesFromFile(file, onProgress);
    const groups = new Map<string, string[]>();
    for (const c of codes) {
      const m = /^PGPR1\|([0-9A-F]{12})\|/.exec(c);
      if (m) groups.set(m[1], [...(groups.get(m[1]) ?? []), c]);
    }
    if (groups.size) return Promise.all([...groups.values()].map((g) => decodeRegistrationCodes(g.join('\n'))));
    return [{ parcel: '', keys: [(await keyFromCodes(codes)).toPublic()] }];
  }
  return [{ parcel: '', keys: [(await readAnyKey(bytes)).toPublic()] }];
}

function describeRegistration(r: Registration) {
  const frag = document.createDocumentFragment();
  frag.append(r.parcel ? `Parcel ${r.parcel}: ` : 'Key(s) without a parcel number: ', `${r.keys.length} key${r.keys.length === 1 ? '' : 's'}, all must sign.`);
  const ul = Object.assign(document.createElement('ul'), { className: 'keylist' });
  for (const k of r.keys) ul.append(keyItem(k));
  frag.append(ul);
  return frag;
}

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
// Step 3: sign document text (paper workflow), by one owner or several
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

/** The signed content is the title and the text together. */
function fullText(title: string, text: string) {
  return title.trim() ? `${title.trim()}\n\n${text}` : text;
}

function updateCount() {
  const n = canonicalText(fullText(input('doc-title').value, textarea('doc-text').value)).length;
  $('doc-count').textContent = n ? `${n.toLocaleString()} characters signed.` : '';
}

/** Rebuilds the document text from the template, unless the user has edited it. */
function syncTemplate(force = false) {
  if (state.draft) return; // text is locked once anyone has signed
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
  if (!edited.has('doc-signers')) {
    const names = state.signReg?.keys.map((k) => nameFromUserID(k.getUserIDs()[0] ?? '')).filter(Boolean);
    textarea('doc-signers').value = names?.length ? names.join('\n') : t.uses.includes('grantor') ? f.grantor.replace(/,.*$/, '').trim() : '';
  }
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
    if (id === 'doc-text') $('rebuild').hidden = currentTemplate().uses.length === 0;
    updateCount();
  });
}
$('rebuild').addEventListener('click', () => syncTemplate(true));
syncTemplate();

/** Locks the text once anyone has signed: every owner must sign exactly the same text. */
function lockDraft() {
  const locked = !!state.draft;
  $('draft-fields').querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select').forEach((el) => {
    // Lines and the return address are printed but not signed; they stay editable.
    if (el.id === 'doc-signers' || el.id === 'doc-return') return;
    el.disabled = locked;
  });
  // The template and its fields only build new text; hide them while the text is locked.
  for (const el of [document.querySelector<HTMLElement>('label[for="tpl"]')!, $('tpl'), $('tpl-note'), $('tpl-fields')]) el.hidden = locked;
  if (!locked) syncTemplate();
  const note = $('locked-note');
  note.hidden = !locked;
  note.innerHTML = '';
  if (state.draft) {
    const n = state.draft.signed.signatures.length;
    const over = Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Start over with new text' });
    over.addEventListener('click', () => {
      if (!confirm(`This discards the ${n} signature${n === 1 ? '' : 's'} on this document. Start over?`)) return;
      state.draft = null;
      $('text-result').hidden = true;
      lockDraft();
      syncTemplate();
    });
    note.append(
      Object.assign(document.createElement('strong'), { textContent: 'Text locked. ' }),
      `${n} owner${n === 1 ? ' has' : 's have'} signed it, so every other owner must sign exactly this text. `,
      over,
    );
  }
  $('text-sign-btn').textContent = state.draft ? 'Add my signature' : 'Sign';
}

function missingSigners() {
  const d = state.draft;
  if (!d || !state.signReg) return [];
  const signed = new Set(d.signed.signatures.map((x) => x.fingerprint));
  return state.signReg.keys.filter((k) => !signed.has(k.getFingerprint().toUpperCase()));
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  const list = $('tr-signers');
  list.innerHTML = '';
  const names = new Map(state.signReg?.keys.map((k) => [k.getFingerprint().toUpperCase(), k.getUserIDs()[0] ?? '']) ?? []);
  for (const sig of d.signed.signatures) {
    const li = document.createElement('li');
    li.className = 'signed';
    li.append(
      Object.assign(document.createElement('strong'), { textContent: `Signed: ${sig.userID || names.get(sig.fingerprint) || '(name not given)'}` }),
      Object.assign(document.createElement('span'), { className: 'mono', textContent: formatFingerprint(sig.fingerprint) }),
      Object.assign(document.createElement('span'), { textContent: sig.signedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') }),
    );
    list.append(li);
  }
  const missing = missingSigners();
  for (const k of missing) {
    const li = document.createElement('li');
    li.className = 'waiting';
    li.append(
      Object.assign(document.createElement('strong'), { textContent: `Still needed: ${k.getUserIDs()[0] ?? '(no name)'}` }),
      Object.assign(document.createElement('span'), { className: 'mono', textContent: formatFingerprint(k.getFingerprint()) }),
    );
    list.append(li);
  }
  const status = $('tr-status');
  if (!state.signReg) {
    status.textContent = `${d.signed.signatures.length} signed`;
    status.className = 'pill';
  } else if (missing.length) {
    status.textContent = `Not complete: ${d.signed.signatures.length} of ${state.signReg.keys.length}`;
    status.className = 'pill warn';
  } else {
    status.textContent = 'Complete: every registered owner signed';
    status.className = 'pill good';
  }
  $('tr-id').textContent = d.signed.documentId;
  $('tr-codes').textContent = `${d.signed.codes.length} QR code${d.signed.codes.length === 1 ? '' : 's'} on the signature page at the end`;
  $('dl-instrument').textContent = missing.length ? 'Download for the next owner (PDF)' : 'Download signed document (PDF)';
  $('next-signer').hidden = missing.length === 0 && !!state.signReg;
  $('tr-step1').textContent = missing.length
    ? 'Not complete yet. Give the PDF to the next owner (they choose "Sign exactly as others" and load it), or let them sign on this computer.'
    : 'Print it. The last page holds the QR codes with the signatures.';
  $('text-result').hidden = false;
}

function setDraft(d: State['draft']) {
  state.draft = d;
  if (d) {
    input('doc-title').value = d.title;
    textarea('doc-text').value = d.text;
    textarea('doc-return').value = d.returnTo;
    textarea('doc-signers').value = d.signers;
    for (const id of ['doc-text', 'doc-title', 'doc-signers', 'doc-return']) edited.add(id);
  }
  lockDraft();
  updateCount();
  if (d) renderDraft();
  else $('text-result').hidden = true;
}

function useSignRegistration(regs: Registration[]) {
  const sel = $<HTMLSelectElement>('s-reg-parcel');
  sel.innerHTML = '';
  const byParcel = new Map<string, Registration[]>();
  for (const r of regs) byParcel.set(parcelKey(r.parcel), [...(byParcel.get(parcelKey(r.parcel)) ?? []), r]);
  const merged = [...byParcel.values()].map((g) => mergeRegistrations(g));
  merged.forEach((r, i) => sel.append(new Option(r.parcel ? `Parcel ${r.parcel}` : 'Keys without a parcel', String(i))));
  sel.hidden = merged.length < 2;
  // Pick the parcel already named in the document, if any.
  const want = parcelKey(input('f-parcels').value);
  const pick = Math.max(0, merged.findIndex((r) => want && parcelKey(r.parcel) === want));
  sel.value = String(pick);
  const choose = () => {
    state.signReg = merged[Number(sel.value)] ?? null;
    const info = $('s-reg-info');
    info.className = 'hint ok';
    info.innerHTML = '';
    if (state.signReg) {
      info.append(describeRegistration(state.signReg));
      if (state.signReg.parcel && !state.draft && !input('f-parcels').value) input('f-parcels').value = state.signReg.parcel;
    }
    syncTemplate();
    if (state.draft) renderDraft();
    refresh();
  };
  sel.onchange = choose;
  choose();
}

input('s-reg-file').addEventListener('change', async () => {
  const f = input('s-reg-file').files?.[0];
  if (!f) return;
  const info = $('s-reg-info');
  info.className = 'hint';
  try {
    useSignRegistration(await registrationsFromFile(f, (m) => (info.textContent = m)));
  } catch (err) {
    info.className = 'hint error';
    info.textContent = (err as Error).message;
  } finally {
    input('s-reg-file').value = '';
  }
});

/** Sign exactly as others: load a document another owner signed. */
input('continue-file').addEventListener('change', async () => {
  const f = input('continue-file').files?.[0];
  if (!f) return;
  const status = $('continue-status');
  status.className = 'hint';
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const embedded = isPdfBytes(bytes) ? await draftFromPdf(bytes) : null;
    if (embedded) {
      const sigs: DocSignature[] = embedded.signatures.map((x) => ({
        fingerprint: x.fingerprint,
        userID: x.userID,
        signedAt: new Date(x.signedAt),
        bytes: fromBase64(x.sig),
      }));
      const signed = await assembleSigned(canonicalText(fullText(embedded.title, embedded.text)), sigs);
      if (embedded.registration && !state.signReg) {
        const keys = await Promise.all(embedded.registration.keys.map(async (a) => (await readAnyKey(a)).toPublic()));
        useSignRegistration([{ parcel: embedded.registration.parcel, keys }]);
      }
      setDraft({ signed, title: embedded.title, text: embedded.text, returnTo: embedded.returnTo, signers: embedded.signers });
    } else {
      // A scan or photo of the signature page: the codes carry the text and signatures.
      const { readCodesFromFile } = await import('./qrscan');
      const codes = await readCodesFromFile(f, (m) => (status.textContent = m), (c) => {
        const p = scanProgress(c.join('\n'));
        return p.total > 0 && p.missing.length === 0;
      });
      const signed = await signedFromCodes(codes.join('\n'));
      setDraft({ signed, title: '', text: signed.canonical, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
    }
    const n = state.draft!.signed.signatures.length;
    status.className = 'hint ok';
    status.textContent = `Loaded a document signed by ${n} owner${n === 1 ? '' : 's'}. Unlock your key and choose "Add my signature".`;
  } catch (err) {
    status.className = 'hint error';
    status.textContent = (err as Error).message;
  } finally {
    input('continue-file').value = '';
  }
});

action(
  'text-sign-btn',
  async () => {
    if (!state.signer) return;
    const me = state.signer.getFingerprint().toUpperCase();
    if (state.signReg && !state.signReg.keys.some((k) => k.getFingerprint().toUpperCase() === me)) {
      throw new UserError(
        `Your key is not registered for ${state.signReg.parcel ? `parcel ${state.signReg.parcel}` : 'this parcel'}. Load the key of an owner listed on the registration.`,
      );
    }
    if (state.draft) {
      const d = state.draft;
      const signed = await signText(state.signer, fullText(d.title, d.text), d.signed);
      setDraft({ ...d, signed, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
    } else {
      const text = textarea('doc-text').value;
      const title = input('doc-title').value.trim();
      if (!canonicalText(text)) throw new UserError('Write the document text first.');
      const placeholder = fullText(title, text).match(/\[[A-Z][A-Z ]+\]/);
      if (placeholder) throw new UserError(`Fill in ${placeholder[0]} before signing.`);
      if (state.signReg?.parcel && !parcelKey(fullText(title, text)).includes(parcelKey(state.signReg.parcel))) {
        throw new UserError(`The text must name the registered parcel number, ${state.signReg.parcel}, or the Recorder's check will fail.`);
      }
      const signed = await signText(state.signer, fullText(title, text));
      setDraft({ signed, title, text, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
    }
    $('text-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

function draftForPdf(): DocumentDraft | undefined {
  const d = state.draft;
  if (!d) return undefined;
  return {
    format: 'stop-document-1',
    title: d.title,
    text: d.text,
    returnTo: textarea('doc-return').value,
    signers: textarea('doc-signers').value,
    signatures: d.signed.signatures.map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) })),
    registration: state.signReg ? { parcel: state.signReg.parcel, keys: state.signReg.keys.map((k) => k.armor()) } : undefined,
  };
}

async function downloadInstrument() {
  const d = state.draft;
  if (!d) return;
  const pdf = await instrumentPdf({
    title: d.title,
    text: d.text,
    returnTo: textarea('doc-return').value,
    signers: textarea('doc-signers').value,
    signatures: d.signed.signatures,
    documentId: d.signed.documentId,
    codes: d.signed.codes,
    required: state.signReg
      ? { parcel: state.signReg.parcel, keys: state.signReg.keys.map((k) => ({ fingerprint: k.getFingerprint().toUpperCase(), userID: k.getUserIDs()[0] ?? '' })) }
      : undefined,
    draft: draftForPdf(),
  });
  const done = !missingSigners().length;
  download(pdf, `${fileSlug(d.title || 'document')}-${done ? 'signed' : 'partly-signed'}-${d.signed.documentId.slice(0, 8)}.pdf`, 'application/pdf');
}

action('dl-instrument', downloadInstrument, 'Preparing PDF...');
$('next-signer').addEventListener('click', () => {
  // Keep the document; switch to the next owner's key.
  state.key = null;
  state.signer = null;
  state.privateArmored = null;
  state.unsaved = false;
  refresh();
  showTab('key');
  $('dl-note').textContent = '';
  banner('Load the next owner’s key and unlock it, then return to "Sign a document" and choose "Add my signature". The document is kept.');
  $('boot').className = 'callout';
});
action('dl-text-txt', () => {
  const d = state.draft;
  if (d) download(d.signed.canonical, `${fileSlug(d.title || 'document')}-${d.signed.documentId.slice(0, 8)}.txt`, 'text/plain');
});
action('dl-text-sig', () => {
  const d = state.draft;
  if (d) download(d.signed.signature, `${fileSlug(d.title || 'document')}-${d.signed.documentId.slice(0, 8)}.txt.sig`, 'application/pgp-signature');
});

// ---------------------------------------------------------------------------
// Step 4: verify
// ---------------------------------------------------------------------------
let verifyRegs: Registration[] = [];

function showVerifyRegs(error?: string) {
  const info = $('v-reg-info');
  info.innerHTML = '';
  $('v-reg-clear').hidden = !verifyRegs.length;
  if (error) {
    info.className = 'hint error';
    info.textContent = error;
    return;
  }
  info.className = 'hint ok';
  const byParcel = new Map<string, Registration[]>();
  for (const r of verifyRegs) byParcel.set(parcelKey(r.parcel), [...(byParcel.get(parcelKey(r.parcel)) ?? []), r]);
  for (const g of byParcel.values()) {
    try {
      info.append(describeRegistration(mergeRegistrations(g)));
    } catch (err) {
      info.className = 'hint error';
      info.append((err as Error).message);
    }
  }
  if (verifyRegs.length) info.append('Compare these fingerprints with the ones printed on the registration forms.');
}

input('v-reg-file').addEventListener('change', async () => {
  const files = [...(input('v-reg-file').files ?? [])];
  if (!files.length) return;
  const info = $('v-reg-info');
  info.className = 'hint';
  try {
    for (const f of files) verifyRegs.push(...(await registrationsFromFile(f, (m) => (info.textContent = m))));
    showVerifyRegs();
  } catch (err) {
    showVerifyRegs((err as Error).message);
  } finally {
    input('v-reg-file').value = '';
  }
});
$('v-reg-clear').addEventListener('click', () => {
  verifyRegs = [];
  showVerifyRegs();
});
$('v-use-sign-reg').addEventListener('click', () => {
  if (state.signReg) verifyRegs = [state.signReg];
  showVerifyRegs();
});
$('v-use-mine').addEventListener('click', () => {
  if (state.key) verifyRegs = [{ parcel: '', keys: [state.key.toPublic()] }];
  showVerifyRegs();
});

/** The registration to check against: the loaded parcel, or the one the signed text names. */
async function registrationFor(payload: string): Promise<Registration> {
  const byParcel = new Map<string, Registration[]>();
  for (const r of verifyRegs) byParcel.set(parcelKey(r.parcel), [...(byParcel.get(parcelKey(r.parcel)) ?? []), r]);
  const groups = [...byParcel.values()];
  if (groups.length === 1) return mergeRegistrations(groups[0]);
  let text = '';
  try {
    text = parcelKey((await decodeCodes(payload)).canonical);
  } catch {
    /* codes incomplete: reported by the check itself */
  }
  const named = groups.filter((g) => g[0].parcel && text.includes(parcelKey(g[0].parcel)));
  if (named.length === 1) return mergeRegistrations(named[0]);
  throw new UserError('Registrations for several parcels are loaded. Clear them and load the registration for this filing’s parcel.');
}

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
    if (verifyRegs.length && scanProgress(textarea('v-payload').value).missing.length === 0) $('verify-btn').click();
  } catch (err) {
    el.className = 'hint error';
    el.textContent = (err as Error).message;
  } finally {
    input('v-codes-file').value = '';
  }
});

/** The last completed paper check, for the printable certificate. */
let lastCheck: {
  result: 'good' | 'bad';
  checks: string[];
  owners: { userID: string; fingerprint: string; result: string; signedAt?: Date }[];
  parcel: string;
  documentId: string;
  signedText: string;
  codes: string[];
} | null = null;


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

action(
  'cert-btn',
  async () => {
    const c = lastCheck;
    if (!c) throw new UserError('Check a filing first.');
    const pdf = await certificatePdf({
      result: c.result,
      checks: c.checks,
      verifierName: input('c-name').value,
      verifierTitle: input('c-title').value,
      agency: input('c-agency').value,
      parcels: input('c-parcels').value,
      owners: c.owners,
      documentId: c.documentId,
      checkedAt: new Date(),
      signedText: c.signedText,
      codes: c.codes,
    });
    download(pdf, `verification-certificate-${c.documentId.slice(0, 12)}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

const VERDICT: Record<Verdict, { title: string; action: string }> = {
  good: {
    title: 'GOOD. Every registered owner signed.',
    action: 'Compare the signed text below with the paper. If it matches, record as usual.',
  },
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
    if (!verifyRegs.length) throw new UserError('Load the parcel registration first (the registration form PDF, a scan or a photo).');
    const payload = textarea('v-payload').value;
    $('vr-text-wrap').hidden = true;
    if (!payload.trim()) {
      throw new UserError(
        'No signature codes. If this filing is for a parcel with a registered key and has no signature page, hold it, notify the owner and investigate.',
      );
    }
    let r;
    lastCheck = null;
    $('cert-wrap').hidden = true;
    if (payload.includes('PGPQ1|')) {
      // Paper filing: the codes carry the signed text.
      const registration = await registrationFor(payload);
      r = await verifyScannedText({ scanned: payload, registration });
      if (r.verdict !== 'incomplete' && r.documentId && r.signedText) {
        lastCheck = {
          result: r.verdict === 'good' ? 'good' : 'bad',
          checks: r.checks.map((c) => `${c.state === 'pass' ? 'Pass' : c.state === 'fail' ? 'Fail' : 'Not checked'}: ${c.label}`),
          owners: (r.signers ?? []).map((x) => ({
            userID: x.userID || (x.registered ? '' : 'NOT REGISTERED'),
            fingerprint: x.fingerprint,
            result: x.state === 'pass' ? 'Valid signature' : x.detail,
            signedAt: x.signedAt,
          })),
          parcel: registration.parcel,
          documentId: r.documentId,
          signedText: r.signedText,
          codes: orderedCodes(payload),
        };
        if (!input('c-agency').value) input('c-agency').value = `${BRAND.county} Recorder`;
        const parcel = /PARCEL NUMBERS?:\s*([0-9][0-9A-Z-]*(?:\s*,\s*[0-9][0-9A-Z-]*)*)/.exec(r.signedText);
        input('c-parcels').value = registration.parcel || (parcel ? parcel[1] : '');
        $('cert-wrap').hidden = false;
      }
      if (r.signedText) {
        $('vr-text').textContent = r.signedText;
        $('vr-text-wrap').hidden = false;
      }
    } else {
      // Electronic filing: a PGPSIG1 code plus the signed file.
      const file = input('v-doc').files?.[0];
      const keys = verifyRegs.flatMap((x) => x.keys);
      let named = '';
      try {
        named = parsePayload(payload).fingerprint;
      } catch {
        /* reported by the check */
      }
      r = await verifyFiling({
        payload,
        registeredKey: keys.find((k) => k.getFingerprint().toUpperCase() === named) ?? keys[0],
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
