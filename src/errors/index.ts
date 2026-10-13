// SPDX-License-Identifier: Apache-2.0
// The errors: the kinds every route reports (kinds.ts), the parsers of each side's answers (parse.ts), the Error that
// carries a PrinterError through a throw (failure.ts) and the words a person reads about each kind (messages.ts). Only
// these are the package's API; the modules' other exports are for its tests.
export {
  cleanText,
  ERROR_KINDS,
  isErrorKind,
  isPrinterError,
  isTerminal,
  needsRegrant,
  printerError,
  type ErrorKind,
  type PrinterError,
  type Refusal,
} from './kinds.ts';
export {
  cancelledError,
  CLOSE_CODES,
  parseBindingError,
  parseBridgeError,
  parseCloseCode,
  parseConsoleAnswer,
  parseConsoleFailure,
  parseConsolePrinter,
  parseLanFailure,
  parseNetworkFailure,
  parsePrinterAnswer,
  parseRpcError,
  parseSocketClose,
  parseUploadAnswer,
  parseXhrFailure,
  printerChangedError,
  protocolError,
  timeoutError,
  type HttpAnswer,
  type LocalNetworkState,
  type UploadedFile,
} from './parse.ts';
export { fail, failureOf, PrinterFailure } from './failure.ts';
export { ACTION_LABELS, explain, type ActionId, type ExplainContext, type Explanation } from './messages.ts';
