// SPDX-License-Identifier: Apache-2.0
// The endpoint proof the account service asks for before it admits a browser's relay key:
// `POST /v1/me/endpoint/challenge` answers `{nonce, expires_at, domain}`; the client signs
// "muon3d-console endpoint proof v1\0" ‖ nonce (32 bytes) ‖ its EndpointId (32 bytes, raw) with its relay key, and
// sends `PUT /v1/me/endpoint {endpoint_id, nonce, signature}` (hex). Only then does it bind the endpoint: the relay
// refuses a key the service has not admitted, and iroh then backs off for up to 32 s.
//
// The relay key is a 32-byte Ed25519 seed and the EndpointId its public key in lowercase hex. The signer has a guard,
// as muon-link-mobile's sign_endpoint_proof has: the key signs nothing but a proof message, exactly the domain, a
// 32-byte nonce and its own EndpointId, so a caller cannot use it to sign anything else (another key's proof, a
// message of another protocol). proveEndpoint takes the nonce only from the challenge's answer, after checking its
// domain and its expiry. Ed25519 is WebCrypto's (ed25519.ts); a SubtleCrypto may be passed in.
import { printerError, type PrinterError } from '../errors/kinds.ts';
import { protocolError } from '../errors/parse.ts';
import { encoder, equalBytes } from '../multipart/bytes.ts';
import { publicKeyOfSeed, SEED_BYTES, signWithSeed, webCrypto } from './ed25519.ts';

/** The proof's domain: the service's `domain`, and the signed message's head (before a NUL byte). */
export const PROOF_DOMAIN = 'muon3d-console endpoint proof v1';
export const NONCE_BYTES = 32;
export const ENDPOINT_ID_BYTES = 32;
const DOMAIN_HEAD = encoder.encode(`${PROOF_DOMAIN}\0`);
/** A proof message's length: the domain and its NUL, the nonce, the EndpointId. */
export const PROOF_MESSAGE_BYTES = DOMAIN_HEAD.length + NONCE_BYTES + ENDPOINT_ID_BYTES;

/** How long the service's challenge lasts (its `expires_at` is 300 s after it answers). */
export const CHALLENGE_LIFETIME_S = 300;
/** How far this computer's clock may be from the service's before a challenge reads as expired or too long. */
export const MAX_CLOCK_SKEW_S = 300;
/** With the service's own clock (its answer's Date header, 1 s resolution), how far its expiry may be off. */
export const SERVICE_CLOCK_MARGIN_S = 60;

/** The service's answer to `POST /v1/me/endpoint/challenge`, checked (checkChallenge). */
export interface EndpointChallenge {
  /** 32 bytes, lowercase hex. */
  nonce: string;
  /** Unix seconds. */
  expires_at: number;
  domain: typeof PROOF_DOMAIN;
}

/** The body of `PUT /v1/me/endpoint`: the EndpointId, the challenge's nonce and the signature, lowercase hex. */
export interface EndpointProof {
  endpoint_id: string;
  nonce: string;
  signature: string;
}

/** The guard refused to sign: the message is not this key's proof message. */
export class ProofRefusal extends Error {
  constructor(reason: string) {
    super(`The relay key signs only its endpoint proof: ${reason}`);
    this.name = 'ProofRefusal';
  }
}

const HEX32_RE = /^[0-9a-f]{64}$/;

/** Whether `value` is an EndpointId as the service writes one: 32 bytes in lowercase hex. */
export const isEndpointId = (value: unknown): value is string => typeof value === 'string' && HEX32_RE.test(value);

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 32 bytes from 64 lowercase hex digits; anything else throws. */
function bytes32(value: string | Uint8Array, what: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new ProofRefusal(`the ${what} is not 32 bytes`);
    return value;
  }
  if (!HEX32_RE.test(value)) throw new ProofRefusal(`the ${what} is not 32 bytes of lowercase hex`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A new relay key: 32 random bytes from the platform's CSPRNG. */
export function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

/** The EndpointId of a relay key: its Ed25519 public key in lowercase hex, without binding an endpoint. */
export async function endpointIdOf(seed: Uint8Array, subtle: SubtleCrypto = webCrypto()): Promise<string> {
  return toHex(await publicKeyOfSeed(seed, subtle));
}

/** The message a proof signs: the domain, a NUL byte, the nonce and the EndpointId (raw bytes; hex is read as such). */
export function endpointProofMessage(nonce: string | Uint8Array, endpointId: string | Uint8Array): Uint8Array {
  const message = new Uint8Array(PROOF_MESSAGE_BYTES);
  message.set(DOMAIN_HEAD);
  message.set(bytes32(nonce, 'nonce'), DOMAIN_HEAD.length);
  message.set(bytes32(endpointId, 'EndpointId'), DOMAIN_HEAD.length + NONCE_BYTES);
  return message;
}

/**
 * Signs `message` with the relay key, only when it is that key's proof message: exactly PROOF_MESSAGE_BYTES long,
 * the domain and a NUL first, and the key's own EndpointId last (the 32 bytes between are the nonce). Anything else
 * throws ProofRefusal before the key is used.
 */
export async function signEndpointProof(seed: Uint8Array, message: Uint8Array, subtle: SubtleCrypto = webCrypto()): Promise<Uint8Array> {
  if (!(message instanceof Uint8Array)) throw new ProofRefusal('the message is not bytes');
  if (message.length !== PROOF_MESSAGE_BYTES) throw new ProofRefusal(`the message is ${message.length} bytes, not ${PROOF_MESSAGE_BYTES}`);
  if (!equalBytes(message.subarray(0, DOMAIN_HEAD.length), DOMAIN_HEAD)) throw new ProofRefusal('the message does not start with the proof domain');
  const own = await publicKeyOfSeed(seed, subtle);
  if (!equalBytes(message.subarray(DOMAIN_HEAD.length + NONCE_BYTES), own)) throw new ProofRefusal("the message names another key's EndpointId");
  return signWithSeed(seed, message, subtle);
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The service's clock, as Unix seconds: its answer's Date header (an HTTP date), or seconds already; else undefined. */
export function serviceSeconds(date: string | number | null | undefined): number | undefined {
  if (typeof date === 'number') return Number.isFinite(date) ? date : undefined;
  if (typeof date !== 'string' || !date.trim()) return undefined;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

/**
 * The challenge's answer, checked: the proof's domain, a 32-byte nonce in lowercase hex, and an `expires_at` (Unix
 * seconds, an integer) that has not passed and is no further ahead than the challenge lasts. Anything else is
 * `protocol`.
 *
 * The expiry is read against the service's own clock when `serviceDate` is given (the challenge answer's Date header,
 * or Unix seconds), within SERVICE_CLOCK_MARGIN_S, so a computer whose clock is minutes off still proves its key; the
 * service enforces the expiry and single use itself. Without it, the expiry is read against `nowS` (this computer's
 * clock) within MAX_CLOCK_SKEW_S, and a clock further off than that fails every challenge: callers pass the Date.
 */
export function checkChallenge(answer: unknown, nowS = Date.now() / 1000, serviceDate?: string | number | null): EndpointChallenge | PrinterError {
  const a = record(answer);
  if (!a) return protocolError('the endpoint challenge is not an object');
  if (a.domain !== PROOF_DOMAIN) return protocolError('the endpoint challenge names another domain', typeof a.domain === 'string' ? a.domain.slice(0, 64) : '');
  if (!isEndpointId(a.nonce)) return protocolError('the endpoint challenge has no 32-byte nonce');
  const expires = a.expires_at;
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires)) return protocolError('the endpoint challenge has no expiry');
  const service = serviceSeconds(serviceDate);
  const [reference, margin] = service === undefined ? [nowS, MAX_CLOCK_SKEW_S] : [service, SERVICE_CLOCK_MARGIN_S];
  if (expires + margin <= reference) return printerError('protocol', 'The endpoint challenge has expired', { detail: `expires_at ${expires}` });
  if (expires - reference > CHALLENGE_LIFETIME_S + margin) return protocolError('the endpoint challenge lasts longer than a challenge does', `expires_at ${expires}`);
  return { nonce: a.nonce, expires_at: expires, domain: PROOF_DOMAIN };
}

/**
 * The body of `PUT /v1/me/endpoint` for this relay key, signed over the nonce of `challengeAnswer` (the service's
 * answer to the challenge, as received), or the PrinterError checkChallenge found in that answer. `serviceDate` is
 * that answer's Date header (checkChallenge reads the expiry against it). A browser that cannot use the key throws
 * the PrinterError `unsupported`.
 */
export async function proveEndpoint(
  seed: Uint8Array,
  challengeAnswer: unknown,
  options: { nowS?: number; serviceDate?: string | number | null; subtle?: SubtleCrypto } = {},
): Promise<EndpointProof | PrinterError> {
  const challenge = checkChallenge(challengeAnswer, options.nowS, options.serviceDate);
  if (!('nonce' in challenge)) return challenge;
  const subtle = options.subtle ?? webCrypto();
  const endpointId = await endpointIdOf(seed, subtle);
  const signature = await signEndpointProof(seed, endpointProofMessage(challenge.nonce, endpointId), subtle);
  return { endpoint_id: endpointId, nonce: challenge.nonce, signature: toHex(signature) };
}
