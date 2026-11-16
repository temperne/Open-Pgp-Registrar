import { PRISTINE_HTML } from './pristine';
/** A signing-room invitation in the link (#room=...), kept before tab changes rewrite the "#". */
const INVITED_ROOM = (() => {
  try {
    return /^#room=([A-Za-z0-9_-]{20,})$/.exec(location.hash)?.[1] ?? '';
  } catch {
    return '';
  }
})();
import './style.css';
import type * as openpgp from 'openpgp';
import {
  LONG_TEXT,
  estimateCodes,
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
  transferClause,
  describeKey,
  sha256Hex,
  keyIdentity,
  identityFromUserID,
  signRegistration,
  checkRegistrationProof,
  signHolderUpdate,
  checkHolderUpdate,
  registrationStatement,
  toBase64,
  fromBase64,
  type Registration,
  type RegistrationRole,
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
  releaseStatementPdf,
  pdfAttachments as releaseAttachments,
  RELEASE_KEY_ATTACHMENT,
  type ReleaseStatementInfo,
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
  draftRegistration,
  registrationFromDraft,
  draftFromPdf,
  splitParcels,
  type DocumentDraft,
  type SignaturePageInfo,
  checkedCopyPdf,
  combinedFilingPdf,
  type CheckedFile,
} from './pdf';
import { BRAND, BRAND_DEFAULTS, MASTER_URL, MASTER_ANALYTICS_TOKEN, applyJurisdiction, type Jurisdiction } from './brand';
import { SigningRoom, officialOrigin, officialOrigins, roomsAvailableHere, type Peer, type RoomMessage } from './room';
import { STATES, countiesOf, stateCode, recordingOffice } from './counties';
import { bakedConfig, cleanConfig, countyHtml, countyPackage, slug } from './deploy';
import { STATE_SEALS } from './seals';
import { bestQr } from './codes';
import { TEMPLATES, DISCLAIMER, type TemplateFields } from './templates';
import { canonicalText, safeText } from './text';
import { extractFile, extractImages, fileSignedText, parcelFilingStatement, needsDescription, looksImage, toPrintableImage, SUPPORTED_ALL, type ExtractedFile } from './extract';

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
    source?: { kind: ExtractedFile['kind']; name: string; pages: string[]; pageCount: number; sha256: string[]; description?: string; parcelStatement?: string };
    /** Sale deeds: the buyers' proof that they hold the keys named (each signs the new registration). */
    buyerProof?: SignedText;
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
    role?: RegistrationRole;
    interest?: string;
  } | null;
}
/** Signature lines typed by hand (documents without a registration), instead of from the keys. */
let signersTyped = false;
/** Sale deeds: the buyers' keys, named in the deed so protection passes to them when it is recorded. */
let buyerKeys: openpgp.PublicKey[] = [];

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

function currentTab(): Tab {
  return TABS.find((t) => !$(`panel-${t}`).hidden) ?? 'about';
}

function showTab(name: Tab, focus = false) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  // Sign together works on the Register and Sign tabs: the room card goes with the tab.
  document.querySelector(`[data-room-slot="${name}"]`)?.append($('room-card'));
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
  showRoomConsent();
  if (state.draft) renderDraft();
  if (room?.ws) {
    renderPeers();
    void roomShare();
  }
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
  if (room) showRoomKeys();
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

/** Keys proven in the signing room that this registration doesn't list yet (before anyone signs). */
function roomKeysMissing(): openpgp.PublicKey[] {
  if (!room?.ws || !state.key || state.regDraft) return [];
  const listed = new Set(regKeysFromForm().map((k) => k.getFingerprint().toUpperCase()));
  return [...peers.values()].filter((p) => p.proven && !listed.has(p.fingerprint)).map((p) => p.key);
}

function showRoomKeys() {
  const missing = roomKeysMissing();
  const btn = $('co-room');
  btn.hidden = !missing.length;
  btn.textContent = `Add ${missing.length === 1 ? 'the key' : `the ${missing.length} keys`} of the signing room: ${missing.map((k) => describeKey(k)).join('; ')}`;
}

function addRoomKeys(keys: openpgp.PublicKey[]) {
  state.coOwners.push(...keys);
  renderCoOwners();
  showRoomKeys();
  $('co-status').className = 'hint ok';
  $('co-status').textContent = `Added from the signing room (each proven by their key): ${keys.map((k) => describeKey(k)).join('; ')}. Each of them must sign.`;
}

function regRole(): RegistrationRole {
  return input('reg-role').value === 'lienholder' ? 'lienholder' : 'owner';
}

/** Lien holders name the lien; the labels follow the role. */
function syncRegRole() {
  const lien = regRole() === 'lienholder';
  $('reg-interest-wrap').hidden = !lien;
  $('reg-owner-label').textContent = lien ? 'Lien holder' : 'Owner(s) of record';
}
input('reg-role').addEventListener('change', syncRegRole);

function lockRegistration() {
  const d = state.regDraft;
  input('reg-role').disabled = !!d;
  input('reg-interest').disabled = !!d;
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
  // A tab whose key isn't on this registration (for example, from a signing room): say so plainly.
  const mine = state.key?.getFingerprint().toUpperCase();
  if (mine && !d.keys.some((k) => k.getFingerprint().toUpperCase() === mine)) {
    $('reg-next-hint').textContent =
      `Your key (${describeKey(state.key!)}) is not on this registration, so it doesn't need or take your signature. ` +
      'If you are an owner, the person who started it must choose "Start over", add your key (in a signing room: "Add the keys of everyone in the signing room") and sign again.';
  }
}

action('co-room', () => addRoomKeys(roomKeysMissing()));

action(
  'reg-btn',
  async () => {
    if (!state.key) return;
    if (!state.signer) {
      throw new UserError('Unlock your private key in step 1 first. Signing the registration proves you hold the key and its passphrase.');
    }
    const role = regRole();
    need(input('reg-owner').value, role === 'lienholder' ? 'Enter the lien holder.' : 'Enter the owner(s) of record.');
    if (!state.regDraft) {
      // People in the signing room aren't on the key list: being in the room doesn't make them owners, so ask.
      const fromRoom = roomKeysMissing();
      if (
        fromRoom.length &&
        confirm(
          `${fromRoom.map((k) => describeKey(k)).join('; ')} ${fromRoom.length === 1 ? 'is' : 'are'} in the signing room but not on this registration. Add ${fromRoom.length === 1 ? 'that key' : 'their keys'}, so ${fromRoom.length === 1 ? 'they' : 'each of them'} must sign it too?\n\nOK: add and sign. Cancel: sign without them.`,
        )
      ) {
        addRoomKeys(fromRoom);
      }
      const parcels = splitParcels(need(textarea('reg-parcels').value, 'Enter the parcel number.'));
      const interest = role === 'lienholder' ? need(input('reg-interest').value, 'Describe the lien (its type and recording number).').trim() : undefined;
      state.regDraft = { keys: regKeysFromForm(), parcels, proofs: {}, role, interest };
    }
    const d = state.regDraft;
    if (!d.keys.some((k) => k.getFingerprint().toUpperCase() === state.signer!.getFingerprint().toUpperCase())) {
      throw new UserError('Your key is not on this registration. Load one of its listed keys, or choose "Start over" above to begin a new registration.');
    }
    for (const parcel of d.parcels) {
      d.proofs[parcel] = await signRegistration(state.signer, { parcel, keys: d.keys, proof: d.proofs[parcel], role: d.role, interest: d.interest });
    }
    lockRegistration();
    renderRegDraft();
    void roomShare();
    $('reg-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

action(
  'dl-reg',
  async () => {
    const d = state.regDraft;
    const draft = regDraftForPdf();
    if (!d || !draft) return;
    const first = d.keys[0];
    const s = summarize(first);
    const pdf = await registrationPdf({
      ownerName: draft.ownerName,
      parcels: draft.parcels,
      coOwnerKeys: d.keys.slice(1),
      proofs: d.proofs,
      draft,
      role: d.role,
      interest: d.interest,
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

/** The registration in progress, as the PDF embeds it (and a signing room shares it). */
function regDraftForPdf(): RegistrationDraft | null {
  const d = state.regDraft;
  if (!d) return null;
  const sigsOf = (p?: SignedText) =>
    (p?.signatures ?? []).map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) }));
  return {
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
    role: d.role,
    interest: d.interest,
  };
}

/** Takes up a registration in progress (from its PDF, or from another tab in a signing room). */
async function loadRegDraft(draft: RegistrationDraft) {
  const keys = await Promise.all(draft.keys.map(async (a) => (await readAnyKey(a)).toPublic()));
  const parcels = splitParcels(draft.parcels);
  const proofs: Record<string, SignedText> = {};
  const role = draft.role === 'lienholder' ? 'lienholder' : undefined;
  for (const p of parcels) {
    const proof = await proofFromSigs({ parcel: p, keys, role, interest: draft.interest }, draft.proofs[p] ?? []);
    if (proof) proofs[p] = proof;
  }
  state.regDraft = { keys, parcels, proofs, role, interest: draft.interest };
  input('reg-role').value = role ?? 'owner';
  input('reg-interest').value = draft.interest ?? '';
  syncRegRole();
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
  return keys;
}

/** A registration from another tab in the room: take it up, or add its key holders' signatures to ours. */
async function applyRoomReg(remote: RegistrationDraft) {
  const status = $('room-status');
  const d = state.regDraft;
  if (!d) {
    await loadRegDraft(remote);
    const mine = state.key?.getFingerprint().toUpperCase();
    const listed = !mine || state.regDraft!.keys.some((k) => k.getFingerprint().toUpperCase() === mine);
    status.textContent = listed
      ? `A registration from the room is open on the Register tab: signed by ${state.regDraft!.keys.length - regMissing().length} of ${state.regDraft!.keys.length} keys.`
      : 'A registration from the room is open on the Register tab, but it doesn\u2019t list your key, so you can\u2019t sign it. The person who started it must choose "Start over" and add your key.';
    return;
  }
  const keys = await Promise.all(remote.keys.map(async (a) => (await readAnyKey(a)).toPublic()));
  const parcels = splitParcels(remote.parcels);
  const role = remote.role === 'lienholder' ? 'lienholder' : undefined;
  const lien = (r?: string) => r === 'lienholder';
  if (!sameKeys(keys, d.keys) || parcels.join('|') !== d.parcels.join('|') || lien(role) !== lien(d.role) || (remote.interest ?? '') !== (d.interest ?? '')) {
    status.textContent = 'Another tab in the room has a different registration open (other parcels or keys). Everyone must sign the same one: start over, or leave the room.';
    return;
  }
  let changed = false;
  for (const p of d.parcels) {
    const theirs = await proofFromSigs({ parcel: p, keys: d.keys, role: d.role, interest: d.interest }, remote.proofs[p] ?? []);
    const merged = await mergeSigned(d.proofs[p], theirs);
    if (merged && merged !== d.proofs[p]) {
      d.proofs[p] = merged;
      changed = true;
    }
  }
  if (changed) {
    lockRegistration();
    renderRegDraft();
  }
  const ours = d.parcels.reduce((n, p) => n + (d.proofs[p]?.signatures.length ?? 0), 0);
  const theirs = d.parcels.reduce((n, p) => n + (remote.proofs[p]?.length ?? 0), 0);
  if (ours > theirs) void roomShare();
}

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
    const keys = await loadRegDraft(draft);
    void roomShare();
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
          // A registration by sale: the deed's own codes are its proof.
          for (const r of regs) if (r.transfer && r.transfer.documentId === proof.documentId) r.transfer.deed = proof;
        } catch {
          /* incomplete proof codes: reported as not proven */
        }
      }
      return regs;
    }
    if (codes.some((c) => c.startsWith('PGPQ1|')) && !codes.some((c) => /^(PGPK1|PGPKEY1)\|/.test(c) || /BEGIN PGP/.test(c))) {
      throw new Error(
        'That is a signed document or a certificate, not a registration: it has signature codes but no registered keys. Load the registration form, or the recorded sale deed (or its filing) that names the current owners\u2019 keys.',
      );
    }
    return [{ parcel: '', keys: [(await keyFromCodes(codes)).toPublic()] }];
  }
  return [{ parcel: '', keys: [(await readAnyKey(bytes)).toPublic()] }];
}

function describeRegistration(r: Registration) {
  const frag = document.createDocumentFragment();
  frag.append(r.parcel ? `Parcel ${r.parcel}: ` : 'Key(s) without a parcel number: ', `${r.keys.length} key${r.keys.length === 1 ? '' : 's'}, all must sign.`);
  if (r.role === 'lienholder') frag.append(` Lien holder registration${r.interest ? ` (${r.interest})` : ''}: for releases, satisfactions and assignments of that lien.`);
  if (r.transfer) frag.append(` Registered by sale: the deed with document ID ${r.transfer.documentId} names these keys as the new owners' keys.`);
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
  f.buyerKeys = currentTemplate().buyerKeys ? transferClause(buyerKeys) : '';
  return f;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]) {
  const list = names.map((n) => n.trim()).filter(Boolean);
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The grantee, from the buyers' keys: a person's name, every member of a group,
 * or the business or trust itself for a position key (the entity takes title,
 * not its officer). Typed wording is kept: the field only follows the keys while
 * it still holds what was filled in from them.
 */
let granteeFromKeys = '';
function fillGrantee() {
  const el = fieldEl('grantee');
  if (el.value.trim() && el.value !== granteeFromKeys) return;
  const names = buyerKeys.flatMap((k) => {
    const id = keyIdentity(k);
    return id.kind === 'group' && id.members?.length ? id.members : [id.name];
  });
  granteeFromKeys = joinNames(names);
  el.value = granteeFromKeys;
}

/** Two key lists with the same keys, in any order. */
function sameKeys(a: openpgp.PublicKey[], b: openpgp.PublicKey[]) {
  const f = (l: openpgp.PublicKey[]) => l.map((k) => k.getFingerprint().toUpperCase()).sort().join(',');
  return a.length === b.length && f(a) === f(b);
}

/** The buyers' keys card: shown for sale deeds before anyone has signed. */
function renderBuyerKeys() {
  const show = !!currentTemplate().buyerKeys && !state.draft && !state.source;
  $('buyer-keys').hidden = !show && !(state.draft && buyerKeys.length);
  const list = $('buyer-list');
  list.innerHTML = '';
  for (const k of buyerKeys) {
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Remove' });
    remove.disabled = !!state.draft;
    remove.addEventListener('click', () => {
      buyerKeys = buyerKeys.filter((x) => x !== k);
      fillGrantee();
      renderBuyerKeys();
      syncTemplate();
    });
    list.append(keyItem(k, state.draft ? undefined : remove));
  }
  input('buyer-file').disabled = !!state.draft || !state.signReg;
  $('buyer-status').className = 'hint';
  if (!state.signReg && !state.draft) $('buyer-status').textContent = 'Load the parcel registration (above) first: the sellers’ registered keys hand the protection over.';
  else if ($('buyer-status').textContent?.startsWith('Load the parcel')) $('buyer-status').textContent = '';
}

input('buyer-file').addEventListener('change', async () => {
  const f = input('buyer-file').files?.[0];
  if (!f) return;
  const status = $('buyer-status');
  status.className = 'hint';
  try {
    const key = (await keyFromFile(f, (m) => (status.textContent = m))).toPublic();
    const fpr = key.getFingerprint().toUpperCase();
    if (buyerKeys.some((k) => k.getFingerprint().toUpperCase() === fpr)) throw new Error('That key is already listed.');
    if (state.signReg?.keys.some((k) => k.getFingerprint().toUpperCase() === fpr)) throw new Error('That key is already registered for this parcel (a seller’s key).');
    buyerKeys.push(key);
    fillGrantee();
    renderBuyerKeys();
    syncTemplate();
    status.textContent = `Added ${describeKey(key)}. Check the fingerprint with the buyer.`;
  } catch (err) {
    status.className = 'hint error';
    status.textContent = (err as Error).message;
  } finally {
    input('buyer-file').value = '';
  }
});

/** The signed content is the title and the text together. */
function fullText(title: string, text: string) {
  return title.trim() ? `${title.trim()}\n\n${text}` : text;
}

function updateCount() {
  const n = canonicalText(fullText(input('doc-title').value, textarea('doc-text').value)).length;
  $('doc-count').textContent = n ? `${n.toLocaleString()} characters signed.` : '';
  // Long documents: a warning, not a limit. Once someone has signed, the text is settled.
  const long = n > LONG_TEXT && !state.draft;
  $('long-warn').hidden = !long;
  if (!long) input('long-ok').checked = false;
  else {
    const lead = `This is a long document: ${n.toLocaleString()} characters. Its signature carries the whole text`;
    const tail = 'on every copy that is filed or checked. That works, but consider whether all of it needs to be signed this way.';
    if ($('long-warn-text').dataset.chars !== String(n)) $('long-warn-text').textContent = `${lead}, so it will need many QR codes ${tail}`;
    const token = ++countToken;
    const canonical = canonicalText(fullText(input('doc-title').value, textarea('doc-text').value));
    void estimateCodes(canonical, Math.max(1, state.signReg?.keys.length ?? 1)).then((codes) => {
      if (token !== countToken) return;
      $('long-warn-text').dataset.chars = String(n);
      $('long-warn-text').textContent = `${lead}, so it will need about ${codes} QR codes (about ${Math.ceil(codes / 9)} extra printed pages) ${tail}`;
    });
  }
}
let countToken = 0;

/** Rebuilds the document text from the template, unless the user has edited it. */
function syncTemplate(force = false) {
  renderBuyerKeys();
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
/** The parcel filing statement, when "Ready this document for parcel filing" is ticked. */
function parcelStatement() {
  const parcel = state.signReg?.parcel;
  return parcel && input('parcel-ready').checked ? parcelFilingStatement(parcel, BRAND.county, BRAND.state) : '';
}

function showParcelReady() {
  const parcel = state.signReg?.parcel;
  $('parcel-ready-wrap').hidden = !parcel || !!state.draft;
  if (!parcel) input('parcel-ready').checked = false;
  $('parcel-ready-hint').textContent = parcel
    ? `For a document that does not list the parcel number: adds a signed statement, printed on its first page, that the signers sign it explicitly for use with parcel ${parcel}. The Recorder's check then matches it to the parcel. Without it, a document that doesn't name the parcel is for third parties only.`
    : '';
}
input('parcel-ready').addEventListener('change', () => updateCount());

function lockDraft() {
  showParcelReady();
  renderBuyerKeys();
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

/** The registration a sale deed hands over: the parcel with the buyers' keys. */
function buyerRegistration(): Registration | null {
  return state.signReg?.parcel && buyerKeys.length ? { parcel: state.signReg.parcel, keys: buyerKeys } : null;
}

/** Buyers' keys that haven't proven possession yet (signed the new registration). */
function missingBuyers() {
  if (!state.draft || !buyerRegistration()) return [];
  const proved = new Set((state.draft.buyerProof?.signatures ?? []).map((x) => x.fingerprint.toUpperCase()));
  return buyerKeys.filter((k) => !proved.has(k.getFingerprint().toUpperCase()));
}

function missingSigners() {
  const d = state.draft;
  if (!d || !state.signReg) return [];
  const signed = new Set(d.signed.signatures.map((x) => x.fingerprint));
  return state.signReg.keys.filter((k) => !signed.has(k.getFingerprint().toUpperCase()));
}

function renderDraft() {
  showAutoSigners();
  renderBuyerKeys();
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
  // Sale deeds: each buyer proves they hold the key being handed to them.
  const buyersMissing = missingBuyers();
  for (const k of buyerRegistration() ? buyerKeys : []) {
    const done = !buyersMissing.includes(k);
    const li = document.createElement('li');
    li.className = done ? 'signed' : 'waiting';
    li.append(
      Object.assign(document.createElement('strong'), { textContent: `${done ? 'Buyer key proven' : 'Buyer still to prove their key'}: ${describeKey(k)}` }),
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
  } else if (buyersMissing.length) {
    status.textContent = `Signed by every owner; ${buyerKeys.length - buyersMissing.length} of ${buyerKeys.length} buyer keys proven`;
    status.className = 'pill warn';
  } else {
    status.textContent = buyerRegistration() ? 'Complete: every owner signed and every buyer key proven' : 'Complete: every registered key signed';
    status.className = 'pill good';
  }
  const meBuyer = !!state.signer && buyersMissing.some((k) => k.getFingerprint() === state.signer!.getFingerprint());
  $('text-sign-btn').textContent = meBuyer ? 'Prove my buyer key' : state.draft ? 'Add my signature' : 'Sign';
  $('tr-id').textContent = d.signed.documentId;
  $('tr-codes').textContent = `${d.signed.codes.length} QR code${d.signed.codes.length === 1 ? '' : 's'} on the signature page at the end`;
  const waiting = missing.length + buyersMissing.length;
  $('dl-instrument').textContent = missing.length ? 'Download for the next owner (PDF)' : buyersMissing.length ? 'Download for the buyers (PDF)' : 'Download signed document (PDF)';
  $('next-signer').hidden = waiting === 0 && !!state.signReg;
  $('next-signer').textContent = missing.length ? 'Next owner signs on this computer' : 'Next buyer proves their key on this computer';
  $('tr-step1').textContent = missing.length
    ? 'Not complete yet. Give the PDF to the next owner (they choose "Sign exactly as others" and load it), or let them sign on this computer.'
    : buyersMissing.length
      ? 'Every owner signed. Now each buyer proves they hold their key: they load this PDF with "Sign exactly as others", unlock their key and choose "Prove my buyer key" (or do it on this computer). Until then the deed does not hand over the registration.'
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
  showParcelReady();
  renderBuyerKeys();
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
    // The registered owners can't also be the buyers.
    if (!state.draft && state.signReg) buyerKeys = buyerKeys.filter((b) => !state.signReg!.keys.some((k) => k.getFingerprint() === b.getFingerprint()));
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
    const regs = await registrationsFromFile(f, (m) => (info.textContent = m));
    const d = state.draft;
    if (d && state.signReg && !regs.some((r) => sameKeys(r.keys, state.signReg!.keys))) {
      // A document signed for the previous registration is open: don't mix the two.
      const n = d.signed.signatures.length;
      if (!confirm(`A document signed by ${n} owner${n === 1 ? '' : 's'} for the previous registration is open. Download it first if you need it. Clear it and start a new document for this registration?`)) {
        info.className = 'hint error';
        info.textContent = 'Kept the open document and its registration. Download it, then load the new registration again.';
        return;
      }
      state.draft = null;
      $('text-result').hidden = true;
      clearSource();
      buyerKeys = [];
      lockDraft();
    }
    useSignRegistration(regs);
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
    let switched = false;
    if (embedded) {
      const sigs: DocSignature[] = embedded.signatures.map((x) => ({
        fingerprint: x.fingerprint,
        userID: x.userID,
        signedAt: new Date(x.signedAt),
        bytes: fromBase64(x.sig),
      }));
      const signed = await assembleSigned(canonicalText(fullText(embedded.title, embedded.text)), sigs);
      // The registration the document was started for: its owners are the ones who must sign.
      const embReg: Registration | null = embedded.registration ? await registrationFromDraft(embedded.registration) : null;
      const signedBy = new Set(embedded.signatures.map((x) => x.fingerprint.toUpperCase()));
      const embBuyers = await Promise.all((embedded.buyerKeys ?? []).map(async (a) => (await readAnyKey(a)).toPublic()));
      const proved = new Set((embedded.buyerProof ?? []).map((x) => x.fingerprint.toUpperCase()));
      const buyersDone = embBuyers.every((k) => proved.has(k.getFingerprint().toUpperCase()));
      if (embReg && buyersDone && embReg.keys.every((k) => signedBy.has(k.getFingerprint().toUpperCase()))) {
        // Already signed by every owner: nothing to add. A sale deed is the new owners' registration.
        const sale = (await registrationsFromPdf(bytes)).find((r) => r.transfer);
        if (sale) {
          useSignRegistration([sale]);
          status.className = 'hint ok';
          status.textContent =
            'That deed is already signed by every owner, so there is nothing to add to it. It names the buyers\u2019 keys, so it is now loaded as the parcel registration (above): write the new owners\u2019 document below.';
        } else {
          status.className = 'hint ok';
          status.textContent = 'That document is already signed by every registered owner, so there is nothing to add to it. To sign a new document, write it below.';
        }
        return;
      }
      if (embReg && !sameKeys(embReg.keys, state.signReg?.keys ?? [])) {
        switched = !!state.signReg;
        useSignRegistration([embReg]);
      }
      if (embedded.source) {
        const files = await sourceFromPdf(bytes);
        state.source = { ...embedded.source, pdf: files.pdf, images: files.images.length ? files.images : undefined };
        showSource();
      }
      buyerKeys = embBuyers;
      const buyerProof =
        embReg?.parcel && embedded.buyerProof?.length ? await proofFromSigs({ parcel: embReg.parcel, keys: embBuyers }, embedded.buyerProof) : undefined;
      setDraft({
        buyerProof,
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
    void roomShare();
    const n = state.draft!.signed.signatures.length;
    status.className = 'hint ok';
    status.textContent =
      `Loaded a document signed by ${n} owner${n === 1 ? '' : 's'}. Unlock your key and choose "Add my signature" (a buyer: "Prove my buyer key").` +
      (switched ? ' It was started for a different registration than the one loaded, so its own registration is loaded now (above).' : '');
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
    // A buyer proving they hold a key named in the sale deed: sign the new registration's statement.
    const buyerReg = buyerRegistration();
    if (state.draft && buyerReg && buyerKeys.some((k) => k.getFingerprint().toUpperCase() === me)) {
      const d = state.draft;
      if (d.buyerProof?.signatures.some((x) => x.fingerprint.toUpperCase() === me)) throw new UserError('This buyer key has already proven possession.');
      const buyerProof = await signRegistration(state.signer, { ...buyerReg, proof: d.buyerProof });
      setDraft({ ...d, buyerProof, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
      void roomShare();
      $('text-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (state.signReg && !state.signReg.keys.some((k) => k.getFingerprint().toUpperCase() === me)) {
      throw new UserError(
        `Your key is not registered for ${state.signReg.parcel ? `parcel ${state.signReg.parcel}` : 'this parcel'}. Load one of the keys listed on the registration.`,
      );
    }
    if (!state.draft && !$('long-warn').hidden && !input('long-ok').checked) {
      throw new UserError('This document is long and will need many pages of codes. Tick "Sign it anyway" to go ahead.');
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
      const statement = parcelStatement();
      const full = fileSignedText(src, description, statement);
      const signed = await signText(state.signer, full);
      setDraft({
        signed,
        title: '',
        text: full,
        returnTo: '',
        signers: textarea('doc-signers').value,
        recordable: false,
        source: { kind: src.kind, name: src.name, pages: src.pages, pageCount: src.pageCount, sha256: src.sha256, description: needsDescription(src) ? description : undefined, parcelStatement: statement || undefined },
      });
    } else {
      const statement = parcelStatement();
      let body = textarea('doc-text').value;
      // Sale deeds: the buyers' keys must be in the signed text, even if the text was edited by hand.
      if (buyerKeys.length && currentTemplate().buyerKeys) {
        const flat = canonicalText(body).replace(/\s+/g, '');
        if (!buyerKeys.every((k) => flat.includes(k.getFingerprint().toUpperCase()))) body = `${body.trimEnd()}\n\n${transferClause(buyerKeys)}`;
      }
      const text = statement ? `${statement}\n\n${body}` : body;
      const title = input('doc-title').value.trim();
      if (!canonicalText(text)) throw new UserError('Write the document text first.');
      const placeholder = fullText(title, text).match(/\[[A-Z][A-Z ]+\]/);
      if (placeholder) throw new UserError(`Fill in ${placeholder[0]} before signing.`);
      // A recordable document (a deed) must name the parcel; anything else may be signed for third parties.
      if (currentTemplate().recordable && state.signReg?.parcel && !parcelKey(fullText(title, text)).includes(parcelKey(state.signReg.parcel))) {
        throw new UserError(
          `A document for recording must name the registered parcel number, ${state.signReg.parcel}, or the Recorder's check will fail. Add it to the text, or tick "Ready this document for parcel filing".`,
        );
      }
      const signed = await signText(state.signer, fullText(title, text));
      setDraft({ signed, title, text, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value, recordable: currentTemplate().recordable });
    }
    void roomShare();
    $('text-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'Signing...',
);

// ---------------------------------------------------------------------------
// Signing rooms (src/room.ts): sign together, live, through the encrypted relay
// ---------------------------------------------------------------------------
let room: SigningRoom | null = null;
const peers = new Map<string, Peer>();

function renderPeers() {
  showRoomKeys();
  const ul = $('room-peers');
  ul.innerHTML = '';
  const me = state.signer ?? state.key;
  if (room?.ws && me) {
    ul.append(
      Object.assign(document.createElement('li'), {
        textContent: `You: ${describeKey(me)} (${formatFingerprint(me.getFingerprint().toUpperCase()).slice(-24)})${state.signer ? '' : ', unlock your key to sign'}`,
      }),
    );
  }
  for (const p of peers.values()) {
    const li = document.createElement('li');
    li.append(
      Object.assign(document.createElement('strong'), { textContent: identityFromUserID(p.userID).name || p.userID || '(no name)' }),
      ` ${formatFingerprint(p.fingerprint).slice(-24)} `,
      Object.assign(document.createElement('span'), {
        className: p.proven ? 'proven' : 'error',
        textContent: p.proven ? 'proven by their key' : 'NOT proven: could not show they hold this key',
      }),
    );
    ul.append(li);
  }
}

function roomStatus(status: 'connecting' | 'connected' | 'closed', tabs: number, detail?: string) {
  const el = $('room-status');
  const connected = status === 'connected';
  el.className = connected ? 'hint ok' : status === 'closed' && detail ? 'hint error' : 'hint';
  el.textContent =
    status === 'connecting'
      ? 'Connecting to the signing room...'
      : connected
        ? `Connected (encrypted${room?.via ? ', through the backup relay' : ''}). ${tabs} tab${tabs === 1 ? '' : 's'} in the room, yours included.`
        : (detail ?? (room ? 'Disconnected from the signing room.' : ''));
  // Can't reach this copy's relay: fall back to the program's master site, same room
  // (the room's key is in the link, so everyone who follows it meets there).
  if (status === 'closed' && detail && room && officialOrigin() !== MASTER_URL) {
    el.append(
      ' Continue this room on the main site: ',
      Object.assign(document.createElement('a'), { href: settingsLinkFor(MASTER_URL, `#room=${room.secret}`), textContent: `${MASTER_URL.replace(/^https:\/\//, '')} (same room)`, target: '_blank', rel: 'noopener' }),
      '. Send that link to the others too.',
    );
  }
  $('room-leave').hidden = !room || status === 'closed';
  $('room-start').hidden = !!room && status !== 'closed';
  $('room-share').hidden = !room || status === 'closed';
  if (status === 'closed') {
    peers.clear();
    roomHost = null;
  }
  renderPeers();
  showRoomConsent();
  showRoomSettings();
}

/** Sends who we are (proven by our key) and the document so far. */
async function roomShare(force = '') {
  if (!room?.ws) return;
  if (state.signer) await room.hello(state.signer);
  if (room.host && state.signer) await room.shareSettings(state.signer, roomSettings());
  const reg = regDraftForPdf();
  if (reg) await room.send({ t: 'reg', reg });
  const d = draftForPdf();
  if (!d) return;
  if (d.source) {
    // A signed file: the others need the original to recreate the same package. It goes through
    // the room once per file (by its SHA-256); after that only signatures travel. Someone who
    // joins later asks for it ("need-file").
    const hash = fileHashOf(d.source);
    const size = roomFileSize();
    const tooLarge = size > ROOM_FILE_LIMIT;
    // The file itself follows in parts: when it's new to the room, or someone asked for it.
    const sendNow = size > 0 && !tooLarge && (force === hash || roomFileSent !== hash);
    await room.send({ t: 'state', draft: { ...d, fileHash: hash, fileSize: size, fileTooLarge: tooLarge, fileComing: sendNow } });
    if (sendNow) {
      roomFileSent = hash;
      await sendFileParts(hash);
    }
    if (tooLarge) {
      $('room-status').textContent = `This file is over ${ROOM_FILE_LIMIT / 1024 / 1024} MB, too large to pass through the room: send the others the PDF ("Sign exactly as others"). Signatures still go through the room.`;
    }
    return;
  }
  await room.send({ t: 'state', draft: d });
}

/** The SHA-256 of the file(s) being signed: the file goes through the room again only if this changes. */
const fileHashOf = (src: { sha256: string[] }) => src.sha256.join(',');
/** The file this tab last sent or received through the room (by hash). */
let roomFileSent = '';
/** A reply to someone asking for the file, waiting a moment in case another tab answers first. */
let fileReply: ReturnType<typeof setTimeout> | null = null;
/** When this tab last sent the file to someone who asked (it doesn't answer twice in a row). */
let fileAnswered = 0;
/** The file this tab asked the room for, and when (it asks once, again only if nothing comes). */
let fileAsked = { hash: '', at: 0 };

function roomFileSize() {
  const src = state.source;
  return (src?.pdf?.length ?? 0) + (src?.images ?? []).reduce((n, i) => n + i.bytes.length, 0);
}
function roomFiles(): RoomFiles {
  const src = state.source;
  if (!src || roomFileSize() > ROOM_FILE_LIMIT) return null;
  return { pdf: src.pdf ? toBase64(src.pdf) : undefined, images: src.images?.map((i) => ({ name: i.name, format: i.format, b64: toBase64(i.bytes) })) };
}

/** Sends the file being signed to the room, in parts small enough for either relay. */
async function sendFileParts(hash: string) {
  const data = JSON.stringify(roomFiles());
  const n = Math.max(1, Math.ceil(data.length / ROOM_FILE_PART));
  for (let i = 0; i < n; i++) {
    if (!room?.ws) return;
    await room.send({ t: 'file-part', hash, i, n, data: data.slice(i * ROOM_FILE_PART, (i + 1) * ROOM_FILE_PART) });
    if (n > 1) $('room-status').textContent = `Sending the file to the room: part ${i + 1} of ${n}.`;
  }
  if (n > 1) $('room-status').textContent = `Sent the file to the room (${n} parts).`;
}

/** Files arriving in parts, by hash. */
const incoming = new Map<string, { parts: string[]; got: number; n: number }>();
/** Files received whole and checked against their SHA-256, by hash. */
const received = new Map<string, { pdf?: Uint8Array; images?: { name: string; format: 'png' | 'jpg'; bytes: Uint8Array }[] }>();
/** A document from the room waiting for its file. */
let pendingRemote: (DocumentDraft & RoomDraftExtras) | null = null;
type RoomDraftExtras = { fileHash?: string; fileSize?: number; fileTooLarge?: boolean; fileComing?: boolean };

async function receiveFilePart(m: Extract<RoomMessage, { t: 'file-part' }>) {
  if (received.has(m.hash) || (state.source && fileHashOf(state.source) === m.hash)) return;
  if (!(m.n >= 1 && m.n <= Math.ceil((ROOM_FILE_LIMIT * 1.4) / ROOM_FILE_PART) + 1 && m.i >= 0 && m.i < m.n && m.data.length <= ROOM_FILE_PART)) return;
  // Someone is sending it: nobody else needs to answer a request for it.
  if (fileReply) clearTimeout(fileReply);
  fileReply = null;
  fileAnswered = Date.now();
  const f = incoming.get(m.hash) ?? { parts: [], got: 0, n: m.n };
  incoming.set(m.hash, f);
  if (f.parts[m.i] === undefined) {
    f.parts[m.i] = m.data;
    f.got++;
  }
  if (f.n > 1) $('room-status').textContent = `Receiving the file: part ${f.got} of ${f.n}.`;
  if (f.got < f.n) return;
  incoming.delete(m.hash);
  const files = JSON.parse(f.parts.join('')) as RoomFiles;
  const pdf = files?.pdf ? fromBase64(files.pdf) : undefined;
  const images = files?.images?.map((i) => ({ name: i.name, format: i.format, bytes: fromBase64(i.b64) }));
  // The file must be exactly the one that was signed.
  const hashes = await Promise.all([...(pdf ? [pdf] : []), ...(images ?? []).map((i) => i.bytes)].map((b) => sha256Hex(b)));
  if (hashes.join(',').toUpperCase() !== m.hash.toUpperCase()) {
    $('room-status').textContent = 'A file from the room did not match its SHA-256 and was ignored.';
    return;
  }
  received.set(m.hash, { pdf, images });
  roomFileSent = m.hash;
  if (pendingRemote && (pendingRemote.fileHash ?? fileHashOf(pendingRemote.source!)) === m.hash) {
    const r = pendingRemote;
    pendingRemote = null;
    await applyRoomDraft(r);
  }
}

/** This page's settings, as the room's host shares them (the same fields as a settings link). */
function roomSettings() {
  const b = BRAND as unknown as Record<string, string>;
  const j: Record<string, string> = {};
  for (const [, key] of LINK_KEYS) j[key] = String(b[key] ?? '');
  // The state seals are built in; an uploaded logo travels with the settings.
  return JSON.stringify({ j, logo: customLogo ? `data:${customLogo.type};base64,${toBase64(customLogo.bytes)}` : '' });
}

/** Whose settings this tab follows (the room's host), once they arrive. */
let roomHost: { fingerprint: string; name: string } | null = null;

async function applyRoomSettings(m: Extract<RoomMessage, { t: 'settings' }>, r: SigningRoom) {
  if (r.host) return; // the host sets them
  const fpr = await r.checkSettings(m);
  if (!fpr) return;
  // The first proven person to share settings is the host; nobody else can change them.
  const peer = peers.get(fpr);
  if (!peer?.proven) return;
  if (roomHost && roomHost.fingerprint !== fpr) return;
  roomHost = { fingerprint: fpr, name: identityFromUserID(peer.userID).name || peer.userID };
  const parsed = JSON.parse(m.settings) as { j?: Partial<Jurisdiction>; logo?: string };
  const j: Partial<Jurisdiction> = {};
  for (const [, key] of LINK_KEYS) {
    const v = parsed.j?.[key];
    if (typeof v === 'string' && v.trim()) j[key] = v;
  }
  const logo = parsed.logo ? sealFromDataUrl(parsed.logo) : null;
  const b = BRAND as unknown as Record<string, string>;
  const same = (Object.keys(j) as (keyof Jurisdiction)[]).every((k) => b[k] === j[k]) && !logo === !customLogo;
  if (!same) useJurisdiction(j, logo);
  showRoomSettings();
}

function showRoomSettings() {
  const note = $('room-settings-note');
  note.hidden = !room?.ws;
  if (!room?.ws) return;
  note.textContent = room.host
    ? `Everyone in this room uses your settings: ${BRAND.name}, ${BRAND.county}, ${BRAND.state} (deeds recorded with the ${BRAND.recorderOffice}).`
    : roomHost
      ? `Settings from ${roomHost.name}, who started this room: ${BRAND.name}, ${BRAND.county}, ${BRAND.state} (deeds recorded with the ${BRAND.recorderOffice}). They stay while you are in the room.`
      : 'Waiting for the settings of the person who started this room.';
}

/** The largest original file a room passes on. */
// Up to 50 MB, sent in parts that stay under 1 MB per message after encryption, so they pass
// either relay (the project's server, or Cloudflare). Larger files go by PDF.
const ROOM_FILE_LIMIT = 50 * 1024 * 1024;
const ROOM_FILE_PART = 512 * 1024;
type RoomFiles = { pdf?: string; images?: { name: string; format: 'png' | 'jpg'; b64: string }[] } | null;

/** The same signatures, merged: everyone's signatures over the same text. */
async function mergeSigned(a: SignedText | undefined, b: SignedText | undefined) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Map<string, DocSignature>();
  for (const x of [...a.signatures, ...b.signatures]) if (!seen.has(x.fingerprint.toUpperCase())) seen.set(x.fingerprint.toUpperCase(), x);
  return seen.size === a.signatures.length ? a : assembleSigned(a.canonical, [...seen.values()]);
}

/** A document from another tab in the room: adopt it, or add its signatures to ours. */
async function applyRoomDraft(remote: DocumentDraft & RoomDraftExtras) {
  const status = $('room-status');
  if (remote.source) {
    const hash = remote.fileHash ?? fileHashOf(remote.source);
    const have = !!state.source && fileHashOf(state.source) === hash;
    if (!state.draft && !have) {
      if (remote.fileTooLarge) {
        status.textContent = 'Another tab is signing a file too large to pass through the room. Ask them for the PDF and load it under "Sign exactly as others".';
        return;
      }
      // A text file is recreated from its text; a PDF or images need the file itself.
      const got = remote.fileSize === 0 ? {} : received.get(hash);
      if (!got) {
        pendingRemote = remote;
        // If the parts stop coming (the sender left), ask the room again.
        setTimeout(() => {
          if (pendingRemote === remote && !received.has(hash)) {
            fileAsked = { hash: '', at: 0 };
            incoming.delete(hash);
            roomQueue = roomQueue.then(() => applyRoomDraft({ ...remote, fileComing: false }));
          }
        }, 20_000);
        if (remote.fileComing || incoming.has(hash)) {
          status.textContent = 'Receiving the file from the room...';
        } else if (fileAsked.hash !== hash || Date.now() - fileAsked.at > 10_000) {
          // We joined after the file went round: ask for it once (again only if nothing comes).
          // Asked of the first signer (who loaded the file); the others answer only if they don't.
          status.textContent = 'Getting the file from the room...';
          fileAsked = { hash, at: Date.now() };
          await room?.send({ t: 'need-file', hash, to: remote.signatures[0]?.fingerprint?.toUpperCase() });
        }
        return;
      }
      state.source = { ...remote.source, pdf: got.pdf, images: got.images };
      showSource();
    }
    // The room has this file now: don't send it again unless it changes.
    roomFileSent = hash;
  }
  const canonical = canonicalText(fullText(remote.title, remote.text));
  const signed = await assembleSigned(
    canonical,
    remote.signatures.map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: new Date(x.signedAt), bytes: fromBase64(x.sig) })),
  );
  const reg = remote.registration ? await registrationFromDraft(remote.registration) : null;
  const remoteBuyers = await Promise.all((remote.buyerKeys ?? []).map(async (a) => (await readAnyKey(a)).toPublic()));
  const remoteProof = reg?.parcel && remote.buyerProof?.length ? await proofFromSigs({ parcel: reg.parcel, keys: remoteBuyers }, remote.buyerProof) : undefined;
  const d = state.draft;
  if (d) {
    if (d.signed.canonical !== canonical) {
      status.textContent = 'Another tab in the room has a different document open. Everyone must sign the same text: start over, or leave the room.';
      return;
    }
    const merged = await mergeSigned(d.signed, signed);
    const proof = await mergeSigned(d.buyerProof, remoteProof);
    if (merged !== d.signed || proof !== d.buyerProof) {
      setDraft({ ...d, signed: merged!, buyerProof: proof, returnTo: textarea('doc-return').value, signers: textarea('doc-signers').value });
    }
    // The sender is missing signatures we have (two signed at once): send ours back, so every tab ends with all of them.
    if (merged!.signatures.length > signed.signatures.length || (proof?.signatures.length ?? 0) > (remoteProof?.signatures.length ?? 0)) void roomShare();
    return;
  }
  if (reg && !sameKeys(reg.keys, state.signReg?.keys ?? [])) useSignRegistration([reg]);
  buyerKeys = remoteBuyers;
  setDraft({
    signed,
    buyerProof: remoteProof,
    title: remote.title,
    text: remote.text,
    returnTo: remote.returnTo,
    signers: remote.signers,
    recordable: remote.recordable !== false,
    source: remote.source,
  });
}

const roomEvents = {
  onStatus: roomStatus,
  onJoined: () => void roomShare(),
  // One message at a time: two signatures arriving together must both be merged, not race.
  onMessage: (m: RoomMessage, r: SigningRoom) => {
    roomQueue = roomQueue.then(() => handleRoomMessage(m, r));
  },
};
let roomQueue: Promise<void> = Promise.resolve();
async function handleRoomMessage(m: RoomMessage, r: SigningRoom) {
  {
    try {
      if (m.t === 'ask') await roomShare();
      else if (m.t === 'hello') {
        const p = await r.checkHello(m);
        peers.set(p.fingerprint, p);
        renderPeers();
      } else if (m.t === 'state') await applyRoomDraft(m.draft as DocumentDraft & RoomDraftExtras);
      else if (m.t === 'file-part') await receiveFilePart(m);
      else if (m.t === 'reg') await applyRoomReg(m.reg as RegistrationDraft);
      else if (m.t === 'settings') await applyRoomSettings(m, r);
      else if (m.t === 'need-file') {
        // Someone joined after the file went round. The tab it was asked of answers at once; the
        // others wait a few seconds and stand down if it arrives (they answer only if that tab left).
        if (state.source && fileHashOf(state.source) === m.hash && !fileReply && Date.now() - fileAnswered > 5000) {
          const mine = (state.signer ?? state.key)?.getFingerprint().toUpperCase();
          fileReply = setTimeout(
            () => {
              fileReply = null;
              fileAnswered = Date.now();
              void roomShare(m.hash);
            },
            m.to && m.to === mine ? 0 : 3000 + Math.random() * 2000,
          );
        }
      }
    } catch (err) {
      $('room-status').textContent = `A message from the room could not be used: ${(err as Error).message}`;
    }
  }
}

async function enterRoom(r: SigningRoom) {
  room?.leave();
  room = r;
  peers.clear();
  roomFileSent = '';
  input('room-link').value = r.link();
  // The link as a QR code, for a phone in the same room.
  const qr = bestQr(r.link());
  $('room-qr').innerHTML = qr ? qrSvg(qr) : '';
  r.connect();
}

/** A QR code as an inline SVG (drawn here, no image files). */
function qrSvg(m: { size: number; dark(r: number, c: number): boolean }) {
  let path = '';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
  const n = m.size + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" aria-label="QR code of the room link"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// ---- Turning Sign together on: the page says where it was loaded from and where it would connect ----
function showRoomConsent() {
  const official = officialOrigin();
  const here = roomsAvailableHere();
  $('room-host').textContent = official.replace(/^https:\/\//, '');
  let where = '';
  try {
    where = location.protocol === 'file:' ? 'a saved copy on this computer' : location.origin;
  } catch {
    where = 'an embedded preview';
  }
  const msg = $('room-where');
  msg.innerHTML = '';
  // A county copy with its own rooms: the original program's site can always coordinate instead.
  const masterNote = $('room-master');
  masterNote.innerHTML = '';
  masterNote.hidden = official === MASTER_URL;
  if (official !== MASTER_URL) {
    masterNote.append(
      'Or sign together on the original program\u2019s site, with this page\u2019s settings: ',
      Object.assign(document.createElement('a'), {
        id: 'room-master-link',
        href: settingsLinkFor(MASTER_URL, room ? `#room=${room.secret}` : '#sign'),
        textContent: MASTER_URL.replace(/^https:\/\//, ''),
        target: '_blank',
        rel: 'noopener',
      }),
      room ? ' (the same room: send the others that link too).' : '.',
    );
  }
  if (here) {
    const all = officialOrigins();
    const relays = all.length > 1 ? `the program\u2019s relay server (${all[1]}), or its backup relay (${all[0]}) if that can\u2019t be reached` : `that same address`;
    msg.textContent =
      location.origin === official
        ? `This page was loaded from ${official}, the program\u2019s own address. Sign together connects this tab to ${relays}, and only while you are in a room.`
        : `This page was loaded from ${location.origin}, the program\u2019s server. Sign together connects this tab to ${relays}, and only while you are in a room.`;
  } else {
    // Only the program's own address can sign together: a copy elsewhere can't be trusted to.
    msg.append(
      `Sign together works only on the program\u2019s own address. This page was loaded from ${where}. To sign together, open `,
      Object.assign(document.createElement('a'), { href: settingsLinkFor(official, INVITED_ROOM ? `#room=${INVITED_ROOM}` : '#sign'), textContent: official, rel: 'noopener' }),
      ' and use it there.',
    );
  }
  // A room is for key holders who accepted the terms: unlock your private key first, so the
  // others see you proven by it, and agree to the terms of service and waiver of liability.
  input('room-agree').disabled = !here;
  const ready = here && !!state.signer && input('room-agree').checked;
  input('room-enable').disabled = !ready;
  if (!ready && input('room-enable').checked && !room) input('room-enable').checked = false;
  $('room-need-key').hidden = !here || !!state.signer;
  const on = input('room-enable').checked && ready;
  ($('room-start') as HTMLButtonElement).disabled = !on;
  ($('room-join') as HTMLButtonElement).disabled = !on;
  ($('room-code-join') as HTMLButtonElement).disabled = !on || !!room?.ws;
  $('room-paste').hidden = !!room?.ws;
}
input('room-agree').addEventListener('change', () => {
  // Withdrawing agreement turns Sign together off (and leaves any room).
  if (!input('room-agree').checked && input('room-enable').checked) {
    input('room-enable').checked = false;
    if (room) $('room-leave').click();
  }
  showRoomConsent();
});
input('room-enable').addEventListener('change', () => {
  // Turning it off leaves any room.
  if (!input('room-enable').checked && room) $('room-leave').click();
  // The person chose to connect: a good moment to see if the program's site has a newer version.
  if (input('room-enable').checked) void checkForUpdate();
  showRoomConsent();
});

action('room-start', async () => {
  if (!roomsAvailableHere()) throw new UserError(`Sign together works only on ${officialOrigin() || 'the program\u2019s own address'}.`);
  if (!state.signer) throw new UserError('Load and unlock your private key (step 1) first.');
  if (!input('room-agree').checked) throw new UserError('Read and agree to the terms of service and waiver of liability first.');
  if (!input('room-enable').checked) throw new UserError('Turn on Sign together first.');
  await enterRoom(await SigningRoom.create(roomEvents));
  try {
    history.replaceState(null, '', `#room=${room!.secret}`);
  } catch {
    /* sandboxed preview: the link is shown to copy */
  }
});
action('room-join', async () => {
  if (!roomsAvailableHere()) throw new UserError(`Sign together works only on ${officialOrigin() || 'the program\u2019s own address'}.`);
  if (!state.signer) throw new UserError('Load and unlock your private key (step 1) first.');
  if (!input('room-agree').checked) throw new UserError('Read and agree to the terms of service and waiver of liability first.');
  if (!input('room-enable').checked) throw new UserError('Turn on Sign together first.');
  $('room-invite-top').hidden = true;
  const secret = INVITED_ROOM || /room=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
  if (!secret) throw new UserError('This link has no signing room in it.');
  $('room-invite').hidden = true;
  await enterRoom(await SigningRoom.open(secret, roomEvents));
});
input('room-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('room-code-join').click();
});
/** Joins a room from a pasted link or code, without reloading: the unlocked key and the work in progress stay. */
action('room-code-join', async () => {
  if (!roomsAvailableHere()) throw new UserError(`Sign together works only on ${officialOrigin() || 'the program\u2019s own address'}.`);
  if (!state.signer) throw new UserError('Load and unlock your private key (step 1) first.');
  if (!input('room-agree').checked) throw new UserError('Read and agree to the terms of service and waiver of liability first.');
  if (!input('room-enable').checked) throw new UserError('Turn on Sign together first.');
  const v = input('room-code').value.trim();
  const secret = /room=([A-Za-z0-9_-]{20,})/.exec(v)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(v) ? v : '');
  if (!secret) throw new UserError('Paste the room link (it has "#room=" in it) or the code that follows "#room=".');
  // A room lives at one address: a link to another copy's site is joined there.
  const other = /^https?:\/\/[^/#?]+/i.exec(v)?.[0];
  if (other && !officialOrigins().some((o) => o.toLowerCase() === other.toLowerCase())) {
    throw new UserError(`That room is on ${other}, not this site. Open the link itself to join it there.`);
  }
  $('room-invite-top').hidden = true;
  $('room-invite').hidden = true;
  await enterRoom(await SigningRoom.open(secret, roomEvents));
  input('room-code').value = '';
  try {
    history.replaceState(null, '', `#room=${secret}`);
  } catch {
    /* sandboxed preview */
  }
});
action('room-leave', () => {
  room?.leave();
  room = null;
  roomStatus('closed', 0);
  try {
    if (/room=/.test(location.hash)) history.replaceState(null, '', location.href.split('#')[0]);
  } catch {
    /* sandboxed preview */
  }
});
action('room-copy', async () => {
  try {
    await navigator.clipboard.writeText(input('room-link').value);
    $('room-status').textContent = 'Link copied. Send it privately: anyone with it can join the room.';
  } catch {
    input('room-link').select();
    $('room-status').textContent = 'Select the link above and copy it.';
  }
});

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
    registration: state.signReg ? draftRegistration(state.signReg) : undefined,
    buyerKeys: buyerKeys.length ? buyerKeys.map((k) => k.armor()) : undefined,
    buyerProof: d.buyerProof?.signatures.map((x) => ({ fingerprint: x.fingerprint, userID: x.userID, signedAt: x.signedAt.toISOString(), sig: toBase64(x.bytes) })),
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
      parcelStatement: d.source.parcelStatement,
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
  // Sale deed naming the buyers' keys: the PDF also carries them as the next registration.
  const named = canonicalText(d.text).replace(/\s+/g, '');
  const transfer =
    state.signReg?.parcel && buyerKeys.length && buyerKeys.every((k) => named.includes(k.getFingerprint().toUpperCase()))
      ? { parcel: state.signReg.parcel, keys: buyerKeys, from: state.signReg.keys, proof: d.buyerProof }
      : undefined;
  const pdf = await instrumentPdf({
    transfer,
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
          ? ps.byTransfer
            ? `Proof of key possession: by sale. Every previous registered key signed the deed naming these keys (${merged.transfer!.from
                .map((k) => k.getFingerprint().toUpperCase().slice(-16))
                .join(', ')}). Confirm with the Recorder's index that this deed was recorded and is the latest for the parcel.`
            : `Proof of key possession: every key signed this registration.`
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
    const file = input('bin-v-file').files?.[0];
    const sigFile = input('bin-v-sig').files?.[0];
    if (!file) throw new UserError('Choose the signed file, exactly as you received it.');
    if (!sigFile) throw new UserError('Choose its signature: the .sig file, or the verification page.');
    const sigBytes = new Uint8Array(await sigFile.arrayBuffer());
    // A program release statement carries the publisher's key: use it when no registration is loaded.
    let publisherKey: AnyKey | null = null;
    if (!verifyRegs.length && isPdfBytes(sigBytes)) {
      const att = (await releaseAttachments(sigBytes).catch(() => [])).find((a) => a.name === RELEASE_KEY_ATTACHMENT);
      if (att) publisherKey = await readAnyKey(new TextDecoder().decode(att.data));
    }
    if (!verifyRegs.length && !publisherKey) throw new UserError('Load the owner\u2019s registration or public key card first (above).');
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
    await checkBinary(file, signature, publisherKey);
  },
  'Checking...',
);

/** Checks a binary-signed file against the loaded keys and shows the result. */
async function checkBinary(file: File, signature: Uint8Array, publisherKey: AnyKey | null = null) {
  const keys = publisherKey ? [publisherKey] : mergeRegistrations(verifyRegs).keys;
  const r = await verifyBinaryFile({ signature, document: new Uint8Array(await file.arrayBuffer()), keys });
  r.checks.push(
    publisherKey
      ? {
          label: 'What this proves',
          state: 'skipped',
          detail: `That this exact file was signed by the key attached to the release statement (fingerprint ${publisherKey.getFingerprint().toUpperCase()}). Compare that fingerprint with the one the publisher gives elsewhere: anyone can make a statement with their own key.`,
        }
      : {
          label: 'What this proves',
          state: 'skipped',
          detail: 'That this exact file was signed by the key(s) above. A binary file signature is for files sent directly to you; it is not used for filing with the Recorder.',
        },
  );
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
    // Registration-by-sale codes (the buyers' keys) on a sale deed, kept for the certificate.
    const regGroups = new Map<string, string[]>();
    const statementProofs: SignedText[] = [];
    for (const [i, f] of files.entries()) {
      // Document IDs printed in the pages' code maps: must match the text the codes carry.
      const mapIds = new Set<string>();
      const codes = await readCodesFromFile(
        f,
        (m) => (el.textContent = files.length > 1 ? `File ${i + 1} of ${files.length}: ${m}` : m),
        (c) => {
          if (c.some((x) => x.startsWith('PGPSIG1|'))) return true;
          // Every group of signature codes seen is complete (a sale deed has two: the deed and the buyers' proof).
          const groups = new Set(c.filter((x) => x.startsWith('PGPQ1|')).map((x) => x.split('|')[1]));
          if (!groups.size) return false;
          const sale = c.some((x) => x.startsWith('PGPR1|'));
          if (sale && groups.size < 2) return false;
          return [...groups].every((g) => {
            const p = scanProgress(c.filter((x) => x.split('|')[1] === g).join('\n'));
            return p.total > 0 && p.missing.length === 0;
          });
        },
        (map) => {
          if (map.documentId) mapIds.add(map.documentId);
        },
      );
      for (const c of codes) {
        const m = /^PGPR1\|([0-9A-F]{12})\|/.exec(c);
        if (m && !regGroups.get(m[1])?.includes(c)) regGroups.set(m[1], [...(regGroups.get(m[1]) ?? []), c]);
      }
      // A sale deed also carries the buyers' proof (signatures over the new registration's
      // statement) as signature codes: keep those apart from the document's own codes.
      const allSig = codes.filter((c) => /^(PGPQ1|PGPSIG1)\|/.test(c.trim()));
      const byGroup = new Map<string, string[]>();
      for (const c of allSig.filter((x) => x.startsWith('PGPQ1|'))) {
        const g = c.split('|')[1];
        byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
      }
      const proofGroups = new Set<string>();
      if (byGroup.size > 1) {
        for (const [g, list] of byGroup) {
          try {
            const t = await signedFromCodes(list.join('\n'));
            if (/^S\.T\.O\.P\. (PARCEL|LIEN HOLDER) KEY REGISTRATION\./.test(t.canonical)) {
              proofGroups.add(g);
              statementProofs.push(t);
            }
          } catch {
            /* incomplete group: left with the document's codes */
          }
        }
      }
      const sigCodes = allSig.filter((c) => !proofGroups.has(c.split('|')[1]));
      if (!sigCodes.length) {
        results.push({ name: f.name, problem: codes.length ? 'no signature codes' : 'no QR codes found' });
        continue;
      }
      if (sigCodes.some((c) => c.startsWith('PGPSIG1|'))) {
        results.push({ name: f.name, legacy: sigCodes });
        continue;
      }
      try {
        const signed = await signedFromCodes(sigCodes.join('\n'));
        const other = [...mapIds].filter((id) => id !== signed.documentId);
        if (other.length) {
          results.push({ name: f.name, problem: `it holds a page from a different document (document ID ${other[0]} in a code map, but the codes carry document ${signed.documentId})` });
          continue;
        }
        results.push({ name: f.name, signed });
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
      const unreadable = results.some((r) => !r.problem || /no (signature|QR) codes|missing/i.test(r.problem));
      el.textContent =
        results.map((r) => `${r.name}: ${(r.problem ?? 'unreadable').replace(/\.+$/, '')}`).join('; ') +
        (unreadable ? '. Make sure the signature page is included, sharp and well lit.' : '.');
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
    saleRegistrationCodes = [];
    saleProofCodes = [];
    for (const g of regGroups.values()) {
      try {
        const r = await decodeRegistrationCodes(g.join('\n'));
        if (r.transfer?.documentId === merged.documentId) {
          saleRegistrationCodes = orderedCodes(g.join('\n'), 'PGPR1');
          const proof = statementProofs.find((t) => t.canonical === canonicalText(registrationStatement(r)));
          saleProofCodes = proof ? proof.codes : [];
        }
      } catch {
        /* incomplete: the certificate simply won't carry it */
      }
    }
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


/** A sale deed's registration-by-sale codes, read with the checked file (reprinted on the certificate). */
let saleRegistrationCodes: string[] = [];
/** The buyers' proof of key possession from that deed (reprinted with them). */
let saleProofCodes: string[] = [];

textarea('v-payload').addEventListener('input', () => {
  if (!settingPayload) {
    scannedFiles = [];
    checkedFiles = [];
    saleRegistrationCodes = [];
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
    const certificate = {
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
      saleRegistration: saleRegistrationCodes.length ? saleRegistrationCodes : undefined,
      saleProof: saleProofCodes.length ? saleProofCodes : undefined,
    };
    const withOriginal = input('c-with-original').checked && checkedFiles.length > 0;
    const withChecked = input('c-with-checked').checked && checkedFiles.length > 0;
    if (!withOriginal && !withChecked) {
      download(await certificatePdf(certificate), `verification-certificate-${c.documentId.slice(0, 12)}.pdf`, 'application/pdf');
      return;
    }
    const files = await checkedFileEntries();
    // The certificate's list of scanned copies carries each one's fingerprint.
    certificate.files = certificate.files.map((f, i) => ({ ...f, sha256: files[i]?.sha256 }));
    const v = verdictForStamp(lastVerdict ?? { verdict: c.result });
    const pdf = await combinedFilingPdf({
      files,
      includeOriginal: withOriginal,
      includeChecked: withChecked,
      result: v.result,
      summary: v.summary,
      documentId: c.documentId,
      checkedAt: certificate.checkedAt,
      certificate,
    });
    download(pdf, `filing-with-verification-${c.documentId.slice(0, 12)}.pdf`, 'application/pdf');
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
  $('combine-wrap').hidden = !checkedFiles.length;
  $('combine-none').hidden = !!checkedFiles.length;
  $('verify-result').hidden = false;
  $('verify-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let lastVerdict: { verdict: Verdict; documentId?: string; notForRecording?: boolean } | null = null;

/** The files that were checked, ready to reprint: PDFs as they are, images as pages, with each one's SHA-256. */
async function checkedFileEntries(): Promise<CheckedFile[]> {
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
  return files;
}

function verdictForStamp(v: NonNullable<typeof lastVerdict>): { result: 'good' | 'bad'; summary: string } {
  const result = v.verdict === 'good' ? 'good' : 'bad';
  return {
    result,
    summary: result !== 'good' ? 'do not rely on it' : v.notForRecording ? 'every key signed; third parties only, not for recording' : 'every key signed',
  };
}

action(
  'copy-btn',
  async () => {
    if (!lastVerdict || !checkedFiles.length) throw new UserError('Check a document first.');
    const files = await checkedFileEntries();
    const v = verdictForStamp(lastVerdict);
    const pdf = await checkedCopyPdf({ files, result: v.result, summary: v.summary, documentId: lastVerdict.documentId, checkedAt: new Date() });
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
          label: ps.byTransfer ? 'Registration by sale proven' : 'Registration proven by every key',
          state: ps.complete ? 'pass' : 'fail',
          detail: ps.complete
            ? ps.byTransfer
              ? `These keys were named in a sale deed (document ID ${registration.transfer!.documentId}) signed by every previous registered key. Confirm with the Recorder's index that it was recorded and is the latest for the parcel.`
              : 'Every registered key signed the registration itself, proving its holder had the key and passphrase.'
            : ps.byTransfer
              ? `The sale that made this registration could not be confirmed: ${ps.problems.join(' ')} Do not rely on it.`
              : `The registration is not fully proven: ${ps.missing.length} key${ps.missing.length === 1 ? ' has' : 's have'} not signed it. Do not rely on it.`,
        });
        // A sale deed naming buyers' keys: say whether the registration by sale is complete.
        if (saleRegistrationCodes.length) {
          try {
            const next = await decodeRegistrationCodes(saleRegistrationCodes.join('\n'));
            const deed = await signedFromCodes(payload);
            if (next.transfer) next.transfer.deed = deed;
            if (saleProofCodes.length) next.proof = await signedFromCodes(saleProofCodes.join('\n'));
            const ns = await checkRegistrationProof(next);
            r.checks.push({
              label: 'Buyers\u2019 keys (registration by sale)',
              state: ns.complete ? 'pass' : 'skipped',
              detail: ns.complete
                ? `The deed names ${next.keys.length} buyer key${next.keys.length === 1 ? '' : 's'}, each proven by its holder. Once recorded, this deed is the parcel's registration.`
                : `The deed names buyers' keys, but ${ns.problems.join(' ')} The deed itself is checked above; protection does not pass to the buyers until every buyer key is proven.`,
            });
          } catch {
            /* unreadable: the deed check above stands on its own */
          }
        }
        if (registration.role === 'lienholder') {
          r.checks.push({
            label: 'Checked against a lien holder',
            state: 'skipped',
            detail: `These are the keys of the holder of a lien${registration.interest ? ` (${registration.interest})` : ''}. Use this for a release, satisfaction or assignment of that lien; a deed is checked against the owner's registration.`,
          });
        }
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
        if (!input('c-agency').value) input('c-agency').value = BRAND.recorderOffice;
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

/**
 * The changelog (Markdown) as safe DOM: headings, lists, bold and code only.
 * Built with text nodes, so nothing in it can run as HTML.
 */
function renderChangelog(md: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const inline = (parent: HTMLElement, text: string) => {
    // **bold**, `code`, [label](url) -> label
    for (const part of text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith('**')) parent.append(Object.assign(document.createElement('strong'), { textContent: part.slice(2, -2) }));
      else if (part.startsWith('`')) parent.append(Object.assign(document.createElement('code'), { textContent: part.slice(1, -1) }));
      else parent.append(part);
    }
  };
  let list: HTMLUListElement | null = null;
  let item: HTMLElement | null = null;
  let para: HTMLElement | null = null;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (h) {
      list = item = para = null;
      if (h[1].length === 1) continue; // the file's own title
      const el = document.createElement(h[1].length === 2 ? 'h3' : 'h4');
      inline(el, h[2]);
      out.append(el);
    } else if (li) {
      para = null;
      if (!list) out.append((list = document.createElement('ul')));
      item = document.createElement('li');
      inline(item, li[1]);
      list.append(item);
    } else if (!line.trim()) {
      list = item = para = null;
    } else if (item) {
      inline(item, ` ${line.trim()}`);
    } else {
      if (!para) out.append((para = document.createElement('p')));
      else para.append(' ');
      inline(para, line.trim());
    }
  }
  return out;
}

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

// A county's copy ("Download this county's program") carries its settings: they are its defaults.
{
  const cfg = bakedConfig();
  if (cfg) {
    const keys = ['name', 'expansion', 'county', 'state', 'recorderOffice', 'projectUrl', 'entityAuthority', 'relayUrl', 'analyticsToken'] as const;
    for (const k of keys) {
      const v = cfg[k];
      if (typeof v === 'string' && (v.trim() || k === 'relayUrl')) {
        BRAND[k] = v.trim();
        BRAND_DEFAULTS[k] = v.trim();
      }
    }
    // A copy can never claim the county adopted it: that takes the county's own source build.
    BRAND.status = BRAND_DEFAULTS.status = 'proposed';
    BRAND.proposedNotice = BRAND_DEFAULTS.proposedNotice = `Proposed program: not yet adopted by ${BRAND.county}. Not an official county form.`;
    document.querySelectorAll<HTMLElement>('[data-copy-of]').forEach((el) => (el.hidden = false));
    $('copy-of').textContent = `${BRAND.county}, ${BRAND.state} (a copy made from ${cfg.madeFrom ?? 'the S.T.O.P. tool'})`;
    if (typeof cfg.publisher === 'string' && cfg.publisher.trim()) {
      document.querySelectorAll<HTMLElement>('[data-publisher]').forEach((el) => (el.hidden = false));
      $('copy-publisher').textContent = `${safeText(cfg.publisher)} (check the file against their signed release statement)`;
    }
  }
}

// Branding (src/brand.ts) and the seal embedded in index.html. Re-run when the
// jurisdiction is overridden ("Use this tool for another county or state").
let defaultSeal: { bytes: Uint8Array; src: string } | null = null;
let customLogo: { bytes: Uint8Array; type: string } | null = null;
{
  const seal = $<HTMLImageElement>('brand-seal');
  const src = seal.getAttribute('src') ?? '';
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(src);
  if (m) {
    try {
      defaultSeal = { bytes: fromBase64Text(m[2]), src };
    } catch {
      /* bad image data: PDFs are made without the seal */
    }
  }
}

/**
 * The seal to show when no logo was uploaded: the build's own seal while the county is
 * still its default (Pima County, or a county copy's own), otherwise the chosen state's
 * seal (src/seals.ts), if there is one.
 */
function sealForState(state = BRAND.state, county = BRAND.county) {
  if (county === BRAND_DEFAULTS.county && state === BRAND_DEFAULTS.state && defaultSeal) return null;
  return STATE_SEALS[state] ?? null;
}

function applyBrandToPage() {
  document.title = `${BRAND.name} (${BRAND.expansion})`;
  document.querySelectorAll<HTMLElement>('[data-brand]').forEach((el) => {
    const v = BRAND[el.dataset.brand as keyof typeof BRAND];
    if (typeof v === 'string') el.textContent = v;
  });
  $('proposed-note').hidden = BRAND.status !== 'proposed';
  const holder = $('project-url');
  holder.textContent = '';
  if (/^https?:\/\//.test(BRAND.projectUrl)) {
    holder.append(Object.assign(document.createElement('a'), { href: BRAND.projectUrl, textContent: BRAND.projectUrl, rel: 'noopener' }));
  } else {
    holder.textContent = BRAND.projectUrl;
  }
  const seal = $<HTMLImageElement>('brand-seal');
  const stateSeal = sealForState();
  if (customLogo) {
    seal.src = `data:${customLogo.type};base64,${toBase64(customLogo.bytes)}`;
    seal.hidden = false;
    setBrandSeal(customLogo.bytes);
  } else if (stateSeal) {
    seal.src = `data:image/png;base64,${stateSeal.png}`;
    seal.alt = `Seal of ${BRAND.state}`;
    seal.hidden = false;
    setBrandSeal(fromBase64Text(stateSeal.png));
  } else if (defaultSeal) {
    seal.src = defaultSeal.src;
    seal.hidden = false;
    setBrandSeal(defaultSeal.bytes);
  } else {
    seal.hidden = true;
    setBrandSeal(null);
  }
}
applyBrandToPage();

// ---- Use this tool for another county or state ----
// Prominent: a button in the page header (and the seal itself) opens the panel, on any tab.
function openJurisdiction() {
  if (settingsLockedByRoom()) {
    banner(`You are in a signing room: its settings come from ${roomHost?.name ?? 'the person who started it'}. Leave the room to change them.`);
    $('boot').className = 'callout';
    return;
  }
  const d = $('jurisdiction') as HTMLDetailsElement;
  d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  input('j-county').focus({ preventScroll: true });
}
$('j-open').addEventListener('click', openJurisdiction);
$('jurisdiction').addEventListener('toggle', () => {
  const d = $('jurisdiction') as HTMLDetailsElement;
  if (d.open && settingsLockedByRoom()) {
    d.open = false;
    openJurisdiction();
  }
});
$('brand-seal').addEventListener('click', openJurisdiction);
$('brand-seal').title = 'Change the county, state or logo';
// State and county selectors (src/counties.ts: every U.S. county, from the Census Bureau).
const stateSelect = $<HTMLSelectElement>('j-state');
const countySelect = $<HTMLSelectElement>('j-county');
for (const code of Object.keys(STATES).sort((a, b) => STATES[a].name.localeCompare(STATES[b].name))) {
  stateSelect.append(new Option(STATES[code].name, STATES[code].name));
}
/** Fills the county list for the chosen state (keeping a county from a link even if it isn't listed). */
function fillCounties(selected: string) {
  const list = countiesOf(stateCode(stateSelect.value));
  countySelect.innerHTML = '';
  for (const c of list) countySelect.append(new Option(c, c));
  if (selected && !list.includes(selected)) countySelect.append(new Option(selected, selected));
  countySelect.value = selected && [...countySelect.options].some((o) => o.value === selected) ? selected : (list[0] ?? '');
}
/** The county the form's names were last filled from (they follow it until typed differently). */
let formCounty = BRAND.county;
/** Picking a county fills in its recording office and the names that carry the county. */
function countyChosen() {
  const county = countySelect.value;
  input('j-recorder').value = recordingOffice(stateCode(stateSelect.value), county);
  for (const id of ['j-name', 'j-authority']) {
    const v = input(id).value;
    if (formCounty && v.includes(formCounty)) input(id).value = v.split(formCounty).join(county);
  }
  formCounty = county;
}
function sealPreview() {
  const img = $<HTMLImageElement>('j-seal-preview');
  const s = customLogo ? null : sealForState(stateSelect.value, countySelect.value);
  img.src = customLogo
    ? `data:${customLogo.type};base64,${toBase64(customLogo.bytes)}`
    : s
      ? `data:image/png;base64,${s.png}`
      : (defaultSeal?.src ?? '');
  img.hidden = !img.src;
  $('j-seal-note').textContent = customLogo ? 'Your logo.' : s ? `The seal of ${stateSelect.value}${s.insignia ? ' (its use is restricted by state law: get permission before official use)' : ''}.` : 'This build\u2019s own seal.';
}
stateSelect.addEventListener('change', () => {
  fillCounties('');
  countyChosen();
  sealPreview();
});
countySelect.addEventListener('change', () => {
  countyChosen();
  sealPreview();
});

function fillJurisdictionForm() {
  input('j-name').value = BRAND.name;
  input('j-expansion').value = BRAND.expansion;
  if (![...stateSelect.options].some((o) => o.value === BRAND.state)) stateSelect.append(new Option(BRAND.state, BRAND.state));
  stateSelect.value = BRAND.state;
  fillCounties(BRAND.county);
  formCounty = BRAND.county;
  sealPreview();
  input('j-recorder').value = BRAND.recorderOffice;
  input('j-url').value = BRAND.projectUrl;
  input('j-authority').value = BRAND.entityAuthority;
}
fillJurisdictionForm();

// ---- Settings from the link: ?county=...&state=...&seal=data:image/png;base64,... ----
const LINK_KEYS: [string, keyof Jurisdiction][] = [
  ['name', 'name'],
  ['expansion', 'expansion'],
  ['county', 'county'],
  ['state', 'state'],
  ['recorder', 'recorderOffice'],
  ['url', 'projectUrl'],
  ['authority', 'entityAuthority'],
];

/** A seal given in the link: only the image itself (a data: address), never a web address to fetch. */
function sealFromDataUrl(v: string): typeof customLogo {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(v.trim());
  if (!m) {
    throw new UserError(
      'The seal in the link must be the image itself (data:image/png;base64,... or data:image/jpeg;base64,...). This page never loads images from other servers.',
    );
  }
  const bytes = fromBase64Text(m[2].replace(/\s+/g, ''));
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) throw new UserError('The seal in the link is not a PNG or JPG image.');
  return { bytes, type: png ? 'image/png' : 'image/jpeg' };
}

function settingsFromLink() {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return;
  }
  const j: Partial<Jurisdiction> = {};
  for (const [param, key] of LINK_KEYS) {
    const v = q.get(param);
    if (v?.trim()) j[key] = v;
  }
  const seal = q.get('seal');
  if (!Object.keys(j).length && !seal) return;
  try {
    const logo = seal ? sealFromDataUrl(seal) : null;
    // Names that still carry the default county follow the county given in the link.
    if (j.county && !j.name && BRAND.name.includes(BRAND.county)) j.name = BRAND.name.split(BRAND.county).join(j.county.trim());
    if (j.county && !j.entityAuthority && BRAND.entityAuthority.includes(BRAND.county)) j.entityAuthority = BRAND.entityAuthority.split(BRAND.county).join(j.county.trim());
    if (j.county && !j.recorderOffice) j.recorderOffice = recordingOffice(stateCode(j.state ?? BRAND.state), j.county.trim());
    useJurisdiction(j, logo);
    $('j-status').textContent = `Settings from the link: ${BRAND.name} (${BRAND.county}, ${BRAND.state}).`;
  } catch (err) {
    banner(`The settings in this link could not be used: ${(err as Error).message}`);
  }
}

// ---- Download this county's program: the HTML with its settings built in, and the Worker ----
action('lb-package', async () => {
  const host = input('lb-host').value.trim().replace(/\/$/, '');
  if (host && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    throw new UserError('The address must be an https address with no path, like https://maricopa-county-stop.your-account.workers.dev');
  }
  const ownRooms = input('lb-rooms').checked;
  if (ownRooms && !host) throw new UserError('To run Sign together at the copy\u2019s own address, enter that address.');
  if (input('lb-analytics').checked && !/^[A-Za-z0-9]{16,64}$/.test(input('lb-analytics-token').value.trim())) {
    throw new UserError('Enter your Cloudflare Web Analytics token (letters and digits, from the Cloudflare dashboard), or untick "Use our own".');
  }
  const cfg = cleanConfig({
    name: input('j-name').value,
    expansion: input('j-expansion').value,
    county: input('j-county').value,
    state: input('j-state').value,
    recorderOffice: input('j-recorder').value,
    // The copy's own address is its program address (printed on its PDFs).
    projectUrl: host ? `${host}/` : input('j-url').value.trim(),
    entityAuthority: input('j-authority').value,
    // Sign together: at the copy's own address (its own Worker), or at the original program's site.
    relayUrl: ownRooms ? host : MASTER_URL,
    // Their own analytics, or the master site's.
    analyticsToken: input('lb-analytics').checked ? input('lb-analytics-token').value.trim() : MASTER_ANALYTICS_TOKEN,
    madeFrom: `${__APP_VERSION__}, ${new Date().toISOString().slice(0, 10)}`,
  });
  if (!cfg.county || !cfg.state) throw new UserError('Choose the state and county first.');
  const pubName = safeText(input('lb-pub-name').value).trim();
  const pubTitle = safeText(input('lb-pub-title').value).trim();
  const postedAt = input('lb-pub-site').value.trim();
  if (postedAt && !/^https?:\/\/\S+$/i.test(postedAt)) throw new UserError('Where the statement will be posted must be a web address (https://...).');
  const sign = input('lb-sign').checked;
  if (sign && !state.signer) throw new UserError('To sign the program file, unlock your private key in "Your key" first, or untick "Sign the program file".');
  cfg.publisher = [pubName, pubTitle].filter(Boolean).join(', ') || undefined;
  const f = input('j-logo').files?.[0];
  const logo = f ? await logoFromFile(f) : customLogo;
  const st = logo ? null : sealForState(cfg.state, cfg.county);
  const html = new TextEncoder().encode(
    countyHtml(PRISTINE_HTML, cfg, logo ? { type: logo.type, base64: toBase64(logo.bytes) } : st ? { type: 'image/png', base64: st.png } : null),
  );
  // The signature covers the exact program file (index.html), so it verifies with gpg and "Check a binary-signed file".
  const signed = sign && state.signer ? await signDocument(state.signer, html) : null;
  const publicArmored = signed && state.signer ? state.signer.toPublic().armor() : '';
  const zipName = `${slug(cfg.name)}-program.zip`;
  const zip = countyPackage(html, cfg, __WORKER_SOURCE__, signed ? { signature: signed.signature, publicArmored, fingerprint: signed.fingerprint } : null);
  download(zip, zipName, 'application/zip');
  const sha256 = await sha256Hex(html);
  lastRelease = {
    program: cfg.name,
    county: cfg.county,
    state: cfg.state,
    office: cfg.recorderOffice,
    programUrl: cfg.projectUrl,
    signTogether: ownRooms ? `at ${host}` : `at ${MASTER_URL} (the original program)`,
    madeFrom: cfg.madeFrom,
    publisherName: pubName,
    publisherTitle: pubTitle,
    postedAt,
    fileName: 'index.html',
    fileSize: html.length,
    sha256,
    zipName,
    zipSha256: await sha256Hex(zip),
    documentId: signed?.documentId ?? sha256.slice(0, 24).toUpperCase(),
    signed: signed && state.signer
      ? { userID: describeKey(state.signer), fingerprint: signed.fingerprint, signedAt: signed.signedAt, payload: signed.payload, signature: signed.signature, publicArmored }
      : null,
  };
  $('lb-statement').hidden = false;
  $('lb-status').textContent =
    `Downloaded the program for ${cfg.county}, ${cfg.state}. Unzip it and follow its README.md. ` +
    (signed
      ? 'Signed with your key: download the release statement and post it on your website.'
      : 'Not signed. The release statement records the file\u2019s hash; tick "Sign the program file" to make it provable.');
});
let lastRelease: ReleaseStatementInfo | null = null;
action('lb-statement', async () => {
  if (!lastRelease) throw new UserError('Download the program first.');
  download(await releaseStatementPdf(lastRelease), `${slug(lastRelease.program)}-release-statement.pdf`, 'application/pdf');
});

document.querySelectorAll<HTMLElement>('[data-official-site]').forEach((el) => (el.textContent = MASTER_URL));

input('lb-analytics').addEventListener('change', () => ($('lb-analytics-wrap').hidden = !input('lb-analytics').checked));

// ---- Usage analytics: Cloudflare Web Analytics, only if the visitor allows it ----
function askAnalytics() {
  let web = false;
  try {
    web = /^https:$/.test(location.protocol);
  } catch {
    web = false;
  }
  // Only on the web (a saved copy has no visit to count), and only with a token.
  $('analytics-ask').hidden = !(web && /^[A-Za-z0-9]{16,64}$/.test(BRAND.analyticsToken));
}
action('analytics-yes', () => {
  $('analytics-ask').hidden = true;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: BRAND.analyticsToken, spa: false }));
  document.head.append(s);
  void checkForUpdate();
});

// ---- Update check: only after the person turns on something that connects (Sign together, analytics) ----
/** A link to the program at `base` carrying this page's settings (county, office, names, logo). */
function settingsLinkFor(base: string, hash = '') {
  const q = new URLSearchParams();
  const b = BRAND as unknown as Record<string, string>;
  for (const [param, key] of LINK_KEYS) {
    const v = String(b[key] ?? '').trim();
    if (v && !(key === 'projectUrl' && v.replace(/\/$/, '') === MASTER_URL)) q.set(param, v);
  }
  const seal = $('brand-seal').getAttribute('src') ?? '';
  const st = sealForState();
  // The state seals are built in everywhere; any other logo travels in the link (if it isn't huge).
  if (/^data:image\/(png|jpe?g);base64,/.test(seal) && seal.length < 200_000 && !(st && seal === `data:image/png;base64,${st.png}`)) q.set('seal', seal);
  return `${base.replace(/\/$/, '')}/?${q.toString()}${hash}`;
}

const VERSION_RE = /stop-version=(v[\w.-]+) built=(\d{4}-\d\d-\d\dT[\d:]+Z)/;
let updateChecked = false;
/** Reads the version comment at the top of the master site's index.html (the first few KB only). */
async function checkForUpdate() {
  if (updateChecked) return;
  updateChecked = true;
  try {
    if (location.origin === new URL(MASTER_URL).origin) return; // this is the newest
    const res = await fetch(`${MASTER_URL}/?check=1`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Range: 'bytes=0-8191' } });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let head = '';
    while (head.length < 65536 && !VERSION_RE.test(head)) {
      const { done, value } = await reader.read();
      if (done) break;
      head += dec.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => undefined);
    const m = VERSION_RE.exec(head);
    if (!m || !(Date.parse(m[2]) > Date.parse(__BUILD_TIME__))) return;
    $('update-text').textContent = `A newer version of the program (${m[1]}, built ${m[2].slice(0, 10)}) is on ${MASTER_URL.replace(/^https:\/\//, '')}. This copy is ${__APP_VERSION__}, built ${__BUILD_DATE__}.`;
    ($('update-link') as HTMLAnchorElement).href = settingsLinkFor(MASTER_URL, `#${currentTab()}`);
    $('update-offer').hidden = false;
  } catch {
    /* an update check never gets in the way */
  }
}
action('update-dismiss', () => {
  $('update-offer').hidden = true;
});
action('analytics-no', () => {
  $('analytics-ask').hidden = true;
});

// ---- Link builder: the link for the panel's settings as they are now ----
{
  const base = $<HTMLSelectElement>('lb-base');
  const official = officialOrigin();
  const here = (() => {
    try {
      return location.protocol === 'file:' ? '' : location.href.split(/[?#]/)[0];
    } catch {
      return '';
    }
  })();
  if (official) base.append(new Option(`The program's site (${official.replace(/^https:\/\//, '')})`, `${official}/`));
  if (here && here !== `${official}/`) base.append(new Option(`This page's address (${here})`, here));
  if (!base.options.length) base.append(new Option('The program\u2019s web address', BRAND.projectUrl));
}

function buildLink() {
  const fields: [string, string, string][] = [
    ['county', input('j-county').value, BRAND_DEFAULTS.county],
    ['state', input('j-state').value, BRAND_DEFAULTS.state],
    ['recorder', input('j-recorder').value, BRAND_DEFAULTS.recorderOffice],
    ['name', input('j-name').value, BRAND_DEFAULTS.name],
    ['expansion', input('j-expansion').value, BRAND_DEFAULTS.expansion],
    ['url', input('j-url').value, BRAND_DEFAULTS.projectUrl],
    ['authority', input('j-authority').value, BRAND_DEFAULTS.entityAuthority],
  ];
  const q = new URLSearchParams();
  for (const [k, v, d] of fields) if (v.trim() && v.trim() !== d) q.set(k, v.trim());
  if (input('lb-seal').checked && customLogo) q.set('seal', `data:${customLogo.type};base64,${toBase64(customLogo.bytes)}`);
  const tab = $<HTMLSelectElement>('lb-tab').value;
  const link = `${$<HTMLSelectElement>('lb-base').value}${q.toString() ? `?${q.toString()}` : ''}${tab ? `#${tab}` : ''}`;
  textarea('lb-out').value = link;
  ($('lb-open') as HTMLAnchorElement).href = link;
  ($('lb-seal') as HTMLInputElement).disabled = !customLogo;
  $('lb-status').textContent =
    (customLogo ? '' : 'To put a logo in the link, choose it above and press "Use these settings" first. ') +
    (link.length > 60000 ? 'The link is long because it carries the logo itself; some apps may shorten or break long links.' : '');
  return link;
}
for (const id of ['j-name', 'j-expansion', 'j-recorder', 'j-url', 'j-authority']) input(id).addEventListener('input', buildLink);
// The county and state change other fields first (their own listeners), so follow them a moment later.
for (const id of ['j-state', 'j-county']) $(id).addEventListener('change', () => setTimeout(buildLink));
for (const id of ['lb-base', 'lb-tab', 'lb-seal']) $(id).addEventListener('change', buildLink);
$('link-api').addEventListener('toggle', buildLink);
action('lb-copy', async () => {
  const link = buildLink();
  try {
    await navigator.clipboard.writeText(link);
    $('lb-status').textContent = 'Link copied.';
  } catch {
    textarea('lb-out').select();
    $('lb-status').textContent = 'Select the link above and copy it.';
  }
});

action('j-link', async () => {
  const q = new URLSearchParams();
  for (const [param, key] of LINK_KEYS) if (BRAND[key] !== BRAND_DEFAULTS[key]) q.set(param, BRAND[key]);
  if (customLogo) q.set('seal', `data:${customLogo.type};base64,${toBase64(customLogo.bytes)}`);
  const base = location.href.split(/[?#]/)[0];
  const link = q.toString() ? `${base}?${q.toString()}` : base;
  const out = $('j-link-out');
  out.hidden = false;
  out.textContent = link;
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch {
    /* clipboard blocked (sandboxed preview): the link is shown to copy by hand */
  }
  $('j-status').textContent =
    (q.toString() ? 'Link with the current settings ' : 'No settings differ from the defaults; this is the plain link ') +
    (copied ? '(copied to the clipboard).' : '(shown below; copy it by hand).') +
    (link.length > 60000 ? ' It is long because it carries the logo itself.' : '');
});

/** Form defaults that still hold the old county follow the new one. */
function followCounty(oldCounty: string, oldOffice = '') {
  if (!input('reg-county').value || input('reg-county').value === oldCounty) input('reg-county').value = BRAND.county;
  const short = (c: string) => c.replace(/\s+County$/i, '');
  const f = input('f-county').value;
  if (!f || f === short(oldCounty) || f === oldCounty) input('f-county').value = BRAND.county;
  if (!input('c-agency').value || input('c-agency').value === `${oldCounty} Recorder` || input('c-agency').value === oldOffice) input('c-agency').value = BRAND.recorderOffice;
  syncTemplate();
}

function useJurisdiction(j: Partial<Jurisdiction> | null, logo: typeof customLogo) {
  const oldCounty = BRAND.county;
  const oldOffice = BRAND.recorderOffice;
  const clean = j && (Object.fromEntries(Object.entries(j).map(([k, v]) => [k, safeText(String(v ?? '')).trim()])) as Partial<Jurisdiction>);
  applyJurisdiction(clean);
  customLogo = logo;
  applyBrandToPage();
  fillJurisdictionForm();
  followCounty(oldCounty, oldOffice);
  const custom = !!logo || (['name', 'expansion', 'county', 'state', 'recorderOffice', 'projectUrl', 'entityAuthority'] as const).some((k) => BRAND[k] !== BRAND_DEFAULTS[k]);
  $('j-status').textContent = custom
    ? `Using ${BRAND.name} (${BRAND.county}, ${BRAND.state}) until this page is closed.`
    : 'Using the defaults.';
  buildLink();
  if (room?.host) {
    void roomShare();
    showRoomSettings();
  }
}

/** In someone else's room, the settings are theirs. */
function settingsLockedByRoom() {
  return !!room?.ws && !room.host;
}

async function logoFromFile(file: File): Promise<NonNullable<typeof customLogo>> {
  const img = await toPrintableImage(file, new Uint8Array(await file.arrayBuffer()));
  return { bytes: img.bytes, type: img.format === 'png' ? 'image/png' : 'image/jpeg' };
}

action('j-apply', async () => {
  if (settingsLockedByRoom()) throw new UserError(`You are in a signing room: its settings come from ${roomHost?.name ?? 'the person who started it'}. Leave the room to change them.`);
  const f = input('j-logo').files?.[0];
  const logo = f ? await logoFromFile(f) : customLogo;
  useJurisdiction(
    { name: input('j-name').value, expansion: input('j-expansion').value, recorderOffice: input('j-recorder').value, county: input('j-county').value, state: input('j-state').value, projectUrl: input('j-url').value, entityAuthority: input('j-authority').value },
    logo,
  );
  input('j-logo').value = '';
});
action('j-reset', () => {
  useJurisdiction(null, null);
  input('j-logo').value = '';
});
action('j-save', () => {
  const file = {
    format: 'stop-jurisdiction-1',
    name: BRAND.name,
    expansion: BRAND.expansion,
    county: BRAND.county,
    recorderOffice: BRAND.recorderOffice,
    state: BRAND.state,
    projectUrl: BRAND.projectUrl,
    entityAuthority: BRAND.entityAuthority,
    logo: customLogo ? { type: customLogo.type, base64: toBase64(customLogo.bytes) } : undefined,
  };
  download(new TextEncoder().encode(JSON.stringify(file, null, 2)), `${fileSlug(BRAND.county)}-settings.json`, 'application/json');
});
input('j-load').addEventListener('change', async () => {
  const f = input('j-load').files?.[0];
  const err = $('jurisdiction').querySelector<HTMLElement>('[data-error]')!;
  err.textContent = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j?.format !== 'stop-jurisdiction-1') throw new Error('That is not a settings file saved by this tool.');
    let logo: typeof customLogo = null;
    if (j.logo?.base64) {
      const bytes = fromBase64Text(String(j.logo.base64));
      const png = bytes[0] === 0x89 && bytes[1] === 0x50;
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!png && !jpg) throw new Error('The logo in that settings file is not a PNG or JPG.');
      logo = { bytes, type: png ? 'image/png' : 'image/jpeg' };
    }
    useJurisdiction(j, logo);
  } catch (e) {
    err.textContent = e instanceof SyntaxError ? 'That settings file could not be read.' : (e as Error).message;
  } finally {
    input('j-load').value = '';
  }
});
// About this software: version, build date and changelog, built into the file.
document.querySelectorAll<HTMLElement>('[data-app="version"]').forEach((el) => (el.textContent = __APP_VERSION__));
document.querySelectorAll<HTMLElement>('[data-app="built"]').forEach((el) => (el.textContent = __BUILD_DATE__));
$('changelog-body').replaceChildren(renderChangelog(__CHANGELOG__));
{
  // Credits for the state seals (Wikimedia Commons), as their licenses require.
  const ul = $('seal-credits');
  for (const [state, s] of Object.entries(STATE_SEALS)) {
    const li = document.createElement('li');
    li.append(
      `${state}: `,
      Object.assign(document.createElement('a'), { href: s.source, textContent: s.file, rel: 'noopener' }),
      ` by ${s.author}, ${s.license}${s.insignia ? ' (insignia: use restricted by law)' : ''}.`,
    );
    ul.append(li);
  }
}
$('show-about-software').addEventListener('click', () => {
  showTab('about');
  ($('changelog') as HTMLDetailsElement).open = true;
  $('about-software').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
// Download this tool: a link to this very file. Opened from a saved copy (file://)
// there is nothing to download, and some browsers would just reload the page.
{
  const local = location.protocol === 'file:';
  const name = `${BRAND.name.replace(/\./g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${__APP_VERSION__}.html`;
  // "dl=1" lets the site count downloads (it has no other meaning to the page).
  const base = location.href.split('#')[0];
  const href = `${base}${base.includes('?') ? '&' : '?'}dl=1`;
  document.querySelectorAll<HTMLAnchorElement>('[data-self-download]').forEach((a) => {
    a.href = href;
    a.download = name;
  });
  document.querySelectorAll<HTMLElement>('[data-self-download-wrap]').forEach((el) => (el.hidden = local));
  $('self-download').hidden = local;
  $('self-offline').hidden = !local;
}
if (!input('reg-county').value) input('reg-county').value = BRAND.county;
if (!input('f-county').value) input('f-county').value = BRAND.county;
syncTemplate();

const initial = location.hash.slice(1) as Tab;
const roomLink = !!INVITED_ROOM;
showTab(roomLink ? 'sign' : TABS.includes(initial) ? initial : 'about');
// A room link: offer to join (nothing connects until the person chooses to).
if (roomLink) {
  $('room-invite').hidden = false;
  $('room-invite-top').hidden = false;
}
if (!officialOrigin()) $('room-card').hidden = true;
showRoomConsent();
$('boot').hidden = true;
// After start-up, so a problem with the link's settings stays visible.
settingsFromLink();
askAnalytics();
