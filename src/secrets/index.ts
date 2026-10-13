// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A printer's credentials in this browser only: encrypted in IndexedDB when the person chooses to remember them, in
// the page's memory otherwise (secrets.ts). Only these are the package's API.
export { createSecretStore, idbSecretBackend, memorySecretBackend, type Secret, type SecretBackend, type SecretStore, type StoredSecret } from './secrets.ts';
