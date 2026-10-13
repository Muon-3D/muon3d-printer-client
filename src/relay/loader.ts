// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Loading a pinned relay binding: the client names the binding's two files (the wasm-bindgen glue and the wasm) and
// the SHA-256 of each, from wherever it serves them. Both files are fetched and their hashes compared with the pin
// before anything runs; the wasm is started from the bytes that were checked. The glue is then imported by its URL
// (a page's script-src usually allows its own origin, not blob: URLs), with the pin's hash in the query, so no cache
// entry of another pin answers it. The check guards against a wrong or stale file, not against one replaced on the
// server between the check and the import: serving each pin from its own folder, never rewritten, guards that.
//
// The relay key is handed only to code that passed this check.
import { cleanText, printerError, type PrinterError } from '../errors/kinds.ts';
import { protocolError } from '../errors/parse.ts';
import { fail } from '../errors/failure.ts';
import type { Binding } from './binding.ts';

export interface BindingPin {
  /** The glue's absolute URL (`…/muon_link_web.js`). */
  js: string;
  /** The wasm's absolute URL (`…/muon_link_web_bg.wasm`). */
  wasm: string;
  /** SHA-256 of each file, lowercase hex. */
  sha256: { js: string; wasm: string };
}

export interface LoadBindingOptions {
  /** Fetches a file's bytes; the platform's fetch by default (a status that is not 2xx fails). */
  fetchBytes?(url: string): Promise<Uint8Array>;
  /** Imports a module by URL; the platform's dynamic import by default. */
  importModule?(url: string): Promise<unknown>;
  subtle?: SubtleCrypto;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** A failure to load: thrown as a PrinterFailure. */
const refuse = (error: PrinterError): never => {
  throw fail(error);
};

const reasonOf = (err: unknown): string => cleanText(err instanceof Error ? err.message : String(err));

async function sha256(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The module's binding, with the glue's start function, or a refusal when it is not the binding. */
function bindingOf(module: unknown): Binding & { default: (init?: unknown) => Promise<unknown> } {
  const m = module as Record<string, unknown> | null;
  const endpoint = m?.MuonEndpoint as Record<string, unknown> | undefined;
  if (typeof m?.default !== 'function' || typeof endpoint?.create !== 'function') refuse(protocolError('the binding module has no MuonEndpoint.create or init'));
  return m as unknown as Binding & { default: (init?: unknown) => Promise<unknown> };
}

/** The URL the pinned glue is imported from: its own, with the pin's hash in the query. */
export function pinnedImportUrl(pin: BindingPin): string {
  const url = new URL(pin.js);
  url.searchParams.set('sha256', pin.sha256.js);
  return url.href;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const defaultImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

/**
 * Loads and starts the pinned binding. Throws a PrinterFailure: `bad-request` (a pin that is not one: URLs, hex
 * hashes), `protocol` (a file whose hash differs from the pin, a module that is not the binding), `unreachable` (a file
 * that could not be fetched, imported or started).
 */
export async function loadPinnedBinding(pin: BindingPin, options: LoadBindingOptions = {}): Promise<Binding> {
  let jsUrl: string;
  let wasmUrl: string;
  try {
    jsUrl = new URL(pin.js).href;
    wasmUrl = new URL(pin.wasm).href;
  } catch {
    return refuse(printerError('bad-request', "The binding's pin names a file that is not a URL"));
  }
  if (!SHA256_RE.test(pin.sha256?.js ?? '') || !SHA256_RE.test(pin.sha256?.wasm ?? '')) refuse(printerError('bad-request', "The binding's pin has no SHA-256 for each file"));
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const importModule = options.importModule ?? defaultImport;
  const subtle = options.subtle ?? crypto.subtle;

  const fetched = async (url: string): Promise<Uint8Array> => {
    try {
      return await fetchBytes(url);
    } catch (err) {
      return refuse(printerError('unreachable', 'A binding file could not be fetched', { detail: reasonOf(err) }));
    }
  };
  const [js, wasm] = await Promise.all([fetched(jsUrl), fetched(wasmUrl)]);
  if ((await sha256(js, subtle)) !== pin.sha256.js) refuse(protocolError("the binding's glue is not the pinned file", jsUrl));
  if ((await sha256(wasm, subtle)) !== pin.sha256.wasm) refuse(protocolError("the binding's wasm is not the pinned file", wasmUrl));

  let module: unknown;
  try {
    module = await importModule(pinnedImportUrl({ ...pin, js: jsUrl }));
  } catch (err) {
    return refuse(printerError('unreachable', 'The binding module could not be imported', { detail: reasonOf(err) }));
  }
  const binding = bindingOf(module);
  try {
    await binding.default({ module_or_path: wasm });
  } catch (err) {
    refuse(printerError('unreachable', 'The binding did not start', { detail: reasonOf(err) }));
  }
  return binding;
}
