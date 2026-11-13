# Changelog

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
