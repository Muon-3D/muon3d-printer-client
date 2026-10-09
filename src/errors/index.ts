// SPDX-License-Identifier: Apache-2.0
// The errors: the kinds every route reports (kinds.ts) and the parsers of each side's answers (parse.ts). Only these
// are the package's API; the modules' other exports are for its tests.
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
  type UploadedFile,
} from './parse.ts';
