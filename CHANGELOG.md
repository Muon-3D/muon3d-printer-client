# Changelog

## 0.7.0

Cameras for each kind, and Klipper's job queue.

### Added

- **Cameras.** `cameras()` on each adapter: Moonraker's webcam list (`/server/webcams/list`; relative addresses are
  the printer's web pages', not Moonraker's port), OctoPrint's webcam settings (`/api/settings`), a Creality K1's MJPEG
  on port 8080 (the protocol names none), and Elegoo's stream from SDCP's 386 (`VideoUrl`, reached by the name the
  page uses for the printer). `BrandCamera`: `mjpeg`, `snapshot`, or `other` (WebRTC, HLS: to open, not to draw).
- **`camera/`**: `watchCamera` and `jpegFrames`, the pictures of an MJPEG stream or a snapshot read with fetch, for
  a cross-origin-isolated page.
- **Klipper's job queue**: `status.queue` (from `server.job_queue.status` and `notify_job_queue_changed`) and
  `adapter.queue` (add, remove, start, pause). `BrandCapabilities` gains `camera` and `queue`.
- The fakes serve a camera each (with or without CORS) and Moonraker's job queue.

### Sizes

Each entry point bundled on its own (rolldown, minified, gzip): `brands/moonraker` 4.0 KB, `brands/octoprint` 3.3 KB,
`brands/creality` 2.4 KB, `brands/elegoo` 3.2 KB, `camera` 1.1 KB. Through `loadBrand`, the shared code is 2.2 KB and
each kind 1.0 to 2.3 KB.

## 0.6.0

Printers of other kinds, reached directly on the local network, and their credentials kept in this browser.

### Added

- **`brands/`**: one adapter per kind with one shape (`BrandAdapter`), each its own entry point:
  `createMoonrakerAdapter` (Klipper through Moonraker: the WebSocket's identify and subscribe, HTTP commands, upload to
  the gcodes root with start), `createOctoPrintAdapter` (the job and printer read every 3 s, upload with select and
  print, `requestOctoPrintKey` through the Application Keys plugin), `createCrealityAdapter` (the stock firmware's
  WebSocket on port 9999: telemetry, heartbeat, pause, resume, stop) and `createElegooAdapter` (SDCP v3 on port 3030:
  status, files, start a stored file, pause, resume, stop, each command matched to its answer). A probe per kind.
  `BRANDS`, `BRAND_KINDS`, `brandSteps` and `loadBrand` describe and load the kinds without loading an adapter.
  `lanAddress`, `hostWithPort`, `isLanUrl` and `browserReachesLan` keep a page to the local network.
- **`secrets/`**: `createSecretStore`, `idbSecretBackend` and `memorySecretBackend`.
- `package.json` exports `./brands`, `./brands/moonraker`, `./brands/octoprint`, `./brands/creality`, `./brands/elegoo`
  and `./secrets`; the root entry point re-exports `brands/` (not the adapters) and `secrets/`.

### Sizes

Each entry point bundled on its own (rolldown, minified, gzip): `brands` 1.8 KB, `brands/moonraker` 3.2 KB,
`brands/octoprint` 3.0 KB, `brands/creality` 2.2 KB, `brands/elegoo` 3.0 KB, `secrets` 1.2 KB. Through `loadBrand`, the
code the adapters share loads once (2.1 KB) and each kind adds 0.9 to 1.7 KB.

## 0.5.0

A framework-free connectivity core for every Muon3D client (the slicer, Muon3D Control, Design), in five new entry
points beside the existing ones, and plain words for every error.

### Added

- **`printers/`**: the tile states, tones and words Muon3D Control uses (`TILE_STATES`, `tileTone`, `tileWords`,
  `tileLabel`, `groupSummary`), a printer's health from what its Moonraker answered (`healthOfMoonraker`,
  `accountHealth`) and the tile for it (`tileOfHealth`); one entry per printer from the account, this browser and the
  network (`printerDirectory`, joined by EndpointId, then address, then exact name; `savedUpdates`); Control's page
  slugs (`slugForIdentity`, `slugForMdnsHost`, `slugForAccountPrinter`, `slugForAddress`, `printerPath`) and
  `printerNameParts`.
- **`lan/`**: `lanFetch`, `probe`, `probeAddress`, `printerHealth`, `pageCanReach`, `pageBlocksLanIpv4` and
  `lanIpv4Block`, `addressCandidates`, `nearbyHost`, `pageBlocksPrinter`, `printerPageUrl`, `escapeHtml`, and
  `localNetworkPermission()`. No network sweep. The browser's parts come from an optional `LanEnv`.
- **`console/`**: `createConsoleApi({ origin, clientId })` with the token endpoint, the account, the endpoint proof, the
  printer list, access grants, the printers near this browser and assertions; PKCE S256 (`pkce.ts`); central sign-in
  (`authorizeUrl` with `prompt: 'none'`, `prepareSignIn`, `storePendingSignIn`, `takePendingSignIn`,
  `readSignInAnswer`, `signInAnswerOf`, `checkSignInAnswer`, `logoutForm`) with `sameConsole(a, b, aliases)` and
  `CONSOLE_ALIASES` for the console's two names; the refresh-safe session (`createSession`, `idbSessionStore`,
  `memorySessionStore`, `keyAfter`); and the settings readers (`consoleOriginOf`, `relayHostsOf`, `relayUrlAllowed`).
- **`relay/`**: `loadPinnedBinding` (both files checked against their SHA-256 before anything runs),
  `createEndpointHolder`, `createRelayPrinter` (fetch and a WebSocket-shaped socket over a binding session) and
  `createRelayTransport` (one printer's connection, dialled again with a backoff and a new grant).
- **`check/`**: the send gates (`evaluateGates`, `plateClearNeed`, `notePlate`, `notePlateHistory`), the printer at a
  glance (`readGlance`, `applyUpdate`, `GLANCE_OBJECTS`) and the upload's name (`uploadNameFor`, `chooseUploadName`,
  `nameCheckFor`, `uploadRecord`).
- **`errors/`**: `PrinterFailure`, `fail` and `failureOf`; `explain(error, { printer, owner, lastSeen })` and
  `ACTION_LABELS`, one plain sentence and at most one action per kind; two kinds, `chrome-only` (this browser does not
  let a page reach the local network) and `permission` (the local network permission is refused), read by
  `parseLanFailure`.
- `package.json` exports `./printers`, `./lan`, `./console`, `./relay` and `./check`.

### Changed

- `isTerminal` is true for `chrome-only` and `permission`: only the person changes those.
- The root entry point re-exports the new entry points too. Every existing export is unchanged.

### Not in this release

- The printer-bridge/1 additions the slicer's copy of the package made in its 0.2 to 0.4 (`ui.look`, `ui.mode`,
  `printer.setup`, `printer.material` and the library operations) are still in open pull requests there and are not
  here: `bridge/` is as it was in 0.1.0.
- `check/` has no keep-out scan and no preset match: both need the slicer's G-code scanner and bed-geometry parser,
  which Export uses too. The gates take their verdicts (`KeepOutVerdict`, `SetupMatch`) as input.

## 0.1.0

- `multipart/`, `errors/`, `bridge/` (printer-bridge/1) and `proof/`.
