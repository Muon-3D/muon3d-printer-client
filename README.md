# @muon3d/printer-client

The pieces that every client of a Muon3D printer shares, whatever its framework. The Muon3D Slicer uses them to send
G-code to Muon printers, and Muon3D's Fluidd uses them when its **Slice** page hosts the slicer. The package holds no
UI, no words a person reads and no framework code, has no dependencies, and imports nothing outside itself.

Licence: Apache-2.0 (`LICENSE`, `NOTICE`). Copyright 2026 Muon 3D Technologies Limited.

## What it holds

- **`multipart/`: the upload.** `buildUploadBody({ name, bytes, checksum })` writes the body of
  `POST /server/files/upload` once: exactly `root=gcodes`, `checksum` (the file's SHA-256, lowercase hex; the printer
  answers 422 when the file it wrote differs) and the file, never `path` and never `print` (a print is started by its
  own request, after the person confirmed it). The boundary comes from the checksum, so the same file always gets the
  same bytes, and the `Content-Type` it returns names the boundary the body uses. `checkUpload(request)` says what the
  printer's gateway does with an upload on a remote connection (its rules are restated here, see `NOTICE`): accepted,
  or refused with 400, 403 or 411 and why. `checkPrintUpload` adds the rules above. `isSafeName(name)` is the rule for
  a file name: the gateway's, plus no quote, semicolon, control character, white space at either end, `.ufp` ending
  or more than 255 bytes, so the name checked is the name Moonraker stores. In a URL a name is still
  percent-encoded. `src/multipart/vectors/upload.json` holds request cases with the verdict of each check, for any
  client or gateway to test against (`body` as text, or `bodyBase64` for bytes that are not UTF-8); one is a body
  whose header and bytes come from two serialisations of one `FormData`, which the gateway refuses.
- **`errors/`: one error shape for every route.** `PrinterError { kind, message, status?, action?, refusal?, detail?,
  retryAfterS? }`. `message` is for logs; `detail` is the other side's own words, cleaned for display (one line, no
  control or direction characters, at most 500 characters). The parsers read each side's answers: `parsePrinterAnswer`
  and `parseRpcError` (Moonraker and the gateway: `denied` with the access action, `upload-refused`, `checksum`,
  `safety-pass`, `busy`, `printer`), `parseUploadAnswer` (the upload's 201: the stored `path` and `size`, and
  `protocol` when the answer is anything else or says a print was started or queued), `parseNetworkFailure` (pass
  `committed` for a print start or a queue entry: a lost answer is `lost`, not `offline`), `parseXhrFailure` and
  `parseSocketClose` (`offline`, `lost`, `timeout`, `cancelled`), `parseBindingError` and `parseCloseCode` (the relay
  binding and its close codes: `refused` with the reason only for codes that refuse the key or session, `busy` at
  capacity, `lost` for an ordinary close such as a printer's restart, `unreachable`), `parseConsoleAnswer`,
  `parseConsoleFailure` and `parseConsolePrinter` (the account service: `signed-out`, `console`, and an access grant's
  `offline` and `unreachable`), and `parseBridgeError` (a bridge host's failure; the host is not trusted, so an
  unknown kind is `protocol`). `needsRegrant(error)` and `isTerminal(error)` say what may be tried again.
- **`bridge/`: `printer-bridge/1`, the slicer in a host's frame.** The protocol between a page that frames a printer
  client (the host, such as Fluidd's Slice page) and the client in the frame (the Muon3D Slicer's `embed.html`).
  `protocol.ts` holds the names, the limits (`LIMITS`) and the validators both sides run on everything they receive;
  `connectBridge` and `createBridgeHost` run them, and the package exports the ones a client needs for its answers and
  events (`parseBridgePrinter`, `parsePrintDecision`, `parseQueueAnswer`, `parseStatusData`, `parseGcodeData`). The
  handshake is two window messages: the client's `hello` (a fresh nonce, to each exact origin it allows;
  `checkHostOrigins` refuses `*`) and the host's one `welcome`, which transfers a `MessagePort`; every request, answer
  and event after it travels on the port and names its printer by key, so a request for a printer the host no longer
  has selected is refused (`printer-changed`). `connectBridge` is the client's side; `createBridgeHost` the host's,
  which keeps the host's rules whatever the frame asks, because the frame may be hostile: Moonraker reads from an
  allowlist only, the upload body built by the host (never `print`, never a path; a queued, printing or foreign file
  is never replaced), and the start behind the host's own dialog. A send asks `print.request` once with every path:
  in start mode the dialog ("Print ‹file› on ‹printer›?") says "and queue ‹n› more" and, on Print, starts the first
  and approves the rest for `queue.add` (no second dialog, only while the printer prints or is paused); in queue mode
  the dialog ("Queue ‹file› on ‹printer›?", "and ‹n› more", Queue; never Plate is clear) queues them all. Upload only,
  the dialog's ✕ and Esc answer `uploaded-only` in either mode. `vectors/*.json` are the normative conformance cases
  (`messages.json`: requests, messages and answers; `handshake.json`; `host.json`: the host's rules as scenarios),
  run here by `vectors.test.ts` and by any other implementation of either side.
- **`proof/`: the relay key's endpoint proof.** Before the Muon3D account service admits a browser's relay key, it
  sends a challenge (`{ nonce, expires_at, domain }`), and the client signs the domain `muon3d-console endpoint proof
  v1`, a NUL byte, the 32-byte nonce and its EndpointId with that key. `proveEndpoint(seed, challengeAnswer, {
  serviceDate })` does it all and returns the body to send (`{ endpoint_id, nonce, signature }`, hex):
  `checkChallenge` checks the answer's domain and expiry (against the service's clock when `serviceDate`, its `Date`
  header, is given; `serviceSeconds` reads it), `endpointProofMessage` builds the message, and `signEndpointProof`
  signs nothing but a proof message for its own key (anything else throws `ProofRefusal`). A relay key is a 32-byte
  Ed25519 seed (`newSeed`); its EndpointId is its public key in lowercase hex (`endpointIdOf`, `isEndpointId`).
  Ed25519 is the platform's WebCrypto; a `SubtleCrypto` may be passed in.

```ts
import { buildUploadBody, isPrinterError, parseNetworkFailure, parseUploadAnswer } from '@muon3d/printer-client';

const upload = buildUploadBody({ name: 'cube.gcode', bytes, checksum });
let answer: Response;
try {
  answer = await fetch('/server/files/upload', { method: 'POST', headers: { 'Content-Type': upload.contentType }, body: upload.body });
} catch (err) {
  throw parseNetworkFailure(err);
}
const stored = parseUploadAnswer({ status: answer.status, body: await answer.text() });
if (isPrinterError(stored)) throw stored;
// stored.path is the name to start or queue.
```

## Using it

The sources are TypeScript with only erasable syntax, imported with their `.ts` extensions: `@muon3d/printer-client`
(everything), `@muon3d/printer-client/multipart` and `@muon3d/printer-client/errors`. A bundler that compiles
TypeScript (Vite, esbuild, webpack with a TypeScript loader) reads them as they are. Node 22.18 or newer runs them
directly, but not from inside `node_modules` (Node does not strip types there).

The package is not on the npm registry. Each release on GitHub has an `npm pack` tarball, with its integrity in the
release notes:

```sh
npm install https://github.com/Muon-3D/muon3d-printer-client/releases/download/v0.1.0/muon3d-printer-client-0.1.0.tgz
```

### In Fluidd

Muon3D's Fluidd (GPL-3.0, which allows combining it with Apache-2.0 code) does not install the package. Its Slice
page copies the files it needs into `src/services/slicer-bridge/vendor/printer-client/` with
`node tools/vendor-printer-client.cjs <this package's folder>`: the bridge's host and protocol with the three vector
files, `errors/kinds.ts` and `errors/parse.ts`, the four `multipart/` sources, `LICENSE` and `NOTICE`. The script makes
two mechanical changes so the files build under Fluidd's TypeScript settings (relative imports without `.ts`, and
`Object.hasOwn` as `Object.prototype.hasOwnProperty.call` for its ES2020 target), and heads each copied `.ts` file
with a notice naming the package's version from `package.json` and the file's path here. To update Fluidd's copy,
check out a release tag of this repository (or unpack its tarball), run the script on that folder, and commit the
result in Fluidd; the copies are never edited there.

## Development

This repository is a mirror: the package is developed inside the Muon3D Slicer and copied here, unchanged, for each
release. Issues and pull requests are welcome here; accepted changes are made in the slicer and arrive with the next
release.

- Tests: `node --test "src/**/*.test.ts"` (Node 22.18 or newer). They are not in the published tarball.
- Types: `tsc -p tsconfig.json` (TypeScript 5.9 with `@types/node`, which the tests use).
