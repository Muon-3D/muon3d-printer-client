// SPDX-License-Identifier: Apache-2.0
// The endpoint proof: a relay key's EndpointId without binding, the proof message, the guarded signer and the
// challenge's check (proof.ts). Only these are the package's API; ed25519.ts's unguarded signer is not exported.
export {
  checkChallenge,
  endpointIdOf,
  endpointProofMessage,
  isEndpointId,
  newSeed,
  proveEndpoint,
  PROOF_DOMAIN,
  PROOF_MESSAGE_BYTES,
  ProofRefusal,
  serviceSeconds,
  signEndpointProof,
  type EndpointChallenge,
  type EndpointProof,
} from './proof.ts';
