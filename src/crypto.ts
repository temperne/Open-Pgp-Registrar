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

export async function generateKeyPair(opts: { name: string; email?: string; passphrase: string }) {
  if (!opts.name.trim()) throw new Error('Enter the owner name for the key.');
  const userID: { name: string; email?: string } = { name: opts.name.trim() };
  if (opts.email?.trim()) userID.email = opts.email.trim();
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
// Signing document TEXT (the paper workflow)
//
// The signature covers the canonical text of the document (see text.ts), so it
// can be checked from paper. The QR codes printed on the document carry the
// signature AND the signed text itself (compressed), split across as many codes
// as needed:
//
//   whole message:  PGPDOC1|FINGERPRINT|BASE64SIG|z|BASE64(deflate-raw(text))
//                   ("t" instead of "z" means the text is not compressed)
//   each QR code:   PGPQ1|GROUP|i/n|CHUNK   (GROUP = first 12 hex of the text's SHA-256)
//
// The recovered text is a plain file: `gpg --verify document.sig document.txt`
// works when document.txt holds exactly the canonical text (no trailing newline).
// ---------------------------------------------------------------------------

export const DOC_PREFIX = 'PGPDOC1';
export const PART_PREFIX = 'PGPQ1';
/** Characters of the message per QR code. Keeps each code small enough to scan easily from paper. */
export const PART_SIZE = 700;
/** Longest canonical text accepted, to keep the number of codes reasonable. */
export const MAX_TEXT = 30000;

export interface SignedText {
  fingerprint: string;
  userID: string;
  canonical: string;
  sha256: string;
  documentId: string;
  signedAt: Date;
  signature: Uint8Array;
  /** Text for each QR code, in order. */
  codes: string[];
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function signText(key: openpgp.PrivateKey, text: string): Promise<SignedText> {
  if (!key.isDecrypted()) throw new Error('Unlock the private key with its passphrase first.');
  const canonical = canonicalText(text);
  if (!canonical) throw new Error('There is no document text to sign.');
  if (canonical.length > MAX_TEXT) throw new Error(`The document is too long (${canonical.length} characters; the limit is ${MAX_TEXT}).`);
  const bytes = new TextEncoder().encode(canonical);
  const signature = (await openpgp.sign({
    message: await openpgp.createMessage({ binary: bytes }),
    signingKeys: key,
    detached: true,
    format: 'binary',
  })) as Uint8Array;
  const sigObj = await openpgp.readSignature({ binarySignature: signature });
  const sha256 = await sha256Hex(bytes);
  const fingerprint = key.getFingerprint().toUpperCase();
  return {
    fingerprint,
    userID: key.getUserIDs()[0] ?? '',
    canonical,
    sha256,
    documentId: documentId(sha256),
    signedAt: sigObj.packets[0]?.created ?? new Date(),
    signature,
    codes: await encodeCodes(fingerprint, signature, canonical, sha256),
  };
}

export async function encodeCodes(fingerprint: string, signature: Uint8Array, canonical: string, sha256: string) {
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
  const message = [DOC_PREFIX, fingerprint, toBase64(signature), enc, toBase64(body)].join('|');
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
export function scanProgress(scanned: string): ScanProgress {
  const parts = parseParts(scanned);
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

function parseParts(scanned: string): Part[] {
  const out: Part[] = [];
  // A scanner usually ends each code with Enter; also accept codes run together.
  const re = /PGPQ1\|([0-9A-F]{12})\|(\d{1,3})\/(\d{1,3})\|([A-Za-z0-9+/=|tz]*?)(?=PGPQ1\||\s|$)/g;
  for (const m of scanned.replace(/\r/g, '\n').matchAll(re)) {
    const index = Number(m[2]);
    const total = Number(m[3]);
    if (index >= 1 && index <= total) out.push({ group: m[1], index, total, chunk: m[4] });
  }
  return out;
}

export interface DecodedText {
  fingerprint: string;
  signature: Uint8Array;
  canonical: string;
  sha256: string;
  documentId: string;
}

/** Reassembles the scanned codes into the signed text and its signature. */
export async function decodeCodes(scanned: string): Promise<DecodedText> {
  const parts = parseParts(scanned);
  if (!parts.length) throw new Error('No document signature codes found. Scan the QR codes on the signature page; they start with PGPQ1|.');
  const p = scanProgress(scanned);
  if (p.groups.length > 1) throw new Error('These codes come from more than one document. Clear the box and scan one document at a time.');
  if (p.missing.length) throw new Error(`Scanned ${p.have} of ${p.total} codes. Still missing code ${p.missing.join(', ')}.`);
  const byIndex = new Map(parts.map((x) => [x.index, x.chunk]));
  const message = Array.from({ length: p.total }, (_, i) => byIndex.get(i + 1)!).join('');
  const f = message.split('|');
  if (f.length !== 5 || f[0] !== DOC_PREFIX || !/^[0-9A-F]{40}([0-9A-F]{24})?$/.test(f[1]) || !/^[zt]$/.test(f[3])) {
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
  if (!sha256.toUpperCase().startsWith(parts[0].group)) {
    throw new Error('The codes do not fit together (the text does not match the document ID). Scan one document at a time.');
  }
  return { fingerprint: f[1], signature, canonical, sha256, documentId: documentId(sha256) };
}

export interface TextVerifyResult extends VerifyResult {
  /** The exact text the owner signed, recovered from the codes. */
  signedText?: string;
}

/** Recorder-side check of a paper filing: scanned codes against the registered key. */
export async function verifyScannedText(input: { scanned: string; registeredKey: AnyKey }): Promise<TextVerifyResult> {
  const checks: Check[] = [];
  let d: DecodedText;
  try {
    d = await decodeCodes(input.scanned);
    checks.push({ label: 'All signature codes read', state: 'pass', detail: 'The signed text and signature were recovered from the codes.' });
  } catch (e) {
    const progress = scanProgress(input.scanned);
    const partial = progress.total > 0 && progress.missing.length > 0 && progress.groups.length === 1;
    checks.push({ label: 'All signature codes read', state: partial ? 'skipped' : 'fail', detail: (e as Error).message });
    return { verdict: partial ? 'incomplete' : 'bad', checks };
  }
  const registered = input.registeredKey.getFingerprint().toUpperCase();
  const fprOk = d.fingerprint === registered;
  checks.push({
    label: 'Signed by the registered key',
    state: fprOk ? 'pass' : 'fail',
    detail: fprOk
      ? `Fingerprint ${formatFingerprint(registered)} matches the key on file.`
      : `The codes name key ${formatFingerprint(d.fingerprint)}, but the key on file is ${formatFingerprint(registered)}.`,
  });
  let signedAt: Date | undefined;
  let ok = false;
  let why = '';
  try {
    const sigObj = await openpgp.readSignature({ binarySignature: d.signature });
    signedAt = sigObj.packets[0]?.created ?? undefined;
    const v = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(d.canonical) }),
      signature: sigObj,
      verificationKeys: input.registeredKey.toPublic(),
      expectSigned: false,
    });
    if (v.signatures[0]) {
      await v.signatures[0].verified;
      ok = true;
    } else why = 'no signature found';
  } catch (e) {
    why = (e as Error).message.replace(/^Error: /, '');
  }
  checks.push({
    label: 'Signature valid',
    state: ok ? 'pass' : 'fail',
    detail: ok ? 'The owner’s key signed exactly the text shown below.' : `Signature does not verify: ${why}`,
  });
  const verdict: Verdict = checks.some((c) => c.state === 'fail') ? 'bad' : 'good';
  return { verdict, checks, signedAt, documentId: d.documentId, signedText: d.canonical };
}
