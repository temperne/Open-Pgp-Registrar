import './style.css';
import type * as openpgp from 'openpgp';
import {
  generateKeyPair,
  readAnyKey,
  unlockKey,
  summarize,
  isPrivate,
  signDocument,
  signText,
  verifyScannedText,
  verifyBinaryFile,
  binarySignatureFrom,
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
  keyLabel,
  describeKey,
  keyIdentity,
  signRegistration,
  checkRegistrationProof,
  signHolderUpdate,
  checkHolderUpdate,
  registrationStatement,
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
  filePackagePdf,
  sourceFromPdf,
  signerBlocksForKey,
  signerBlocksForUserID,
  registrationDraftFromPdf,
  holderUpdatePdf,
  holderUpdateFromPdf,
  proofFromSigs,
  type RegistrationDraft,
  publicKeyCardPdf,
  registrationsFromPdf,
  draftFromPdf,
  splitParcels,
  type DocumentDraft,
  type SignaturePageInfo,
  checkedCopyPdf,
  type CheckedFile,
} from './pdf';
import { BRAND } from './brand';
import { TEMPLATES, DISCLAIMER, type TemplateFields } from './templates';
import { canonicalText } from './text';
import { extractFile, extractImages, fileSignedText, needsDescription, looksImage, toPrintableImage, SUPPORTED_ALL, type ExtractedFile } from './extract';

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
  /**
   * The document being signed: its text and every owner's signature so far.
   * Kept when keys are switched, so several owners can sign on one computer.
   */
  draft: {
    signed: SignedText;
    title: string;
    text: string;
    returnTo: string;
    signers: string;
    recordable: boolean;
    /** A signed file: printed as cover page, the file's pages, and signatures. */
    source?: { kind: ExtractedFile['kind']; name: string; pages: string[]; pageCount: number; sha256: string[]; description?: string };
  } | null;
  /** The file being signed (its pages and images), when signing a file. */
  source: ExtractedFile | null;
  /** Registration of the parcel being signed for (who must sign). */
  signReg: Registration | null;
  /** Other keys to list on this owner's registration forms (co-owners, trust, beneficiary...). */
  coOwners: openpgp.PublicKey[];
  /** Optional description of each co-owner key, by fingerprint. */
  coLabels: Map<string, string>;
  /**
   * The registration being signed by its key holders (proof of key possession).
   * Kept when keys are switched, so several holders can sign on one computer.
   */
  /** Current holder of each position key, from verified holder updates (by fingerprint). */
  holders: Map<string, { holder: string; effective: string }>;
  regDraft: {
    keys: openpgp.PublicKey[];
    parcels: string[];
    proofs: Record<string, SignedText>;
  } | null;
}
/** Signature lines typed by hand (documents without a registration), instead of from the keys. */
let signersTyped = false;

const state: State = { key: null, signer: null, privateArmored: null, unsaved: false, draft: null, source: null, signReg: null, coOwners: [], coLabels: new Map(), regDraft: null, holders: new Map() };

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
  showAutoSigners();
  const k = state.key;
  $('key-current').hidden = !k;
  $('key-choose').hidden = !!k;

  if (k) {
    const s = summarize(k);
    $('key-fpr').textContent = formatFingerprint(s.fingerprint);
    const id = keyIdentity(k);
    $('key-uid').textContent =
      id.kind === 'position'
        ? `${describeKey(k)}, held by ${state.holders.get(s.fingerprint)?.holder ?? id.holder ?? '(holder not recorded)'}`
        : id.kind === 'group'
          ? `A group; all must sign: ${(id.members ?? []).join(', ')}`
          : `${describeKey(k)} (individual)`;
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
    $('holder-update').hidden = !(state.signer && id.kind === 'position');
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
  $('dl-note').textContent = '';
  input('reg-owner').value = '';
  // Your own key is listed automatically; it never belongs in the co-owner list.
  const mine = key.getFingerprint().toUpperCase();
  state.coOwners = state.coOwners.filter((k) => k.getFingerprint().toUpperCase() !== mine);
  state.coLabels.delete(mine);
  renderCoOwners();
  refresh();
}

action(
  'gen-btn',
  async () => {
    const kind = $<HTMLSelectElement>('gen-kind').value;
    const position = kind === 'position';
    const group = kind === 'group';
    const name = group ? input('gen-name').value.trim() : need(input('gen-name').value, position ? 'Enter the entity\u2019s name.' : 'Enter your full name.');
    const pass = input('gen-pass').value;
    if (pass.length < 8) throw new UserError('Use a passphrase of at least 8 characters.');
    if (pass !== input('gen-pass2').value) throw new UserError('The two passphrases do not match.');
    const { privateArmored } = await generateKeyPair({
      name,
      email: input('gen-email').value,
      passphrase: pass,
      position: position ? input('gen-position').value : undefined,
      holder: position ? input('gen-holder').value : undefined,
      members: group ? textarea('gen-members').value.split('\n') : undefined,
    });
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

input('hu-date').value = new Date().toISOString().slice(0, 10);
action(
  'hu-btn',
  async () => {
    if (!state.signer) return;
    const update = await signHolderUpdate(state.signer, input('hu-name').value, input('hu-date').value);
    const pdf = await holderUpdatePdf(state.signer.toPublic(), update);
    download(pdf, `holder-update-${shortFpr(update.fingerprint)}-${update.effective}.pdf`, 'application/pdf');
  },
  'Signing...',
);

$('gen-kind').addEventListener('change', () => {
  const kind = $<HTMLSelectElement>('gen-kind').value;
  $('gen-position-wrap').hidden = kind !== 'position';
  $('gen-members-wrap').hidden = kind !== 'group';
  $('gen-name-label').textContent =
    kind === 'position' ? 'Entity name (business, trust or other entity)' : kind === 'group' ? 'Group name (optional)' : 'Full name';
  input('gen-name').placeholder =
    kind === 'position' ? 'e.g. Doe Holdings LLC, Doe Family Trust' : kind === 'group' ? 'e.g. Jane and John Doe (defaults to the names below)' : '';
});

$('forget-key').addEventListener('click', () => {
  if (state.unsaved && !confirm('You have not downloaded your new private key. Forget it anyway?')) return;
  state.key = null;
  state.signer = null;
  state.privateArmored = null;
  state.unsaved = false;
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

function keyItem(k: openpgp.PublicKey, extra?: Node, label?: string) {
  const li = document.createElement('li');
  const desc = describeKey(k) || '(no name)';
  const kind = keyIdentity(k).kind;
  li.append(
    Object.assign(document.createElement('strong'), { textContent: label && label !== desc ? `${label}: ${desc}` : desc }),
    Object.assign(document.createElement('span'), { className: 'tag', textContent: kind }),
    Object.assign(document.createElement('span'), { className: 'mono', textContent: formatFingerprint(k.getFingerprint()) }),
  );
  if (extra) li.append(extra);
  return li;
}

function renderCoOwners() {
  const list = $('co-list');
  list.innerHTML = '';
  state.coOwners.forEach((k, i) => {
    const fpr = k.getFingerprint().toUpperCase();
    const controls = document.createElement('span');
    controls.className = 'keyctl';
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Remove' });
    remove.addEventListener('click', () => {
      state.coOwners.splice(i, 1);
      state.coLabels.delete(fpr);
      renderCoOwners();
    });
    controls.append(remove);
    list.append(keyItem(k, controls));
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
    status.textContent = `Added ${describeKey(key)}. Check the fingerprint with its holder.`;
  } catch (err) {
    status.className = 'hint error';
    status.textContent = (err as Error).message;
  } finally {
    input('co-file').value = '';
  }
});

// ---- Proof of key possession: every key listed signs the registration ----
function regKeysFromForm(): openpgp.PublicKey[] {
  const mine = state.key!.toPublic();
  const others = state.coOwners.filter((c) => c.getFingerprint().toUpperCase() !== mine.getFingerprint().toUpperCase());
  return [mine, ...others];
}

function lockRegistration() {
  const d = state.regDraft;
  textarea('reg-parcels').disabled = !!d;
  input('co-file').disabled = !!d;
  $('co-list').querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = !!d));
  const note = $('reg-locked-note');
  note.hidden = !d;
  note.innerHTML = '';
  if (d) {
    const over = Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Start over' });
    over.addEventListener('click', () => {
      if (!confirm('This discards the signatures on this registration. Start over?')) return;
      state.regDraft = null;
      $('reg-result').hidden = true;
      lockRegistration();
      renderCoOwners();
    });
    note.append(
      Object.assign(document.createElement('strong'), { textContent: 'Parcels and keys locked. ' }),
      'Key holders have signed this list. Other details can still be edited. ',
      over,
    );
  }
}

function regMissing() {
  const d = state.regDraft;
  if (!d) return [];
  const first = d.proofs[d.parcels[0]];
  const signed = new Set((first?.signatures ?? []).map((x) => x.fingerprint.toUpperCase()));
  return d.keys.filter((k) => !signed.has(k.getFingerprint().toUpperCase()));
}

function renderRegDraft() {
  const d = state.regDraft;
  $('reg-result').hidden = !d;
  if (!d) return;
  const missing = regMissing();
  const list = $('reg-signers');
  list.innerHTML = '';
  for (const k of d.keys) {
    const li = keyItem(k);
    const done = !missing.includes(k);
    li.className = done ? 'signed' : 'waiting';
    li.prepend(Object.assign(document.createElement('span'), { className: 'tag', textContent: done ? 'signed' : 'still needed' }));
    list.append(li);
  }
  const status = $('reg-status');
  status.textContent = missing.length ? `Not complete: ${d.keys.length - missing.length} of ${d.keys.length}` : 'Complete: every key signed';
  status.className = missing.length ? 'pill warn' : 'pill good';
  $('dl-reg').textContent = missing.length ? 'Download for the next key holder (PDF)' : 'Download registration form(s) (PDF)';
  $('reg-next').hidden = !missing.length;
  $('reg-next-hint').textContent = missing.length
    ? 'Give the PDF to the next key holder (they choose "Continue a registration" and load it), or let them sign on this computer.'
    : 'Print and file it. Every signer still signs in ink before a notary.';
}

action(
  'reg-btn',
  async () => {
    if (!state.key) return;
    if (!state.signer) {
      throw new UserError('Unlock your private key in step 1 first. Signing the registration proves you hold the key and its passphrase.');
    }
    need(input('reg-owner').value, 'Enter the owner(s) of record.');
    if (!state.regDraft) {
      const parcels = splitParcels(need(textarea('reg-parcels').value, 'Enter the parcel number.'));
      state.regDraft = { keys: regKeysFromForm(), parcels, proofs: {} };
    }
    const d = state.regDraft;
    if (!d.keys.some((k) => k.getFingerprint().toUpperCase() === state.signer!.getFingerprint().toUpperCase())) {
      throw new UserError('Your key is not on this registration. Load one of its listed keys, or choose "Start over" above to begin a new registration.');
    }
    for (const parcel of d.parcels) {
      d.proofs[parcel] = await signRegistration(state.signer, { parcel, keys: d.keys, proof: d.proofs[parcel] });
    }
    lockRegistration();
    renderRegDraft();
    $('reg-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

action(
  'dl-reg',
  async () => {
    const d = state.regDraft;
    if (!d) return;
    const first = d.keys[0];
    const s = summarize(first);
    const sigsOf = (p?: SignedText) =>
      (p?.signatures ?? []).map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) }));
    const draft: RegistrationDraft = {
      format: 'stop-registration-draft-1',
      ownerName: input('reg-owner').value.trim(),
      parcels: d.parcels.join('\n'),
      propertyAddress: input('reg-property').value.trim(),
      mailingAddress: input('reg-mailing').value.trim(),
      county: input('reg-county').value.trim(),
      replacement: isReplacement(),
      previousFingerprint: input('reg-prev').value.trim(),
      keys: d.keys.map((k) => k.armor()),
      proofs: Object.fromEntries(d.parcels.map((p) => [p, sigsOf(d.proofs[p])])),
    };
    const pdf = await registrationPdf({
      ownerName: draft.ownerName,
      parcels: draft.parcels,
      coOwnerKeys: d.keys.slice(1),
      proofs: d.proofs,
      draft,
      propertyAddress: draft.propertyAddress,
      mailingAddress: draft.mailingAddress,
      county: draft.county,
      replacement: draft.replacement,
      previousFingerprint: draft.previousFingerprint,
      fingerprint: s.fingerprint,
      algorithm: s.algorithm,
      created: s.created,
      userID: s.userIDs[0] ?? '',
      publicKeyBinary: first.write(),
      publicArmored: s.publicArmored,
    });
    const done = !regMissing().length;
    download(
      pdf,
      `key-registration-${fileSlug(d.parcels[0])}${d.parcels.length > 1 ? `-and-${d.parcels.length - 1}-more` : ''}${done ? '' : '-partly-signed'}.pdf`,
      'application/pdf',
    );
  },
  'Preparing PDF...',
);

$('reg-next').addEventListener('click', () => {
  state.key = null;
  state.signer = null;
  state.privateArmored = null;
  state.unsaved = false;
  refresh();
  showTab('key');
  banner('Load the next key holder’s key and unlock it, then return to "Register" and choose "Sign the registration with my key". The registration is kept.');
  $('boot').className = 'callout';
});

input('reg-continue-file').addEventListener('change', async () => {
  const f = input('reg-continue-file').files?.[0];
  if (!f) return;
  const status = $('reg-continue-status');
  status.className = 'hint';
  try {
    const draft = await registrationDraftFromPdf(new Uint8Array(await f.arrayBuffer()));
    if (!draft) throw new Error('No registration in progress was found in that PDF. Load the registration PDF made by this tool.');
    const keys = await Promise.all(draft.keys.map(async (a) => (await readAnyKey(a)).toPublic()));
    const parcels = splitParcels(draft.parcels);
    const proofs: Record<string, SignedText> = {};
    for (const p of parcels) {
      const proof = await proofFromSigs({ parcel: p, keys }, draft.proofs[p] ?? []);
      if (proof) proofs[p] = proof;
    }
    state.regDraft = { keys, parcels, proofs };
    input('reg-owner').value = draft.ownerName;
    textarea('reg-parcels').value = draft.parcels;
    input('reg-property').value = draft.propertyAddress;
    input('reg-mailing').value = draft.mailingAddress;
    input('reg-county').value = draft.county;
    input('reg-prev').value = draft.previousFingerprint;
    document.querySelectorAll<HTMLInputElement>('input[name="reg-kind"]').forEach((r) => (r.checked = r.value === (draft.replacement ? 'replacement' : 'new')));
    state.coOwners = keys.slice(1);
    renderCoOwners();
    lockRegistration();
    renderRegDraft();
    refresh();
    status.className = 'hint ok';
    status.textContent = `Loaded a registration signed by ${keys.length - regMissing().length} of ${keys.length} keys. Unlock your key and choose "Sign the registration with my key".`;
  } catch (err) {
    status.className = 'hint error';
    status.textContent = (err as Error).message;
  } finally {
    input('reg-continue-file').value = '';
  }
});

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
    if (groups.size) {
      const regs = await Promise.all([...groups.values()].map((g) => decodeRegistrationCodes(g.join('\n'))));
      // Proof codes (PGPQ1) on the same pages: match each to its registration's statement.
      const proofGroups = new Map<string, string[]>();
      for (const c of codes) {
        const m = /^PGPQ1\|([0-9A-F]{12})\|/.exec(c);
        if (m) proofGroups.set(m[1], [...(proofGroups.get(m[1]) ?? []), c]);
      }
      for (const g of proofGroups.values()) {
        try {
          const proof = await signedFromCodes(g.join('\n'));
          const reg = regs.find((r) => canonicalText(registrationStatement(r)) === proof.canonical);
          if (reg) reg.proof = proof;
        } catch {
          /* incomplete proof codes: reported as not proven */
        }
      }
      return regs;
    }
    return [{ parcel: '', keys: [(await keyFromCodes(codes)).toPublic()] }];
  }
  return [{ parcel: '', keys: [(await readAnyKey(bytes)).toPublic()] }];
}

function describeRegistration(r: Registration) {
  const frag = document.createDocumentFragment();
  frag.append(r.parcel ? `Parcel ${r.parcel}: ` : 'Key(s) without a parcel number: ', `${r.keys.length} key${r.keys.length === 1 ? '' : 's'}, all must sign.`);
  const ul = Object.assign(document.createElement('ul'), { className: 'keylist' });
  for (const k of r.keys) ul.append(keyItem(k, undefined, keyLabel(r, k.getFingerprint())));
  frag.append(ul);
  return frag;
}

// ---------------------------------------------------------------------------
// Step 3: sign document text (paper workflow), by one owner or several
// ---------------------------------------------------------------------------
const FIELD_IDS: (keyof TemplateFields)[] = ['grantor', 'grantee', 'county', 'parcels', 'propertyAddress', 'legal', 'consideration', 'date', 'terms'];
/** The deed wording of each field label, restored when a template does not rename it. */
const DEFAULT_LABELS = new Map<string, string>();
document.querySelectorAll<HTMLLabelElement>('#tpl-fields [data-field] label').forEach((l) => DEFAULT_LABELS.set(l.htmlFor, l.innerHTML));
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
  if (state.draft || state.source) return; // locked once anyone has signed; a file supplies its own text
  const t = currentTemplate();
  $('tpl-note').textContent = t.note;
  document.querySelectorAll<HTMLElement>('#tpl-fields [data-field]').forEach((el) => {
    const field = el.dataset.field as keyof TemplateFields;
    el.hidden = !t.uses.includes(field);
    const label = el.querySelector('label')!;
    if (t.labels?.[field]) label.textContent = t.labels[field]!;
    else label.innerHTML = DEFAULT_LABELS.get(label.htmlFor) ?? label.innerHTML;
  });
  $('doc-return-wrap').hidden = !t.recordable;
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
  // The template and its fields only build new text; hide them while the text is locked or a file is being signed.
  const hideTemplate = locked || !!state.source;
  for (const el of [document.querySelector<HTMLElement>('label[for="tpl"]')!, $('tpl'), $('tpl-note'), $('tpl-fields')]) el.hidden = hideTemplate;
  if (state.source && !locked) {
    // A file's own text cannot be edited; an image's or scan's description can, until someone signs.
    textarea('doc-text').disabled = !needsDescription(state.source);
    input('doc-title').disabled = true;
  }
  if (!locked && !state.source) syncTemplate();
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
      clearSource();
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
  showAutoSigners();
  {
    const d = state.draft;
    const parcel = state.signReg?.parcel;
    const missing = !!(d && parcel && !parcelKey(d.signed.canonical).includes(parcelKey(parcel)));
    $('tr-parcel-warn').hidden = !missing;
    if (missing) {
      $('tr-parcel-warn').textContent =
        `For third parties only: not for recording. The signed text does not name the registered parcel, ${parcel}, so the Recorder's check will not accept it. ` +
        'A tenant, buyer, bank or anyone else you give it to can still check that the owners of record signed it.';
    }
  }
  const d = state.draft;
  if (!d) return;
  const list = $('tr-signers');
  list.innerHTML = '';
  const names = new Map(state.signReg?.keys.map((k) => [k.getFingerprint().toUpperCase(), k.getUserIDs()[0] ?? '']) ?? []);
  for (const sig of d.signed.signatures) {
    const li = document.createElement('li');
    li.className = 'signed';
    li.append(
      Object.assign(document.createElement('strong'), {
        textContent: `Signed: ${keyLabel(state.signReg, sig.fingerprint) ? `${keyLabel(state.signReg, sig.fingerprint)}: ` : ''}${sig.userID || names.get(sig.fingerprint) || '(name not given)'}`,
      }),
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
      Object.assign(document.createElement('strong'), {
        textContent: `Still needed: ${keyLabel(state.signReg, k.getFingerprint()) ? `${keyLabel(state.signReg, k.getFingerprint())}: ` : ''}${k.getUserIDs()[0] ?? '(no name)'}`,
      }),
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
    status.textContent = 'Complete: every registered key signed';
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

/** With a registration loaded, signature lines come from its keys. */
function showAutoSigners() {
  const auto = !!state.signReg || !!state.source || (!signersTyped && signingKeyIDs().length > 0);
  $('doc-signers-wrap').hidden = auto;
  $('doc-signers-auto').hidden = !auto;
  $('doc-signers-from').textContent = state.signReg
    ? 'From the parcel registration: one signature line and notary acknowledgment for each person who signs for each registered key.'
    : 'From the signing key(s): one signature line and notary acknowledgment for each person who signs for each key (every member of a group; the holder of a position). Load the parcel registration to include every owner.';
  const list = $('doc-signers-list');
  list.innerHTML = '';
  if (!state.signReg) {
    for (const k of signingKeyIDs()) {
      const li = document.createElement('li');
      li.append(
        Object.assign(document.createElement('strong'), { textContent: k.userID.replace(/\s*<[^>]*>\s*$/, '') || '(no name)' }),
        Object.assign(document.createElement('span'), {
          textContent: `Signs: ${signerBlocksForUserID(k.userID, state.holders.get(k.fingerprint)?.holder).map((b) => b.caption).join('; ')}`,
        }),
      );
      list.append(li);
    }
  }
  for (const k of state.signReg?.keys ?? []) {
    const blocks = signerBlocksForKey(k, state.holders.get(k.getFingerprint().toUpperCase())?.holder);
    const li = keyItem(k, undefined, keyLabel(state.signReg, k.getFingerprint()));
    li.append(Object.assign(document.createElement('span'), { textContent: `Signs: ${blocks.map((b) => b.caption).join('; ')}` }));
    list.append(li);
  }
}

input('s-holder-file').addEventListener('change', async () => {
  const files = [...(input('s-holder-file').files ?? [])];
  const info = $('s-holder-info');
  info.className = 'hint';
  info.textContent = '';
  try {
    for (const f of files) {
      const got = await holderUpdateFromPdf(new Uint8Array(await f.arrayBuffer()));
      if (!got) throw new Error(`${f.name}: not a holder update made by this tool.`);
      const registered = state.signReg?.keys.find((k) => k.getFingerprint().toUpperCase() === got.update.fingerprint.toUpperCase());
      if (state.signReg && !registered) throw new Error(`${f.name}: that key is not registered for this parcel.`);
      if (!(await checkHolderUpdate(got.update, registered ?? got.key))) throw new Error(`${f.name}: the update's signature does not verify. Do not use it.`);
      const prev = state.holders.get(got.update.fingerprint);
      if (!prev || prev.effective <= got.update.effective) state.holders.set(got.update.fingerprint, { holder: got.update.holder, effective: got.update.effective });
    }
    info.className = 'hint ok';
    info.textContent = [...state.holders.values()].map((h) => `${h.holder} (from ${h.effective})`).join('; ') + '. Signature blocks updated.';
    showAutoSigners();
  } catch (err) {
    info.className = 'hint error';
    info.textContent = (err as Error).message;
  } finally {
    input('s-holder-file').value = '';
  }
});

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
    showAutoSigners();
    const info = $('s-reg-info');
    info.className = 'hint ok';
    info.innerHTML = '';
    if (state.signReg) {
      info.append(describeRegistration(state.signReg));
      const reg = state.signReg;
      void checkRegistrationProof(reg).then((ps) => {
        if (!ps.complete && state.signReg === reg) {
          info.append(
            Object.assign(document.createElement('p'), {
              className: 'hint error',
              textContent: 'This registration is not fully signed by its keys yet, so the Recorder’s check will fail until it is.',
            }),
          );
        }
      });
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

// ---- Sign a file: recreated as a printable package, and that recreation is signed ----
function showSource() {
  const src = state.source;
  const info = $('src-info');
  $('src-clear').hidden = !src;
  if (!src) $('src-pdf-tip').hidden = true;
  if (!src) {
    info.textContent = '';
    textarea('doc-text').placeholder = '';
    return;
  }
  const kinds = { pdf: 'PDF', docx: 'Word document', odt: 'OpenDocument text', text: 'text file', image: 'image', scan: 'scanned PDF (no text)' };
  info.className = 'hint ok';
  info.textContent =
    `${src.name}: ${kinds[src.kind]}${src.pageCount ? `, ${src.pageCount} page${src.pageCount === 1 ? '' : 's'}` : ''}. ` +
    (needsDescription(src)
      ? 'It has no text of its own: describe or transcribe what it shows in the box below. That description is what gets signed, and the Recorder compares it with the printed pages.'
      : src.kind === 'pdf'
        ? 'Its text is shown below, exactly as it will be signed. The PDF’s own pages are reprinted in the package.'
        : 'Its text is shown below, exactly as it will be signed, and is recreated as plain text pages in the package.');
  // Formatting is only kept for PDFs: say so plainly, so nobody is surprised by the printout.
  $('src-pdf-tip').hidden = src.kind === 'pdf' || src.kind === 'scan' || src.kind === 'image';
  input('doc-title').value = '';
  textarea('doc-text').value = needsDescription(src) ? '' : src.pages.join('\n\n');
  textarea('doc-text').placeholder = needsDescription(src) ? 'Describe or transcribe what the file shows. Include the parcel number.' : '';
  edited.add('doc-text');
  edited.add('doc-title');
  $('doc-return-wrap').hidden = true;
  lockDraft();
  updateCount();
}

function clearSource() {
  state.source = null;
  textarea('doc-text').disabled = false;
  input('doc-title').disabled = false;
  edited.delete('doc-text');
  edited.delete('doc-title');
  showSource();
}

input('src-file').addEventListener('change', async () => {
  const files = [...(input('src-file').files ?? [])];
  if (!files.length) return;
  const info = $('src-info');
  info.className = 'hint';
  info.textContent = 'Reading the file...';
  try {
    if (state.draft) throw new Error('A signed document is already loaded. Choose "Start over with new text" first.');
    state.source = files.length > 1 || files.every((f) => looksImage(f)) ? await extractImages(files) : await extractFile(files[0]);
    showSource();
  } catch (err) {
    info.className = 'hint error';
    info.textContent = (err as Error).message;
  } finally {
    input('src-file').value = '';
  }
});
$('src-clear').addEventListener('click', () => {
  clearSource();
  syncTemplate(true);
  lockDraft();
});
$('src-types').textContent = SUPPORTED_ALL;

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
      if (embedded.source) {
        const files = await sourceFromPdf(bytes);
        state.source = { ...embedded.source, pdf: files.pdf, images: files.images.length ? files.images : undefined };
        showSource();
      }
      if (embedded.registration && !state.signReg) {
        const keys = await Promise.all(embedded.registration.keys.map(async (a) => (await readAnyKey(a)).toPublic()));
        useSignRegistration([{ parcel: embedded.registration.parcel, keys, labels: embedded.registration.labels }]);
      }
      setDraft({
        signed,
        title: embedded.title,
        text: embedded.text,
        returnTo: embedded.returnTo,
        signers: embedded.signers,
        recordable: embedded.recordable !== false,
        source: embedded.source,
      });
    } else {
      // A scan or photo of the signature page: the codes carry the text and signatures.
      const { readCodesFromFile } = await import('./qrscan');
      const codes = await readCodesFromFile(f, (m) => (status.textContent = m), (c) => {
        const p = scanProgress(c.join('\n'));
        return p.total > 0 && p.missing.length === 0;
      });
      const signed = await signedFromCodes(codes.join('\n'));
      setDraft({ signed, title: '', text: signed.canonical, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value, recordable: true });
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
        `Your key is not registered for ${state.signReg.parcel ? `parcel ${state.signReg.parcel}` : 'this parcel'}. Load one of the keys listed on the registration.`,
      );
    }
    if (state.draft) {
      const d = state.draft;
      const signed = await signText(state.signer, fullText(d.title, d.text), d.signed);
      setDraft({ ...d, signed, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
    } else if (state.source) {
      const src = state.source;
      const description = textarea('doc-text').value;
      if (needsDescription(src) && canonicalText(description).length < 20) {
        throw new UserError('Describe or transcribe what the file shows (at least a sentence). That description is what gets signed and checked.');
      }
      // A file that does not name the parcel can still be signed: it is then for third
      // parties only (a tenant, buyer, bank), and the result says so.
      const full = fileSignedText(src, description);
      const signed = await signText(state.signer, full);
      setDraft({
        signed,
        title: '',
        text: full,
        returnTo: '',
        signers: textarea('doc-signers').value,
        recordable: false,
        source: { kind: src.kind, name: src.name, pages: src.pages, pageCount: src.pageCount, sha256: src.sha256, description: needsDescription(src) ? description : undefined },
      });
    } else {
      const text = textarea('doc-text').value;
      const title = input('doc-title').value.trim();
      if (!canonicalText(text)) throw new UserError('Write the document text first.');
      const placeholder = fullText(title, text).match(/\[[A-Z][A-Z ]+\]/);
      if (placeholder) throw new UserError(`Fill in ${placeholder[0]} before signing.`);
      // A recordable document (a deed) must name the parcel; anything else may be signed for third parties.
      if (currentTemplate().recordable && state.signReg?.parcel && !parcelKey(fullText(title, text)).includes(parcelKey(state.signReg.parcel))) {
        throw new UserError(
          `A document for recording must name the registered parcel number, ${state.signReg.parcel}, or the Recorder's check will fail. (Documents for a tenant, buyer or bank can use a non-recorded template.)`,
        );
      }
      const signed = await signText(state.signer, fullText(title, text));
      setDraft({ signed, title, text, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value, recordable: currentTemplate().recordable });
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
    recordable: d.recordable,
    source: d.source,
    signatures: d.signed.signatures.map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) })),
    registration: state.signReg
      ? { parcel: state.signReg.parcel, keys: state.signReg.keys.map((k) => k.armor()), labels: state.signReg.labels }
      : undefined,
  };
}

/**
 * Who signs in ink, from the keys: the registration's keys when one is loaded,
 * otherwise every key that has signed so far plus the key in use. A group key
 * gives one block per member; a position key names its current holder.
 */
function signingKeyIDs(): { fingerprint: string; userID: string }[] {
  if (state.signReg) return state.signReg.keys.map((k) => ({ fingerprint: k.getFingerprint().toUpperCase(), userID: k.getUserIDs()[0] ?? '' }));
  const out = new Map<string, string>();
  for (const s of state.draft?.signed.signatures ?? []) out.set(s.fingerprint.toUpperCase(), s.userID);
  if (state.key) out.set(state.key.getFingerprint().toUpperCase(), state.key.getUserIDs()[0] ?? '');
  return [...out].map(([fingerprint, userID]) => ({ fingerprint, userID }));
}

function currentSignerBlocks() {
  return signingKeyIDs().flatMap((k) => signerBlocksForUserID(k.userID, state.holders.get(k.fingerprint)?.holder));
}

async function downloadInstrument() {
  const d = state.draft;
  if (!d) return;
  // A text document without a registration keeps any signature lines typed by hand.
  const typed = !state.signReg && !d.source && textarea('doc-signers').value.trim() && signersTyped;
  const signerBlocks = typed ? undefined : currentSignerBlocks();
  const notForRecording = !!state.signReg?.parcel && !parcelKey(d.signed.canonical).includes(parcelKey(state.signReg.parcel));
  const required = state.signReg
    ? {
        notForRecording,
        parcel: state.signReg.parcel,
        keys: state.signReg.keys.map((k) => ({ fingerprint: k.getFingerprint().toUpperCase(), userID: k.getUserIDs()[0] ?? '', label: keyLabel(state.signReg, k.getFingerprint()) })),
      }
    : undefined;
  if (d.source && state.source) {
    const pkg = await filePackagePdf({
      source: state.source,
      description: d.source.description,
      signatures: d.signed.signatures,
      documentId: d.signed.documentId,
      codes: d.signed.codes,
      required,
      signerBlocks,
      draft: draftForPdf(),
    });
    const done = !missingSigners().length;
    download(pkg, `${fileSlug(baseName(d.source.name))}-${done ? 'signed' : 'partly-signed'}-${d.signed.documentId.slice(0, 8)}.pdf`, 'application/pdf');
    return;
  }
  const pdf = await instrumentPdf({
    signerBlocks,
    title: d.title,
    text: d.text,
    recordable: d.recordable,
    returnTo: d.recordable ? textarea('doc-return').value : '',
    signers: textarea('doc-signers').value,
    signatures: d.signed.signatures,
    documentId: d.signed.documentId,
    codes: d.signed.codes,
    required: state.signReg
      ? {
          notForRecording,
          parcel: state.signReg.parcel,
          keys: state.signReg.keys.map((k) => ({
            fingerprint: k.getFingerprint().toUpperCase(),
            userID: k.getUserIDs()[0] ?? '',
            label: keyLabel(state.signReg, k.getFingerprint()),
          })),
        }
      : undefined,
    draft: draftForPdf(),
  });
  const done = !missingSigners().length;
  download(pdf, `${fileSlug(d.title || 'document')}-${done ? 'signed' : 'partly-signed'}-${d.signed.documentId.slice(0, 8)}.pdf`, 'application/pdf');
}

action('dl-instrument', downloadInstrument, 'Preparing PDF...');
$('doc-signers-type').addEventListener('click', () => {
  if (state.signReg || state.draft?.source || state.source) return;
  signersTyped = true;
  if (!textarea('doc-signers').value.trim()) textarea('doc-signers').value = currentSignerBlocks().map((b) => b.caption).join('\n');
  showAutoSigners();
  textarea('doc-signers').focus();
});
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

// ---- Binary file signature (advanced; for third parties, not for recording) ----
let binSigned: { doc: SignedDocument; file: File; bytes: Uint8Array; info: SignaturePageInfo } | null = null;
action(
  'bin-btn',
  async () => {
    if (!state.signer) throw new UserError('Unlock your private key in step 1 first.');
    const file = input('bin-file').files?.[0];
    if (!file) throw new UserError('Choose the file to sign.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await signDocument(state.signer, bytes);
    const info: SignaturePageInfo = {
      documentTitle: input('bin-title').value.trim(),
      fileName: file.name,
      fileSize: bytes.length,
      parcels: '',
      userID: describeKey(state.signer),
      fingerprint: doc.fingerprint,
      signedAt: doc.signedAt,
      sha256: doc.sha256,
      documentId: doc.documentId,
      payload: doc.payload,
    };
    binSigned = { doc, file, bytes, info };
    $('bin-r-file').textContent = `${file.name} (${bytes.length.toLocaleString()} bytes)`;
    $('bin-r-hash').textContent = doc.sha256;
    $('dl-bincopy').hidden = !isPdfBytes(bytes);
    $('bin-result').hidden = false;
  },
  'Signing...',
);
action('dl-binsig', () => {
  if (binSigned) download(binSigned.doc.signature, `${binSigned.file.name}.sig`, 'application/pgp-signature');
});
action('dl-binpage', async () => {
  if (binSigned) download(await signaturePagePdf(binSigned.info), `${baseName(binSigned.file.name)}-verification-page.pdf`, 'application/pdf');
});
action('dl-bincopy', async () => {
  if (binSigned) download(await printCopyPdf(binSigned.bytes, binSigned.info), `${baseName(binSigned.file.name)}-with-verification-page.pdf`, 'application/pdf');
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
      const merged = mergeRegistrations(g);
      info.append(describeRegistration(merged));
      const line = Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Checking proof of key possession...' });
      info.append(line);
      void checkRegistrationProof(merged).then((ps) => {
        line.className = ps.complete ? 'hint ok' : 'hint error';
        line.textContent = ps.complete
          ? `Proof of key possession: every key signed this registration.`
          : `Proof of key possession NOT COMPLETE${ps.problems.length ? ` (${ps.problems.join(' ')})` : ''}: ` +
            `${ps.missing.length} of ${merged.keys.length} keys have not signed. Do not activate these keys or rely on this registration.`;
      });
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

action(
  'bin-v-btn',
  async () => {
    if (!verifyRegs.length) throw new UserError('Load the owner\u2019s registration or public key card first (above).');
    const file = input('bin-v-file').files?.[0];
    const sigFile = input('bin-v-sig').files?.[0];
    if (!file) throw new UserError('Choose the signed file, exactly as you received it.');
    if (!sigFile) throw new UserError('Choose its signature: the .sig file, or the verification page.');
    const sigBytes = new Uint8Array(await sigFile.arrayBuffer());
    let signature: Uint8Array;
    if (isPdfBytes(sigBytes) || isImage(sigFile)) {
      // The verification page: read its PGPSIG1 code.
      const { readCodesFromFile } = await import('./qrscan');
      const codes = await readCodesFromFile(sigFile, undefined, (c) => c.some((x) => x.startsWith('PGPSIG1|')));
      const code = codes.find((x) => x.startsWith('PGPSIG1|'));
      if (!code) throw new UserError('No binary signature code was found on that page. Load the verification page, or the .sig file.');
      signature = await binarySignatureFrom(code);
    } else {
      signature = await binarySignatureFrom(sigBytes).catch(() => {
        throw new UserError('That is not a signature file. Load the .sig file, or the verification page.');
      });
    }
    await checkBinary(file, signature);
  },
  'Checking...',
);

/** Checks a binary-signed file against the loaded keys and shows the result. */
async function checkBinary(file: File, signature: Uint8Array) {
  const keys = mergeRegistrations(verifyRegs).keys;
  const r = await verifyBinaryFile({ signature, document: new Uint8Array(await file.arrayBuffer()), keys });
  r.checks.push({
    label: 'What this proves',
    state: 'skipped',
    detail: 'That this exact file was signed by the key(s) above. A binary file signature is for files sent directly to you; it is not used for filing with the Recorder.',
  });
  lastCheck = null;
  checkedFiles = [file];
  $('cert-wrap').hidden = true;
  $('vr-text-wrap').hidden = true;
  showResult(r);
}

/** The files that were checked, for the stamped "checked copy". */
let checkedFiles: File[] = [];

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

/** Each scanned file and whether it carries the same signed text as the others. */
interface ScannedFile {
  name: string;
  documentId?: string;
  signatures: number;
  same: boolean;
  problem?: string;
}
let scannedFiles: ScannedFile[] = [];
let settingPayload = false;

function setPayload(v: string) {
  settingPayload = true;
  textarea('v-payload').value = v;
  textarea('v-payload').dispatchEvent(new Event('input'));
  settingPayload = false;
}

/**
 * Reads every chosen file (the filed deed, each owner's copy...). All must carry
 * the same signed text; their signatures are combined for the check.
 */
input('v-codes-file').addEventListener('change', async () => {
  const files = [...(input('v-codes-file').files ?? [])];
  if (!files.length) return;
  const el = $('v-progress');
  el.className = 'hint';
  try {
    const { readCodesFromFile } = await import('./qrscan');
    const results: { name: string; signed?: SignedText; legacy?: string[]; problem?: string }[] = [];
    for (const [i, f] of files.entries()) {
      const codes = await readCodesFromFile(
        f,
        (m) => (el.textContent = files.length > 1 ? `File ${i + 1} of ${files.length}: ${m}` : m),
        (c) => {
          const p = scanProgress(c.join('\n'));
          return (p.total > 0 && p.missing.length === 0) || c.some((x) => x.startsWith('PGPSIG1|'));
        },
      );
      const sigCodes = codes.filter((c) => /^(PGPQ1|PGPSIG1)\|/.test(c.trim()));
      if (!sigCodes.length) {
        results.push({ name: f.name, problem: codes.length ? 'no signature codes' : 'no QR codes found' });
        continue;
      }
      if (sigCodes.some((c) => c.startsWith('PGPSIG1|'))) {
        results.push({ name: f.name, legacy: sigCodes });
        continue;
      }
      try {
        results.push({ name: f.name, signed: await signedFromCodes(sigCodes.join('\n')) });
      } catch (err) {
        results.push({ name: f.name, problem: (err as Error).message });
      }
    }
    const legacy = results.find((r) => r.legacy);
    if (legacy && files.length === 1) {
      scannedFiles = [];
      setPayload(legacy.legacy!.join('\n') + '\n');
      el.textContent = 'This is the verification page of a binary file signature. Open "Check a binary-signed file" below and load the signed file with this page.';
      return;
    }
    const readable = results.filter((r) => r.signed);
    if (!readable.length) {
      el.className = 'hint error';
      el.textContent =
        results.map((r) => `${r.name}: ${r.problem ?? 'unreadable'}`).join('; ') +
        '. Make sure the signature page is included, sharp and well lit.';
      return;
    }
    // The reference text: the one most files carry.
    const counts = new Map<string, number>();
    for (const r of readable) counts.set(r.signed!.canonical, (counts.get(r.signed!.canonical) ?? 0) + 1);
    const reference = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const sigs = new Map<string, DocSignature>();
    for (const r of readable) {
      if (r.signed!.canonical !== reference) continue;
      for (const sig of r.signed!.signatures) if (!sigs.has(sig.fingerprint)) sigs.set(sig.fingerprint, sig);
    }
    const merged = await assembleSigned(reference, [...sigs.values()]);
    scannedFiles = results.map((r) => ({
      name: r.name,
      documentId: r.signed?.documentId,
      signatures: r.signed?.signatures.length ?? 0,
      same: !!r.signed && r.signed.canonical === reference,
      problem: r.problem ?? (r.legacy ? 'electronic-filing code; check it on its own' : undefined),
    }));
    checkedFiles = files;
    setPayload(merged.codes.join('\n') + '\n');
    // Check right away when everything needed is there.
    if (verifyRegs.length) $('verify-btn').click();
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
  files: ScannedFile[];
  parcel: string;
  documentId: string;
  signedText: string;
  codes: string[];
} | null = null;


textarea('v-payload').addEventListener('input', () => {
  if (!settingPayload) {
    scannedFiles = [];
    checkedFiles = [];
  }
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
    if (!c) throw new UserError('Check a document first.');
    const pdf = await certificatePdf({
      result: c.result,
      checks: c.checks,
      verifierName: input('c-name').value,
      verifierTitle: input('c-title').value,
      agency: input('c-agency').value,
      parcels: input('c-parcels').value,
      owners: c.owners,
      files: c.files.map((f) => ({ name: f.name, documentId: f.documentId ?? '', signatures: f.signatures, same: f.same })),
      documentId: c.documentId,
      checkedAt: new Date(),
      signedText: c.signedText,
      codes: c.codes,
    });
    download(pdf, `verification-certificate-${c.documentId.slice(0, 12)}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

function showResult(r: {
  verdict: Verdict;
  checks: { label: string; state: string; detail: string }[];
  documentId?: string;
  signedAt?: Date;
  notForRecording?: boolean;
}) {
  const b = $('vr-banner');
  const thirdParty = r.verdict === 'good' && r.notForRecording;
  b.className = `verdict ${thirdParty ? 'incomplete' : r.verdict}`;
  b.innerHTML = '';
  const v = thirdParty ? NOT_FOR_RECORDING : VERDICT[r.verdict];
  b.append(
    Object.assign(document.createElement('strong'), { textContent: v.title }),
    Object.assign(document.createElement('span'), { textContent: v.action }),
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
  lastVerdict = { verdict: r.verdict, documentId: r.documentId, notForRecording: thirdParty };
  $('copy-wrap').hidden = r.verdict === 'incomplete' || !checkedFiles.length;
  $('verify-result').hidden = false;
  $('verify-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let lastVerdict: { verdict: Verdict; documentId?: string; notForRecording?: boolean } | null = null;

action(
  'copy-btn',
  async () => {
    if (!lastVerdict || !checkedFiles.length) throw new UserError('Check a document first.');
    const files: CheckedFile[] = [];
    for (const f of checkedFiles) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      const sha256 = [...d].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
      const entry: CheckedFile = { name: f.name, sha256 };
      if (isPdfBytes(bytes)) entry.pdf = bytes;
      else if (isImage(f)) entry.image = await toPrintableImage(f, bytes).catch(() => undefined);
      files.push(entry);
    }
    const v = lastVerdict.verdict === 'incomplete' ? 'bad' : lastVerdict.verdict;
    const pdf = await checkedCopyPdf({
      files,
      result: v,
      summary: v !== 'good' ? 'do not rely on it' : lastVerdict.notForRecording ? 'every key signed; third parties only, not for recording' : 'every key signed',
      documentId: lastVerdict.documentId,
      checkedAt: new Date(),
    });
    download(pdf, `checked-copy-${(lastVerdict.documentId ?? 'document').slice(0, 12)}.pdf`, 'application/pdf');
  },
  'Preparing PDF...',
);

const NOT_FOR_RECORDING = {
  title: 'SIGNED BY THE OWNERS. FOR THIRD PARTIES ONLY: NOT FOR RECORDING.',
  action:
    'Every registered key signed this text, but it does not name the registered parcel. A tenant, buyer or bank can rely on who signed it; read the text to see what it covers. Recorder staff: do not record it against the parcel.',
};

const VERDICT: Record<Verdict, { title: string; action: string }> = {
  good: {
    title: 'GOOD. Every registered key signed.',
    action: 'Compare the signed text below with the paper. If it matches, the document is genuine (Recorder staff: record as usual).',
  },
  bad: {
    title: 'DOES NOT VERIFY.',
    action: 'Do not rely on this document. Recorder staff: hold the filing, flag it as a suspected forgery, preserve it, and notify the owner of record.',
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
      for (const f of scannedFiles) {
        r.checks.push({
          label: `Scanned copy: ${f.name}`,
          state: f.same ? 'pass' : 'fail',
          detail: f.same
            ? `Document ID ${f.documentId}, ${f.signatures} signature${f.signatures === 1 ? '' : 's'}: the same text as every other copy.`
            : f.problem
              ? `Could not be checked: ${f.problem}.`
              : `Document ID ${f.documentId}: DIFFERENT TEXT from the other copies. Hold the filing.`,
        });
        if (!f.same && r.verdict === 'good') r.verdict = 'bad';
      }
      if (r.verdict !== 'incomplete' && !registration.parcel) {
        r.checks.push({
          label: 'Checked against a key, not a registration',
          state: 'skipped',
          detail: 'Only a public key (card) was loaded. Confirm with the County Recorder that this key is registered for the parcel.',
        });
      } else if (r.verdict !== 'incomplete') {
        const ps = await checkRegistrationProof(registration);
        r.checks.push({
          label: 'Registration proven by every key',
          state: ps.complete ? 'pass' : 'fail',
          detail: ps.complete
            ? 'Every registered key signed the registration itself, proving its holder had the key and passphrase.'
            : `The registration is not fully proven: ${ps.missing.length} key${ps.missing.length === 1 ? ' has' : 's have'} not signed it. Do not rely on it.`,
        });
        if (!ps.complete) r.verdict = 'bad';
      }
      if (r.verdict !== 'incomplete' && r.documentId && r.signedText) {
        lastCheck = {
          result: r.verdict === 'good' ? 'good' : 'bad',
          checks: r.checks.map((c) => `${c.state === 'pass' ? 'Pass' : c.state === 'fail' ? 'Fail' : 'Not checked'}: ${c.label}`),
          owners: (r.signers ?? []).map((x) => ({
            userID: `${x.label && x.label !== x.userID ? `${x.label}: ` : ''}${x.userID || (x.registered ? '' : 'NOT REGISTERED')}`,
            fingerprint: x.fingerprint,
            result: x.state === 'pass' ? 'Valid signature' : x.detail,
            signedAt: x.signedAt,
          })),
          files: [...scannedFiles],
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
      // A binary file signature (PGPSIG1): it needs the signed file itself.
      const code = payload.split(/\s+/).find((x) => x.startsWith('PGPSIG1|'));
      if (!code) throw new UserError('Those are not signature codes from this program. Scan the codes on the signature page (they start with PGPQ1|).');
      const file = input('bin-v-file').files?.[0];
      if (!file) {
        $('bin-check').setAttribute('open', '');
        throw new UserError('That is a binary file signature. Choose the signed file under "Check a binary-signed file", then check again.');
      }
      await checkBinary(file, await binarySignatureFrom(code));
      return;
    }
    showResult(r);
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
