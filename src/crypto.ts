// OpenPGP operations. Everything runs locally; nothing here touches the network
// or any storage. Keys live only in memory for as long as the page is open.
import * as openpgp from 'openpgp';
import { canonicalText } from './text';

/** Prefix and version tag of the QR payload: PGPSIG1|FINGERPRINT|SHA256|BASE64SIG */
export const PAYLOAD_PREFIX = 'PGPSIG1';
/** Prefix of the compact public-key QR on the registration form: PGPKEY1|BASE64KEY */
export const PUBKEY_QR_PREFIX = 'PGPKEY1';

export interface KeySummary {
  /** Primary key fingerprint, uppercase hex. This is what the Recorder files. */
  fingerprint: string;
  userIDs: string[];
  created: Date;
  /** Human-readable algorithm, e.g. "Ed25519 (EdDSA)" or "RSA 4096". */
  algorithm: string;
  publicArmored: string;
  hasPrivate: boolean;
  /** True when a private key is present and still passphrase-protected. */
  locked: boolean;
}

export type AnyKey = openpgp.PrivateKey | openpgp.PublicKey;

/**
 * Who signs with a key. Stored in the key's own user ID, so it travels with the
 * key into every registration, document and check:
 *   individual:  "Jane Doe <jane@example.com>"
 *   position:    "Doe Holdings LLC (position: Secretary)"  -- whoever holds the
 *                position signs with this key
 */
export interface KeyIdentity {
  kind: 'individual' | 'position' | 'group';
  /** The person (individual), the entity (position), or the group's name. */
  name: string;
  /** For a position key: the position, e.g. "Secretary", "Trustee". */
  position?: string;
  /** For a group key: every person who must sign, e.g. a married couple. */
  members?: string[];
  email?: string;
}

const POSITION_TAG = 'position: ';
const GROUP_TAG = 'group: ';

/** Splits "Name (comment) <email>" as stored in an OpenPGP user ID. */
function parseUserID(uid: string) {
  const m = /^(.*?)\s*(?:\(([^()]*)\))?\s*(?:<([^<>]*)>)?\s*$/.exec(uid.trim());
  return { name: (m?.[1] ?? uid).trim(), comment: (m?.[2] ?? '').trim(), email: (m?.[3] ?? '').trim() };
}

export function keyIdentity(key: AnyKey): KeyIdentity {
  const { name, comment, email } = parseUserID(key.getUserIDs()[0] ?? '');
  const lc = comment.toLowerCase();
  if (lc.startsWith(POSITION_TAG)) return { kind: 'position', name, position: comment.slice(POSITION_TAG.length).trim(), email: email || undefined };
  if (lc.startsWith(GROUP_TAG)) {
    const members = comment.slice(GROUP_TAG.length).split(';').map((x) => x.trim()).filter(Boolean);
    return { kind: 'group', name, members, email: email || undefined };
  }
  return { kind: 'individual', name, email: email || undefined };
}

/** "Jane Doe", "Secretary, Doe Holdings LLC", or "Jane Doe and John Doe". */
export function describeKey(key: AnyKey) {
  const id = keyIdentity(key);
  if (id.kind === 'position') return `${id.position}, ${id.name}`;
  return id.name;
}

export async function generateKeyPair(opts: { name: string; email?: string; passphrase: string; position?: string; members?: string[] }) {
  const members = (opts.members ?? []).map((x) => x.trim()).filter(Boolean);
  if (opts.members !== undefined) {
    if (members.length < 2) throw new Error('A group key needs at least two people. Enter one name per line.');
    if (members.some((x) => /[;()<>]/.test(x))) throw new Error('Names cannot contain ; ( ) < or >.');
  }
  const name = opts.members !== undefined ? opts.name.trim() || members.join(' and ') : opts.name.trim();
  if (!name) throw new Error(opts.position !== undefined ? 'Enter the entity\u2019s name for the key.' : 'Enter the owner name for the key.');
  if (opts.position !== undefined && !opts.position.trim()) throw new Error('Enter the position that will sign with this key (e.g. Secretary, Trustee).');
  if (/[()<>]/.test(name) || /[()<>]/.test(opts.position ?? '')) throw new Error('Names cannot contain ( ) < or >.');
  const userID: { name: string; email?: string; comment?: string } = { name };
  if (opts.email?.trim()) userID.email = opts.email.trim();
  if (opts.position?.trim()) userID.comment = `${POSITION_TAG}${opts.position.trim()}`;
  if (opts.members !== undefined) userID.comment = `${GROUP_TAG}${members.join('; ')}`;
  const { privateKey, publicKey } = await openpgp.generateKey({
    // v4 Ed25519 keys: widely supported by GnuPG and other OpenPGP software.
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [userID],
    // Signing only, no encryption subkey: keeps the key (and its QR code) small.
    subkeys: [],
    passphrase: opts.passphrase || undefined,
    format: 'armored',
  });
  return { privateArmored: privateKey, publicArmored: publicKey };
}

/** Reads an armored or binary key file. Returns a private key when one is present. */
export async function readAnyKey(data: string | Uint8Array): Promise<AnyKey> {
  const isText = typeof data === 'string' || looksArmored(data);
  const text = typeof data === 'string' ? data : isText ? new TextDecoder().decode(data) : '';
  try {
    const compact = text.replace(/\s+/g, '');
    if (compact.startsWith(`${PUBKEY_QR_PREFIX}|`)) {
      return await openpgp.readKey({ binaryKey: fromBase64(compact.slice(PUBKEY_QR_PREFIX.length + 1)) });
    }
    if (isText) {
      if (/-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(text)) {
        return await openpgp.readPrivateKey({ armoredKey: text });
      }
      if (/-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(text)) {
        return await openpgp.readKey({ armoredKey: text });
      }
      throw new Error('no key block');
    }
    return await openpgp.readKey({ binaryKey: data as Uint8Array });
  } catch {
    throw new Error(
      'That does not look like an OpenPGP key. Use a .asc, .key or .gpg file exported from GnuPG or another OpenPGP program.',
    );
  }
}

function looksArmored(bytes: Uint8Array) {
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  return head.startsWith('-----BEGIN') || head.startsWith(`${PUBKEY_QR_PREFIX}|`);
}

export function isPrivate(key: AnyKey): key is openpgp.PrivateKey {
  return key.isPrivate();
}

export async function unlockKey(key: openpgp.PrivateKey, passphrase: string) {
  if (key.isDecrypted()) return key;
  try {
    return await openpgp.decryptKey({ privateKey: key, passphrase });
  } catch {
    throw new Error('Wrong passphrase. The key is still locked.');
  }
}

/** Re-locks a key with a new passphrase, for downloading a protected copy. */
export async function lockKey(key: openpgp.PrivateKey, passphrase: string) {
  return openpgp.encryptKey({ privateKey: key, passphrase });
}

export function summarize(key: AnyKey): KeySummary {
  const pub = key.toPublic();
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    userIDs: key.getUserIDs(),
    created: key.getCreationTime(),
    algorithm: describeAlgorithm(key.getAlgorithmInfo()),
    publicArmored: pub.armor(),
    hasPrivate: key.isPrivate(),
    locked: key.isPrivate() ? !(key as openpgp.PrivateKey).isDecrypted() : false,
  };
}

function describeAlgorithm(info: { algorithm: string; bits?: number; curve?: string }) {
  switch (info.algorithm) {
    case 'eddsaLegacy':
    case 'ed25519':
      return 'Ed25519 (OpenPGP signing key)';
    case 'ed448':
      return 'Ed448 (OpenPGP signing key)';
    case 'rsaEncryptSign':
    case 'rsaSign':
      return `RSA ${info.bits ?? ''} (OpenPGP signing key)`.replace('  ', ' ');
    case 'ecdsa':
      return `ECDSA ${info.curve ?? ''} (OpenPGP signing key)`;
    default:
      return info.algorithm;
  }
}

export function formatFingerprint(fpr: string) {
  return fpr.toUpperCase().replace(/(.{4})(?!$)/g, '$1 ');
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The short document ID printed as a Code 128 barcode: first 24 hex digits of the hash. */
export function documentId(sha256: string) {
  return sha256.slice(0, 24).toUpperCase();
}

export interface SignedDocument {
  fingerprint: string;
  userID: string;
  sha256: string;
  documentId: string;
  signedAt: Date;
  /** Binary detached OpenPGP signature over the exact document bytes. */
  signature: Uint8Array;
  armoredSignature: string;
  /** Text carried by the QR code. */
  payload: string;
}

/**
 * Creates a standard detached OpenPGP signature over the document bytes.
 * It verifies with `gpg --verify document.sig document`.
 */
export async function signDocument(key: openpgp.PrivateKey, document: Uint8Array): Promise<SignedDocument> {
  if (!key.isDecrypted()) throw new Error('Unlock the private key with its passphrase first.');
  const message = await openpgp.createMessage({ binary: document });
  const signature = (await openpgp.sign({
    message,
    signingKeys: key,
    detached: true,
    format: 'binary',
  })) as Uint8Array;
  const sigObj = await openpgp.readSignature({ binarySignature: signature });
  const sha256 = await sha256Hex(document);
  const fingerprint = key.getFingerprint().toUpperCase();
  const signedAt = sigObj.packets[0]?.created ?? new Date();
  return {
    fingerprint,
    userID: key.getUserIDs()[0] ?? '',
    sha256,
    documentId: documentId(sha256),
    signedAt,
    signature,
    armoredSignature: sigObj.armor(),
    payload: buildPayload(fingerprint, sha256, signature),
  };
}

export function buildPayload(fingerprint: string, sha256: string, signature: Uint8Array) {
  return [PAYLOAD_PREFIX, fingerprint.toUpperCase(), sha256.toLowerCase(), toBase64(signature)].join('|');
}

export interface ParsedPayload {
  fingerprint: string;
  sha256: string;
  signature: Uint8Array;
}

export function parsePayload(text: string): ParsedPayload {
  // Handheld scanners may add a trailing Enter or wrap lines; strip all whitespace.
  const parts = text.replace(/\s+/g, '').split('|');
  if (parts.length !== 4 || parts[0] !== PAYLOAD_PREFIX) {
    throw new Error(`Not a signature code. Expected text starting with "${PAYLOAD_PREFIX}|".`);
  }
  const [, fingerprint, sha256, sig] = parts;
  if (!/^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$/.test(fingerprint)) throw new Error('The key fingerprint in the code is malformed.');
  if (!/^[0-9A-Fa-f]{64}$/.test(sha256)) throw new Error('The document hash in the code is malformed.');
  let signature: Uint8Array;
  try {
    signature = fromBase64(sig);
  } catch {
    throw new Error('The signature in the code is not valid base64.');
  }
  if (signature.length < 32) throw new Error('The signature in the code is too short.');
  return { fingerprint: fingerprint.toUpperCase(), sha256: sha256.toLowerCase(), signature };
}

export type CheckState = 'pass' | 'fail' | 'skipped';
export interface Check {
  label: string;
  state: CheckState;
  detail: string;
}
export type Verdict = 'good' | 'bad' | 'incomplete';
export interface VerifyResult {
  verdict: Verdict;
  checks: Check[];
  signedAt?: Date;
  documentId?: string;
}

/**
 * Recorder-side check of a filing against the key registered for the parcel.
 * `document` is optional: without it the fingerprint can be compared, but the
 * signature itself can only be checked against the exact signed file.
 */
export async function verifyFiling(input: {
  payload: string;
  registeredKey: AnyKey;
  document?: Uint8Array;
}): Promise<VerifyResult> {
  const checks: Check[] = [];
  let parsed: ParsedPayload;
  try {
    parsed = parsePayload(input.payload);
    checks.push({ label: 'Signature code readable', state: 'pass', detail: 'Code has the expected format.' });
  } catch (e) {
    checks.push({ label: 'Signature code readable', state: 'fail', detail: (e as Error).message });
    return { verdict: 'bad', checks };
  }
  const result: VerifyResult = { verdict: 'incomplete', checks, documentId: documentId(parsed.sha256) };

  const registered = input.registeredKey.getFingerprint().toUpperCase();
  const fprMatches = parsed.fingerprint === registered;
  checks.push({
    label: 'Signed by the registered key',
    state: fprMatches ? 'pass' : 'fail',
    detail: fprMatches
      ? `Fingerprint ${formatFingerprint(registered)} matches the key on file.`
      : `Code names key ${formatFingerprint(parsed.fingerprint)}, but the key on file is ${formatFingerprint(registered)}.`,
  });

  let sigObj: openpgp.Signature | undefined;
  try {
    sigObj = await openpgp.readSignature({ binarySignature: parsed.signature });
    result.signedAt = sigObj.packets[0]?.created ?? undefined;
  } catch {
    checks.push({ label: 'Signature valid', state: 'fail', detail: 'The signature data is damaged or not an OpenPGP signature.' });
  }

  if (!input.document) {
    checks.push({
      label: 'Document matches code',
      state: 'skipped',
      detail: 'Load the filed document file to compare its hash with the code.',
    });
    if (sigObj) {
      checks.push({
        label: 'Signature valid',
        state: 'skipped',
        detail: 'The signature can only be checked against the exact document file that was signed.',
      });
    }
  } else {
    const actual = await sha256Hex(input.document);
    const hashMatches = actual === parsed.sha256;
    checks.push({
      label: 'Document matches code',
      state: hashMatches ? 'pass' : 'fail',
      detail: hashMatches
        ? `SHA-256 ${actual.slice(0, 16)}... matches.`
        : `This file's SHA-256 starts ${actual.slice(0, 16)}..., the code says ${parsed.sha256.slice(0, 16)}.... The file is different from the one signed (edited, re-saved, or a print copy).`,
    });
    if (sigObj) {
      let ok = false;
      let why = '';
      try {
        const verification = await openpgp.verify({
          message: await openpgp.createMessage({ binary: input.document }),
          signature: sigObj,
          verificationKeys: input.registeredKey.toPublic(),
          expectSigned: false,
        });
        const first = verification.signatures[0];
        if (first) {
          await first.verified;
          ok = true;
        } else {
          why = 'No signature found.';
        }
      } catch (e) {
        why = (e as Error).message.replace(/^Error: /, '');
      }
      checks.push({
        label: 'Signature valid',
        state: ok ? 'pass' : 'fail',
        detail: ok ? 'Cryptographic signature checks out against the registered key.' : `Signature does not verify: ${why}`,
      });
    }
  }

  if (checks.some((c) => c.state === 'fail')) result.verdict = 'bad';
  else if (checks.some((c) => c.state === 'skipped')) result.verdict = 'incomplete';
  else result.verdict = 'good';
  return result;
}

export function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Signing document TEXT (the paper workflow), by one owner or several
//
// The signature covers the canonical text of the document (see text.ts), so it
// can be checked from paper. Several owners can sign the same text; their
// standard detached OpenPGP signatures are simply concatenated. The QR codes
// printed on the document carry the signatures AND the signed text itself
// (compressed), split across as many codes as needed:
//
//   one signer:     PGPDOC1|FINGERPRINT|BASE64SIG|z|BASE64(deflate-raw(text))
//   several:        PGPDOC2|FPR1,FPR2,...|BASE64(SIG1 SIG2 ...)|z|BASE64(...)
//                   ("t" instead of "z" means the text is not compressed)
//   each QR code:   PGPQ1|GROUP|i/n|CHUNK   (GROUP = first 12 hex of the text's SHA-256)
//
// The recovered text is a plain file: `gpg --verify document.sig document.txt`
// checks every signature when document.txt holds exactly the canonical text.
// ---------------------------------------------------------------------------

export const DOC_PREFIX = 'PGPDOC1';
export const MULTI_DOC_PREFIX = 'PGPDOC2';
export const PART_PREFIX = 'PGPQ1';
/** Characters of the message per QR code. Small codes (about version 14) read reliably from scans and photos at any resolution; big dense ones do not. */
export const PART_SIZE = 320;
/** Longest canonical text accepted, to keep the number of codes reasonable. */
export const MAX_TEXT = 30000;

export interface DocSignature {
  fingerprint: string;
  userID: string;
  signedAt: Date;
  /** One standard detached OpenPGP signature. */
  bytes: Uint8Array;
}

export interface SignedText {
  canonical: string;
  sha256: string;
  documentId: string;
  /** Every signature so far, in signing order. */
  signatures: DocSignature[];
  /** All signatures concatenated: a valid detached signature file for gpg. */
  signature: Uint8Array;
  /** First signer (kept for single-owner callers). */
  fingerprint: string;
  userID: string;
  signedAt: Date;
  /** Text for each QR code, in order. */
  codes: string[];
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function concatBytes(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Builds the full signed-document record from the text and its signatures. */
export async function assembleSigned(canonical: string, signatures: DocSignature[]): Promise<SignedText> {
  const sha256 = await sha256Hex(new TextEncoder().encode(canonical));
  const signature = concatBytes(signatures.map((s) => s.bytes));
  return {
    canonical,
    sha256,
    documentId: documentId(sha256),
    signatures,
    signature,
    fingerprint: signatures[0]?.fingerprint ?? '',
    userID: signatures[0]?.userID ?? '',
    signedAt: signatures[0]?.signedAt ?? new Date(),
    codes: signatures.length ? await encodeCodes(signatures.map((s) => s.fingerprint), signature, canonical, sha256) : [],
  };
}

/**
 * Signs the text with one key. Pass `existing` to add another owner's signature
 * to a document already signed by others; the text must be exactly the same.
 */
export async function signText(key: openpgp.PrivateKey, text: string, existing?: SignedText): Promise<SignedText> {
  if (!key.isDecrypted()) throw new Error('Unlock the private key with its passphrase first.');
  const canonical = existing ? existing.canonical : canonicalText(text);
  if (existing && canonicalText(text) !== existing.canonical) {
    throw new Error('The text is different from the text the other owners signed. Everyone must sign exactly the same text.');
  }
  if (!canonical) throw new Error('There is no document text to sign.');
  if (canonical.length > MAX_TEXT) throw new Error(`The document is too long (${canonical.length} characters; the limit is ${MAX_TEXT}).`);
  const fingerprint = key.getFingerprint().toUpperCase();
  if (existing?.signatures.some((s) => s.fingerprint === fingerprint)) throw new Error('This key has already signed this document.');
  const bytes = (await openpgp.sign({
    message: await openpgp.createMessage({ binary: new TextEncoder().encode(canonical) }),
    signingKeys: key,
    detached: true,
    format: 'binary',
  })) as Uint8Array;
  const sigObj = await openpgp.readSignature({ binarySignature: bytes });
  const sig: DocSignature = {
    fingerprint,
    userID: key.getUserIDs()[0] ?? '',
    signedAt: sigObj.packets[0]?.created ?? new Date(),
    bytes,
  };
  return assembleSigned(canonical, [...(existing?.signatures ?? []), sig]);
}

export async function encodeCodes(fingerprints: string | string[], signature: Uint8Array, canonical: string, sha256: string) {
  const fprs = Array.isArray(fingerprints) ? fingerprints : [fingerprints];
  const raw = new TextEncoder().encode(canonical);
  let enc = 't';
  let body = raw;
  if (typeof CompressionStream !== 'undefined') {
    const z = await pipeBytes(raw, new CompressionStream('deflate-raw'));
    if (z.length < raw.length) {
      enc = 'z';
      body = z;
    }
  }
  const prefix = fprs.length === 1 ? DOC_PREFIX : MULTI_DOC_PREFIX;
  const message = [prefix, fprs.join(','), toBase64(signature), enc, toBase64(body)].join('|');
  const group = sha256.slice(0, 12).toUpperCase();
  const n = Math.ceil(message.length / PART_SIZE);
  return Array.from({ length: n }, (_, i) => `${PART_PREFIX}|${group}|${i + 1}/${n}|${message.slice(i * PART_SIZE, (i + 1) * PART_SIZE)}`);
}

export interface ScanProgress {
  /** Distinct documents seen (normally 1). */
  groups: string[];
  have: number;
  total: number;
  missing: number[];
}

/** Reads whatever has been scanned so far (one code per line, any order, duplicates fine). */
export function scanProgress(scanned: string, prefix = PART_PREFIX): ScanProgress {
  const parts = parseParts(scanned, prefix);
  const groups = [...new Set(parts.map((p) => p.group))];
  const total = parts[0]?.total ?? 0;
  const have = new Set(parts.filter((p) => p.group === groups[0]).map((p) => p.index));
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);
  return { groups, have: have.size, total, missing };
}

interface Part {
  group: string;
  index: number;
  total: number;
  chunk: string;
}

function parseParts(scanned: string, prefix = PART_PREFIX): Part[] {
  const out: Part[] = [];
  // A scanner usually ends each code with Enter; also accept codes run together.
  const re = new RegExp(`${prefix}\\|([0-9A-F]{12})\\|(\\d{1,3})\\/(\\d{1,3})\\|([A-Za-z0-9+/=|,tz]*?)(?=${prefix}\\||\\s|$)`, 'g');
  for (const m of scanned.replace(/\r/g, '\n').matchAll(re)) {
    const index = Number(m[2]);
    const total = Number(m[3]);
    if (index >= 1 && index <= total) out.push({ group: m[1], index, total, chunk: m[4] });
  }
  return out;
}

function joinParts(scanned: string, prefix: string, what: string) {
  const parts = parseParts(scanned, prefix);
  const p = scanProgress(scanned, prefix);
  if (p.groups.length > 1) throw new Error(`These codes come from more than one ${what}. Use one ${what} at a time.`);
  if (p.missing.length) throw new Error(`Read ${p.have} of ${p.total} codes. Still missing code ${p.missing.join(', ')}.`);
  const byIndex = new Map(parts.map((x) => [x.index, x.chunk]));
  return { message: Array.from({ length: p.total }, (_, i) => byIndex.get(i + 1)!).join(''), group: p.groups[0] };
}

export interface DecodedText {
  /** Fingerprints listed in the codes, one per signature. */
  fingerprints: string[];
  /** First listed fingerprint (single-owner documents). */
  fingerprint: string;
  /** All signatures, concatenated. */
  signature: Uint8Array;
  canonical: string;
  sha256: string;
  documentId: string;
}

const FPR_RE = /^[0-9A-F]{40}([0-9A-F]{24})?$/;

/** Reassembles the scanned codes into the signed text and its signatures. */
export async function decodeCodes(scanned: string): Promise<DecodedText> {
  if (!parseParts(scanned).length) throw new Error('No document signature codes found. Scan the QR codes on the signature page; they start with PGPQ1|.');
  const { message, group } = joinParts(scanned, PART_PREFIX, 'document');
  const f = message.split('|');
  const fprs = (f[1] ?? '').split(',');
  if (f.length !== 5 || (f[0] !== DOC_PREFIX && f[0] !== MULTI_DOC_PREFIX) || !fprs.every((x) => FPR_RE.test(x)) || !/^[zt]$/.test(f[3])) {
    throw new Error('The codes are damaged or incomplete. Try scanning them again.');
  }
  let signature: Uint8Array;
  let body: Uint8Array;
  try {
    signature = fromBase64(f[2]);
    body = fromBase64(f[4]);
    if (f[3] === 'z') body = await pipeBytes(body, new DecompressionStream('deflate-raw'));
  } catch {
    throw new Error('The codes are damaged. Try scanning them again.');
  }
  if (body.length > MAX_TEXT * 4) throw new Error('The text in the codes is too long.');
  const canonical = new TextDecoder().decode(body);
  const sha256 = await sha256Hex(body);
  if (!sha256.toUpperCase().startsWith(group)) {
    throw new Error('The codes do not fit together (the text does not match the document ID). Scan one document at a time.');
  }
  return { fingerprints: fprs, fingerprint: fprs[0], signature, canonical, sha256, documentId: documentId(sha256) };
}

/** Splits decoded codes back into one record per signature (to continue signing, or to list signers). */
export async function signedFromCodes(scanned: string): Promise<SignedText> {
  const d = await decodeCodes(scanned);
  const sigObj = await openpgp.readSignature({ binarySignature: d.signature });
  const signatures: DocSignature[] = sigObj.packets.map((packet, i) => {
    const list = new openpgp.PacketList<openpgp.SignaturePacket>();
    list.push(packet as openpgp.SignaturePacket);
    const issuer = (packet as openpgp.SignaturePacket).issuerFingerprint;
    return {
      fingerprint: issuer ? bytesToHex(issuer) : (d.fingerprints[i] ?? ''),
      userID: '',
      signedAt: (packet as openpgp.SignaturePacket).created ?? new Date(),
      bytes: list.write(),
    };
  });
  return assembleSigned(d.canonical, signatures);
}

function bytesToHex(b: Uint8Array) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ---------------------------------------------------------------------------
// Parcel registration: the keys registered for one parcel
//
// Each owner files their own registration form for each parcel. Every form
// carries the parcel's complete key list (the "configuration"); every key on it
// must sign. Printed as codes, and embedded in the PDF:
//   whole message:  PGPREG1|BASE64(parcel)|ALL|BASE64(public keys, concatenated)
//   each QR code:   PGPR1|GROUP|i/n|CHUNK
// ---------------------------------------------------------------------------
export const REG_PREFIX = 'PGPREG1';
export const REG_PART_PREFIX = 'PGPR1';

export interface Registration {
  /** Parcel number as written on the form; empty when only bare keys were loaded. */
  parcel: string;
  /** Every key registered for the parcel. All must sign. */
  keys: openpgp.PublicKey[];
  /**
   * Optional free description of each key, in the same order (e.g. "Trustee",
   * "Beneficiary"). Owners may use one key for everyone or several, described
   * however they like; a person at the Recorder judges the structure.
   */
  labels?: string[];
  /**
   * Proof of key possession: every listed key's signature over this
   * registration's statement (see registrationStatement). Only someone with the
   * private key and its passphrase can make it.
   */
  proof?: SignedText;
}

/**
 * The statement every key holder signs when registering, proving they hold the
 * key and passphrase. Keys are listed in fingerprint order so every holder,
 * on any computer, signs exactly the same text.
 */
export function registrationStatement(reg: { parcel: string; keys: AnyKey[] }) {
  const keys = [...reg.keys].sort((x, y) => x.getFingerprint().localeCompare(y.getFingerprint()));
  return [
    'S.T.O.P. PARCEL KEY REGISTRATION.',
    `PARCEL NUMBER: ${reg.parcel.trim()}.`,
    'EVERY KEY LISTED BELOW MUST SIGN ANY INSTRUMENT AFFECTING THIS PARCEL.',
    'BY SIGNING THIS STATEMENT, EACH KEY HOLDER CONFIRMS THEY HOLD THE KEY AND ITS PASSPHRASE.',
    ...keys.map((k, i) => `KEY ${i + 1}: ${k.getFingerprint().toUpperCase()} ${describeKey(k)}.`),
  ].join('\n');
}

/** Signs a registration's statement with one key (adding to signatures made by the other key holders). */
export async function signRegistration(key: openpgp.PrivateKey, reg: Registration): Promise<SignedText> {
  const me = key.getFingerprint().toUpperCase();
  if (!reg.keys.some((k) => k.getFingerprint().toUpperCase() === me)) {
    throw new Error('This key is not listed on the registration, so it cannot sign it.');
  }
  return signText(key, registrationStatement(reg), reg.proof);
}

export interface ProofStatus {
  /** Every listed key made a valid signature over this registration's statement. */
  complete: boolean;
  signed: string[];
  missing: string[];
  problems: string[];
}

/** Checks the proof of key possession against the registration's own keys and statement. */
export async function checkRegistrationProof(reg: Registration): Promise<ProofStatus> {
  const all = reg.keys.map((k) => k.getFingerprint().toUpperCase());
  if (!reg.proof) return { complete: false, signed: [], missing: all, problems: [] };
  const problems: string[] = [];
  if (reg.proof.canonical !== canonicalText(registrationStatement(reg))) {
    problems.push('The proof was signed for a different parcel or key list.');
  }
  const r = await verifyScannedText({ scanned: reg.proof.codes.join('\n'), registration: { parcel: '', keys: reg.keys } });
  const signed = (r.signers ?? []).filter((x) => x.registered && x.state === 'pass').map((x) => x.fingerprint);
  for (const x of r.signers ?? []) if (!x.registered) problems.push('A key not on the registration signed it.');
  for (const x of r.signers ?? []) if (x.registered && x.state === 'fail' && !/No signature/.test(x.detail)) problems.push(x.detail);
  const missing = all.filter((f) => !signed.includes(f));
  return { complete: !problems.length && !missing.length, signed, missing, problems };
}

/** Description of a registered key, if the registration gives one. */
export function keyLabel(reg: Registration | null | undefined, fingerprint: string) {
  const i = reg ? reg.keys.findIndex((k) => k.getFingerprint().toUpperCase() === fingerprint.toUpperCase()) : -1;
  if (!reg || i < 0) return '';
  return (reg.labels?.[i] ?? '').trim();
}

export function parcelKey(parcel: string) {
  return parcel.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export async function encodeRegistrationCodes(reg: Registration): Promise<string[]> {
  const keys = concatBytes(reg.keys.map((k) => k.toPublic().write()));
  const fields = [REG_PREFIX, toBase64(new TextEncoder().encode(reg.parcel.trim())), 'ALL', toBase64(keys)];
  if (reg.labels?.some((l) => l.trim())) fields.push(toBase64(new TextEncoder().encode(JSON.stringify(reg.labels.map((l) => l.trim())))));
  const message = fields.join('|');
  const group = (await sha256Hex(new TextEncoder().encode(message))).slice(0, 12).toUpperCase();
  const n = Math.ceil(message.length / PART_SIZE);
  return Array.from({ length: n }, (_, i) => `${REG_PART_PREFIX}|${group}|${i + 1}/${n}|${message.slice(i * PART_SIZE, (i + 1) * PART_SIZE)}`);
}

export function registrationScanProgress(scanned: string) {
  return scanProgress(scanned, REG_PART_PREFIX);
}

export async function decodeRegistrationCodes(scanned: string): Promise<Registration> {
  const { message, group } = joinParts(scanned, REG_PART_PREFIX, 'registration');
  if (!(await sha256Hex(new TextEncoder().encode(message))).toUpperCase().startsWith(group)) {
    throw new Error('The registration codes are damaged. Try another photo or scan.');
  }
  const f = message.split('|');
  if ((f.length !== 4 && f.length !== 5) || f[0] !== REG_PREFIX) throw new Error('The registration codes are damaged. Try another photo or scan.');
  const parcel = new TextDecoder().decode(fromBase64(f[1]));
  const keys = await openpgp.readKeys({ binaryKeys: fromBase64(f[3]) });
  let labels: string[] | undefined;
  if (f[4]) {
    try {
      labels = (JSON.parse(new TextDecoder().decode(fromBase64(f[4]))) as unknown[]).map((x) => String(x ?? ''));
    } catch {
      labels = undefined;
    }
  }
  return { parcel, keys: keys.map((k) => k.toPublic()), labels };
}

/** Merges registrations (e.g. each co-owner's form). They must agree on the parcel and key list. */
export function mergeRegistrations(regs: Registration[]): Registration {
  if (!regs.length) throw new Error('No registration loaded.');
  const withParcel = regs.filter((r) => r.parcel);
  const parcels = [...new Set(withParcel.map((r) => parcelKey(r.parcel)))];
  if (parcels.length > 1) throw new Error(`These registrations are for different parcels (${withParcel.map((r) => r.parcel).join(', ')}). Load one parcel at a time.`);
  const keysets = regs.filter((r) => r.parcel).map((r) => r.keys.map((k) => k.getFingerprint().toUpperCase()).sort().join(','));
  if (new Set(keysets).size > 1) {
    throw new Error('These registrations list different keys for the same parcel. Every owner’s form must list the same keys; ask the Recorder which is current.');
  }
  const keys = new Map<string, openpgp.PublicKey>();
  const labels = new Map<string, string>();
  for (const r of regs) {
    r.keys.forEach((k, i) => {
      const fpr = k.getFingerprint().toUpperCase();
      keys.set(fpr, k.toPublic());
      const l = r.labels?.[i]?.trim();
      if (l && !labels.has(fpr)) labels.set(fpr, l);
    });
  }
  const list = [...keys.entries()];
  const proof = regs
    .map((r) => r.proof)
    .filter((x): x is SignedText => !!x)
    .sort((x, y) => y.signatures.length - x.signatures.length)[0];
  return {
    parcel: withParcel[0]?.parcel ?? '',
    keys: list.map(([, k]) => k),
    labels: labels.size ? list.map(([f]) => labels.get(f) ?? '') : undefined,
    proof,
  };
}

// ---------------------------------------------------------------------------
// Checking a paper filing against the parcel registration
// ---------------------------------------------------------------------------
export interface SignerResult {
  fingerprint: string;
  userID: string;
  /** The registration's description of this key, if any. */
  label: string;
  registered: boolean;
  state: CheckState;
  signedAt?: Date;
  detail: string;
}

export interface TextVerifyResult extends VerifyResult {
  /** The exact text the owners signed, recovered from the codes. */
  signedText?: string;
  /** One line per registered key, plus any signature from a key that is not registered. */
  signers?: SignerResult[];
}

/**
 * Recorder-side check of a paper filing: every key registered for the parcel
 * must have signed, every signature must be valid, all of them over the same
 * text, and the text must name the registered parcel.
 */
export async function verifyScannedText(input: {
  scanned: string;
  registration?: Registration;
  /** Shorthand for a registration with one key and no parcel. */
  registeredKey?: AnyKey;
}): Promise<TextVerifyResult> {
  const reg: Registration = input.registration ?? { parcel: '', keys: input.registeredKey ? [input.registeredKey.toPublic()] : [] };
  const checks: Check[] = [];
  let d: DecodedText;
  try {
    d = await decodeCodes(input.scanned);
    checks.push({ label: 'All signature codes read', state: 'pass', detail: 'The signed text and signatures were recovered from the codes.' });
  } catch (e) {
    const progress = scanProgress(input.scanned);
    const partial = progress.total > 0 && progress.missing.length > 0 && progress.groups.length === 1;
    checks.push({ label: 'All signature codes read', state: partial ? 'skipped' : 'fail', detail: (e as Error).message });
    return { verdict: partial ? 'incomplete' : 'bad', checks };
  }

  // Verify every signature packet against all registered keys at once.
  const results: { keyHex: string; ok: boolean; why: string; signedAt?: Date }[] = [];
  try {
    const sigObj = await openpgp.readSignature({ binarySignature: d.signature });
    const v = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(d.canonical) }),
      signature: sigObj,
      verificationKeys: reg.keys,
      expectSigned: false,
    });
    for (const s of v.signatures) {
      let ok = false;
      let why = '';
      let signedAt: Date | undefined;
      try {
        await s.verified;
        ok = true;
      } catch (e) {
        why = (e as Error).message.replace(/^Error: /, '');
      }
      try {
        signedAt = (await s.signature).packets[0]?.created ?? undefined;
      } catch {
        /* ignore */
      }
      results.push({ keyHex: s.keyID.toHex().toUpperCase(), ok, why, signedAt });
    }
  } catch (e) {
    checks.push({ label: 'Signatures readable', state: 'fail', detail: `The signature data is damaged: ${(e as Error).message}` });
    return { verdict: 'bad', checks, documentId: d.documentId, signedText: d.canonical };
  }

  const signers: SignerResult[] = [];
  const used = new Set<number>();
  for (const key of reg.keys) {
    const fpr = key.getFingerprint().toUpperCase();
    const ids = [key, ...key.getSubkeys()].map((k) => k.getKeyID().toHex().toUpperCase());
    const idx = results.findIndex((r, i) => !used.has(i) && ids.includes(r.keyHex));
    const uid = describeKey(key);
    const label = keyLabel(reg, fpr);
    if (idx < 0) {
      signers.push({ fingerprint: fpr, userID: uid, label, registered: true, state: 'fail', detail: 'No signature from this registered key.' });
      continue;
    }
    used.add(idx);
    const r = results[idx];
    signers.push({
      fingerprint: fpr,
      userID: uid,
      label,
      registered: true,
      state: r.ok ? 'pass' : 'fail',
      signedAt: r.signedAt,
      detail: r.ok ? 'Valid signature over the text below.' : `Signature does not verify: ${r.why}`,
    });
  }
  results.forEach((r, i) => {
    if (used.has(i)) return;
    const listed = d.fingerprints.find((f) => f.endsWith(r.keyHex));
    signers.push({
      fingerprint: listed ?? r.keyHex,
      userID: '',
      label: '',
      registered: false,
      state: 'fail',
      signedAt: r.signedAt,
      detail: 'Signed by a key that is not registered for this parcel.',
    });
  });

  for (const s of signers) {
    checks.push({
      label: s.registered
        ? `Signed by ${s.userID || 'registered key'}${s.label && s.label !== s.userID ? ` (${s.label})` : ''}`
        : 'Unregistered signer',
      state: s.state,
      detail: `${formatFingerprint(s.fingerprint)}: ${s.detail}`,
    });
  }
  if (!reg.keys.length) checks.push({ label: 'Registered keys', state: 'fail', detail: 'No registered key was loaded for the parcel.' });

  const valid = signers.filter((s) => s.state === 'pass').length;
  if (valid > 1) {
    checks.push({
      label: 'Same text for every signer',
      state: signers.every((s) => s.state === 'pass') ? 'pass' : 'fail',
      detail: `${valid} owners signed exactly the same text (document ID ${d.documentId}).`,
    });
  }
  if (reg.parcel) {
    const inText = parcelKey(d.canonical).includes(parcelKey(reg.parcel));
    checks.push({
      label: 'Parcel number in the signed text',
      state: inText ? 'pass' : 'fail',
      detail: inText
        ? `The signed text names parcel ${reg.parcel}.`
        : `The signed text does not mention the registered parcel ${reg.parcel}. These signatures may belong to a document for a different property.`,
    });
  }
  const verdict: Verdict = checks.some((c) => c.state === 'fail') ? 'bad' : 'good';
  const first = signers.find((s) => s.signedAt)?.signedAt;
  return { verdict, checks, signedAt: first, documentId: d.documentId, signedText: d.canonical, signers };
}

// ---------------------------------------------------------------------------
// Private key as printed QR codes
//
// The printed private key PDF carries the (passphrase-protected) key as a few
// small codes, so it can be loaded back from a phone photo or a scan:
//   PGPK1|GROUP|i/n|CHUNK   where the chunks join into base64(binary key)
// and GROUP is the first 12 hex digits of the key's SHA-256.
// ---------------------------------------------------------------------------
export const KEY_PART_PREFIX = 'PGPK1';

export async function encodeKeyCodes(key: AnyKey): Promise<string[]> {
  const binary = key.write();
  const group = (await sha256Hex(binary)).slice(0, 12).toUpperCase();
  const message = toBase64(binary);
  const n = Math.ceil(message.length / PART_SIZE);
  return Array.from(
    { length: n },
    (_, i) => `${KEY_PART_PREFIX}|${group}|${i + 1}/${n}|${message.slice(i * PART_SIZE, (i + 1) * PART_SIZE)}`,
  );
}

export function keyScanProgress(scanned: string) {
  return scanProgress(scanned, KEY_PART_PREFIX);
}

/**
 * Finds a key in codes read from a photo or scan: the private key PDF's key
 * codes, the registration form's public key code, or an older single code
 * holding a whole armored key.
 */
export async function keyFromCodes(codes: string[]): Promise<AnyKey> {
  const joined = codes.join('\n');
  const parts = parseParts(joined, KEY_PART_PREFIX);
  if (parts.length) {
    const p = keyScanProgress(joined);
    if (p.groups.length > 1) throw new Error('Codes from more than one key were found. Use one key page at a time.');
    if (p.missing.length) {
      throw new Error(`Read ${p.have} of ${p.total} key codes; code ${p.missing.join(', ')} could not be read. Try a sharper, well-lit photo of the whole page.`);
    }
    const byIndex = new Map(parts.map((x) => [x.index, x.chunk]));
    const binary = fromBase64(Array.from({ length: p.total }, (_, i) => byIndex.get(i + 1)!).join(''));
    if (!(await sha256Hex(binary)).toUpperCase().startsWith(p.groups[0])) {
      throw new Error('The key codes are damaged. Try another photo or scan.');
    }
    return readAnyKey(binary);
  }
  const whole = codes.find((c) => /-----BEGIN PGP (PRIVATE|PUBLIC) KEY BLOCK-----/.test(c)) ?? codes.find((c) => c.replace(/\s+/g, '').startsWith(`${PUBKEY_QR_PREFIX}|`));
  if (whole) return readAnyKey(whole);
  throw new Error(
    codes.length
      ? 'QR codes were found, but none hold a key. Photograph the private key page, or page 2 of the registration form.'
      : 'No QR codes found. Make sure the whole key page is in the photo, sharp and well lit.',
  );
}

/** True once the codes read so far contain a complete key, so reading can stop. */
export function codesHaveKey(codes: string[]) {
  const joined = codes.join('\n');
  const p = keyScanProgress(joined);
  if (p.total > 0) return p.missing.length === 0 && p.groups.length === 1;
  return codes.some((c) => /-----BEGIN PGP (PRIVATE|PUBLIC) KEY BLOCK-----/.test(c) || c.replace(/\s+/g, '').startsWith(`${PUBKEY_QR_PREFIX}|`));
}

/** The signature codes from a scan, one per part, in order (for reprinting). */
export function orderedCodes(scanned: string): string[] {
  const parts = parseParts(scanned);
  const group = parts[0]?.group;
  const byIndex = new Map(parts.filter((p) => p.group === group).map((p) => [p.index, p]));
  return [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((p) => `${PART_PREFIX}|${p.group}|${p.index}/${p.total}|${p.chunk}`);
}
