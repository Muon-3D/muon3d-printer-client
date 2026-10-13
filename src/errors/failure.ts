// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A PrinterError to throw. Code that rejects (a route, the console's API, the relay's loader) throws a PrinterFailure,
// an Error that carries the PrinterError, so `await` and `catch` work as usual and the kind survives the throw.
// failureOf reads the PrinterError back from anything caught.
import { cleanText, isPrinterError, printerError, type PrinterError } from './kinds.ts';
import { protocolError } from './parse.ts';

/** What the package's code rejects with: the PrinterError, as an Error. */
export class PrinterFailure extends Error {
  readonly error: PrinterError;

  constructor(error: PrinterError) {
    super(error.message);
    this.name = 'PrinterFailure';
    this.error = error;
  }
}

/** A PrinterFailure for `error`, to throw. */
export const fail = (error: PrinterError): PrinterFailure => new PrinterFailure(error);

/**
 * The PrinterError of anything caught: a PrinterFailure's (also one made by another copy of this package, which
 * `instanceof` does not see), a PrinterError thrown as it is, an abort as `cancelled`; anything else is `protocol`,
 * with its message, cleaned, as the detail.
 */
export function failureOf(err: unknown): PrinterError {
  if (err instanceof PrinterFailure) return err.error;
  if (isPrinterError(err)) return err;
  if (err instanceof Error && err.name === 'PrinterFailure' && isPrinterError((err as { error?: unknown }).error)) return (err as unknown as { error: PrinterError }).error;
  if (err instanceof Error && err.name === 'AbortError') return printerError('cancelled', 'Cancelled');
  return protocolError('an unexpected failure', cleanText(err instanceof Error ? err.message : String(err)));
}
