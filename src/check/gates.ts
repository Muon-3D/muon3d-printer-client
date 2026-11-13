// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The send gates: one pure function a Send sheet runs on every status change while it is open, and the send runs again
// immediately before the upload and before the start. It says what the printer is offered for (Print while it is
// idle, Queue while it prints or is paused; Upload only), which gates fail and what each failure holds back. No words:
// the client words the reasons.
//
// The gates, by number: SG-1 the keep-out scan of the bytes, SG-2 a current slice, SG-3 the setup sliced for (model and
// keep-out volumes), SG-4 the person's role, SG-5 the printer reachable and Klipper ready, SG-6 a state Print starts
// from or Queue joins, SG-7 the plate on, SG-8 the toolhead connected, SG-9 the plate clear, SG-12 the relay's size
// limit, SG-13 the send's printer. SG-11, the upload's name, is names.ts's.
//
// Plate clear (SG-9) is read from the printer's print history, which survives a Klipper restart and a cleared job card:
// when its newest job is over and used filament, the person ticks "Plate is clear" before Print. On the printer's own
// network a plate cycle the page saw after it read that job lifts the request (PlateCycle); through the relay nothing
// does, because nobody there can see the plate. When the printer has no history, or it could not be read, the tick is
// always asked; so it is while the newest job is still running in the history (it ends there a moment after
// print_stats says so, and will have left a part).
import { canStartFrom, isBusy, plateRemoved, readGlance, toolheadDisconnected, type StatusView } from './glance.ts';

/** How a printer is reached: its own origin or network (local), the relay (cloud), or a host that frames the client. */
export type Route = 'local' | 'cloud' | 'host';
/** What carries the route: the printer's own network (`lan`) or the relay (`iroh`). */
export type Transport = 'lan' | 'iroh';
export type PrinterRole = 'owner' | 'operator' | 'viewer';

/** The printer the gates are for. */
export interface GatePrinter {
  /** The printer's key: its EndpointId, or another stable key the client gives it. */
  key: string;
  /** The model's name in the profile set ("Muon3D M1"), or null when nothing says which model it is. */
  model: string | null;
  route: Route;
  /** The person's role on it; null on the printer's own network, where the client is trusted. */
  role: PrinterRole | null;
}

/** SG-3's verdict on the setup a plate was sliced for (the client's own check). */
export type SetupMatch = 'match' | 'other-model' | 'edited-keep-out' | 'unknown-model';

/**
 * SG-1's verdict on the bytes to be uploaded (the client's own scan against the printer's keep-out table): `ok` with
 * the SHA-256 of the bytes scanned, `keep-out` with the scan's words, or `no-table` when the printer's model has none.
 */
export type KeepOutVerdict =
  | { ok: true; checksum: string }
  | { ok: false; reason: 'no-table' }
  | { ok: false; reason: 'keep-out'; message: string; detail: string };

/** The newest job of the printer's print history (server.history.list, limit 1, newest first). */
export interface LastJob {
  jobId: string;
  filename: string;
  /** in_progress, completed, cancelled, error, klippy_shutdown, klippy_disconnect, server_exit, interrupted. */
  status: string;
  /** Filament used in mm; null when the history does not say. */
  filamentUsed: number | null;
  endTime: number | null;
}

/** The history's newest job; `available` is false when the printer has no history (the method is unknown). */
export interface HistoryLast {
  available: boolean;
  job: LastJob | null;
}

/** SG-9 as a sheet shows it: the tick is asked, ticked, or not needed. */
export type PlateClearState = 'ask' | 'ticked' | 'not-needed';

/** The largest file sent through the relay (SG-12): 128 MiB. */
export const MAX_RELAY_BYTES = 128 * 1024 * 1024;

export type GateId = 'SG-1' | 'SG-2' | 'SG-3' | 'SG-4' | 'SG-5' | 'SG-6' | 'SG-7' | 'SG-8' | 'SG-9' | 'SG-12' | 'SG-13';

/** Why a gate holds the send back. */
export type GateReason =
  | 'keep-out' // SG-1: the bytes go through the printer's keep-out table
  | 'keep-out-unchecked' // SG-1: the scan has not run on these bytes yet
  | 'keep-out-unknown' // SG-1: no keep-out table is known for the printer's model
  | 'not-current' // SG-2: the plate's result is out of date (Slice)
  | 'other-model' // SG-3: sliced for another model (Slice for ‹printer›)
  | 'edited-keep-out' // SG-3: an M1 preset whose keep-out volumes are not the stock M1's (Slice for ‹printer›)
  | 'unknown-model' // SG-3: nothing says what the printer is
  | 'watch-only' // SG-4: a Viewer's printer is never a destination
  | 'offline' // SG-5: not online, or not reachable
  | 'connecting' // SG-5: the status connection is not open yet
  | 'not-ready' // SG-5: Klipper is not ready
  | 'starting' // SG-6: this tab is still watching its previous start on this printer
  | 'not-printable' // SG-6: a print state Print does not start from and Queue does not join
  | 'plate-removed' // SG-7
  | 'toolhead-disconnected' // SG-8
  | 'plate-clear' // SG-9: the person has not ticked "Plate is clear"
  | 'too-large' // SG-12: over the relay's limit
  | 'printer-changed'; // SG-13: a step for another printer than the send's

export type SendAction = 'print' | 'queue' | 'upload';

export interface GateFailure {
  gate: GateId;
  reason: GateReason;
  /** What it holds back. */
  blocks: readonly SendAction[];
}

/** A sliced plate as the gates read it: whether its result is current, its setup's match, its size and SG-1's verdict. */
export interface SlicedPlate {
  current: boolean;
  setup: SetupMatch;
  bytes: number;
  /** null until the scan has run on these bytes. */
  keepOut: KeepOutVerdict | null;
}

export interface GateInput {
  /** The printer the send is for. */
  ref: GatePrinter;
  /** The printer's status as the subscription keeps it (glance.ts). */
  view: StatusView;
  /** The account service's online flag, where there is one. */
  online?: boolean;
  /** The plates to send (null: nothing sliced yet). */
  plates: readonly SlicedPlate[] | null;
  /** SG-9's need (plateClearNeed) and whether the person ticked it. */
  plateClear: PlateClear;
  ticked: boolean;
  /** This tab is watching a start on this printer. */
  starting: boolean;
  /** SG-13: the send's printer key, while a send is running. */
  sendKey?: string | null;
}

export interface GateVerdict {
  /** Whether the printer is a destination at all (SG-4): a Viewer's is not. */
  destination: boolean;
  /** What the sheet offers: Queue while the printer prints or is paused, else Print. */
  mode: 'print' | 'queue';
  print: boolean;
  queue: boolean;
  uploadOnly: boolean;
  /** In the order a sheet shows them. */
  failures: GateFailure[];
  /** A warning only; Print stays (no filament at the toolhead's sensor). */
  warnings: 'no-filament'[];
  /** SG-9 as the sheet shows it. */
  plateClear: PlateClearState;
}

const ALL: readonly SendAction[] = ['print', 'queue', 'upload'];
const START: readonly SendAction[] = ['print', 'queue'];

/** The gates on a send to `input.ref`, now. */
export function evaluateGates(input: GateInput): GateVerdict {
  const { ref: printer, view } = input;
  const failures: GateFailure[] = [];
  const add = (gate: GateId, reason: GateReason, blocks: readonly SendAction[]) => failures.push({ gate, reason, blocks });
  const glance = readGlance(view.status);
  const connected = view.connection === 'open' && view.complete;
  const busy = connected && isBusy(glance.state);
  const mode = busy ? 'queue' : 'print';

  // SG-13: a step for another printer ends the send.
  if (input.sendKey != null && !samePrinter(input.sendKey, printer)) add('SG-13', 'printer-changed', ALL);
  // SG-4: an Operator or an Owner sends; a Viewer watches. No role is a trusted client on the printer's own network
  // only: an unknown role through the relay or a host is not taken for a privilege.
  const destination = printer.role === 'owner' || printer.role === 'operator' || (printer.role === null && printer.route === 'local');
  if (!destination) add('SG-4', 'watch-only', ALL);
  // SG-2, SG-3, SG-1, SG-12: the plates themselves.
  const plates = input.plates ?? [];
  if (!plates.length || plates.some((p) => !p.current)) add('SG-2', 'not-current', ALL);
  const setup = plates.map((p) => p.setup).find((s): s is Exclude<SetupMatch, 'match'> => s !== 'match');
  if (setup) add('SG-3', setup, ALL);
  const keepOut = plates.map((p) => p.keepOut);
  if (keepOut.some((k) => k && !k.ok && k.reason === 'keep-out')) add('SG-1', 'keep-out', ALL);
  else if (keepOut.some((k) => k && !k.ok && k.reason === 'no-table')) add('SG-1', 'keep-out-unknown', ALL);
  else if (plates.length && keepOut.some((k) => k === null)) add('SG-1', 'keep-out-unchecked', ALL);
  if (printer.route === 'cloud' && plates.some((p) => p.bytes > MAX_RELAY_BYTES)) add('SG-12', 'too-large', ALL);
  // SG-5: reachable. Upload only stays while the connection is open, even with Klipper not ready.
  if (input.online === false || view.connection === 'offline') add('SG-5', 'offline', ALL);
  else if (!connected) add('SG-5', 'connecting', ALL);
  else if (glance.klippy !== 'ready') add('SG-5', 'not-ready', START);
  else {
    // SG-6: the state. Print from standby, complete, cancelled, error; Queue while printing or paused.
    if (input.starting) add('SG-6', 'starting', START);
    else if (!busy && !canStartFrom(glance.state)) add('SG-6', 'not-printable', START);
    // SG-7, SG-8: the M1's plate and toolhead (a missing report counts as off).
    if (plateRemoved(glance, printer.model)) add('SG-7', 'plate-removed', START);
    if (toolheadDisconnected(glance, printer.model)) add('SG-8', 'toolhead-disconnected', START);
  }
  // SG-9: only a print onto the plate needs it.
  if (mode === 'print' && input.plateClear === 'ask' && !input.ticked) add('SG-9', 'plate-clear', ['print']);

  const allowed = (action: SendAction) => !failures.some((f) => f.blocks.includes(action));
  return {
    destination,
    mode,
    print: mode === 'print' && allowed('print'),
    queue: mode === 'queue' && allowed('queue'),
    uploadOnly: allowed('upload'),
    failures,
    warnings: connected && glance.filamentDetected === false ? ['no-filament'] : [],
    plateClear: input.plateClear === 'ask' ? (input.ticked ? 'ticked' : 'ask') : 'not-needed',
  };
}

// ---------------------------------------------------------------------------
// SG-9: plate clear
// ---------------------------------------------------------------------------

export type PlateClear = 'ask' | 'not-needed';

/** What the page saw of the plate since it read the history's newest job. */
export interface PlateCycle {
  /** The job the page read last, and whether it had ended when read. */
  jobId: string | null;
  ended: boolean;
  /** The plate came off after that read, and was put back after that (a cycle). */
  removed: boolean;
  cycled: boolean;
}

export const NO_PLATE_CYCLE: PlateCycle = Object.freeze({ jobId: null, ended: false, removed: false, cycled: false });

const ended = (history: HistoryLast) => history.job !== null && history.job.status !== 'in_progress';

/**
 * The cycle after a read of the history: unchanged while it shows the same job in the same phase; started over when
 * it shows another job, or the same job now ended (a cycle counts only after the page saw the job end).
 */
export function notePlateHistory(cycle: PlateCycle, history: HistoryLast): PlateCycle {
  const jobId = history.job?.jobId ?? null;
  const isEnded = ended(history);
  if (jobId === cycle.jobId && isEnded === cycle.ended) return cycle;
  return { jobId, ended: isEnded, removed: false, cycled: false };
}

/** The cycle after a plate report (bed_removal_detector.bedRemoved; null: no report). */
export function notePlate(cycle: PlateCycle, bedRemoved: boolean | null): PlateCycle {
  if (!cycle.ended || cycle.cycled || bedRemoved === null) return cycle;
  if (bedRemoved && !cycle.removed) return { ...cycle, removed: true };
  if (!bedRemoved && cycle.removed) return { ...cycle, cycled: true };
  return cycle;
}

/**
 * Whether Print asks for "Plate is clear": when the history's newest job is over and used filament (or does not say
 * how much), or is still running there, or the printer has no history, or it was not read (`history` null: not yet,
 * or the read failed); on the printer's own network not when the page saw a plate cycle after that job ended.
 *
 * A job still `in_progress` asks: Moonraker ends the job in its history a moment after print_stats reports
 * `complete`, so a sheet that read the history while the print ran, or right as it ended, would otherwise offer Print
 * onto the finished part. While the printer prints the sheet offers Queue, which SG-9 does not hold back.
 */
export function plateClearNeed(history: HistoryLast | null, transport: Transport, cycle: PlateCycle): PlateClear {
  if (!history || !history.available) return 'ask';
  const job = history.job;
  if (!job) return 'not-needed';
  if (job.status === 'in_progress') return 'ask';
  if (job.filamentUsed !== null && job.filamentUsed <= 0) return 'not-needed';
  if (transport === 'lan' && cycle.cycled && cycle.ended && cycle.jobId === job.jobId) return 'not-needed';
  return 'ask';
}

/** SG-13: whether a step's printer is the send's. */
export const samePrinter = (sendKey: string, printer: Pick<GatePrinter, 'key'>): boolean => sendKey === printer.key;
