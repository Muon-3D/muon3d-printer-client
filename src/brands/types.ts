// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/types.ts), written by Muon 3D.
//
// Printers of other kinds a page reaches directly on the local network: Klipper through its Moonraker, OctoPrint,
// Creality's stock firmware and Elegoo's SDCP. One adapter per kind, each its own entry point, so a client loads only
// the kinds it has. What every adapter shares: the printer it talks to, what it reports, what it can do, and the
// browser parts it uses (so it can be tested).

/** The kinds a page can reach directly. */
export type BrandKind = 'moonraker' | 'octoprint' | 'creality' | 'elegoo-sdcp';

/** What a printer is doing, as an adapter reads it. */
export type BrandState = 'connecting' | 'ready' | 'printing' | 'paused' | 'error' | 'offline';

/** A temperature now, and what it is heading for (null when it is not heating). */
export interface BrandTemp {
  now: number;
  target: number | null;
}

export interface BrandStatus {
  state: BrandState;
  /** The printer's own words about its state, when it gave some (an error's text, OctoPrint's state text). */
  message: string | null;
  /** The file it is printing or last printed, as the printer names it. */
  file: string | null;
  /** 0–1 of the file printed, or null. */
  progress: number | null;
  /** Seconds left, as the printer reckons them, or null. */
  secondsLeft: number | null;
  hotend: BrandTemp | null;
  bed: BrandTemp | null;
  chamber: BrandTemp | null;
  /** Its job queue, for kinds with `queue`: null when the printer has none set up, absent until it is read. */
  queue?: BrandQueue | null;
}

/** What a kind can do from a page. */
export interface BrandCapabilities {
  /** Take a file from the page (an upload), and start it. */
  upload: boolean;
  /** Start a file already on the printer. */
  startStored: boolean;
  /** List the files on the printer. */
  listFiles: boolean;
  pauseResume: boolean;
  stop: boolean;
  /** Say where its camera is (cameras()). */
  camera: boolean;
  /** Keep a queue of jobs that start one after another (queue). */
  queue: boolean;
}

/** A camera a printer publishes, as a page can show it. */
export interface BrandCamera {
  name: string;
  /**
   * How a page draws it: `mjpeg` reads the stream's pictures as they come, `snapshot` asks for one picture at a time.
   * `other` (WebRTC, HLS and the like) is not drawn by a page here: open `pageUrl`.
   */
  kind: 'mjpeg' | 'snapshot' | 'other';
  /** What to read for the picture (an absolute http URL); null for `other`. */
  url: string | null;
  /** The camera's own address, to open in a tab. */
  pageUrl: string;
  flipH: boolean;
  flipV: boolean;
  /** Clockwise, in degrees. */
  rotation: 0 | 90 | 180 | 270;
}

/** A job waiting in a printer's queue. */
export interface BrandQueueJob {
  id: string;
  /** The file, as the printer names it. */
  filename: string;
  /** When it was added (ms since 1970), or null. */
  addedAt: number | null;
}

/** A printer's job queue (Moonraker's). */
export interface BrandQueue {
  /**
   * - `ready`: the next job starts by itself when the printer is free.
   * - `paused`: nothing starts by itself.
   * - `loading`, `starting`: the next job is starting.
   */
  state: 'ready' | 'paused' | 'loading' | 'starting';
  jobs: BrandQueueJob[];
}

/** What a page can do with a printer's queue (kinds with `queue`). */
export interface BrandQueueControl {
  /** Adds files already on the printer, in order, at the end. */
  add(paths: string[]): Promise<void>;
  remove(jobIds: string[]): Promise<void>;
  /** Lets the queue start its next job (now, when the printer is free). */
  start(): Promise<void>;
  /** Stops the queue starting jobs by itself; a print under way carries on. */
  pause(): Promise<void>;
}

/** What a printer may need from the person: an API key, required or optional, or nothing. */
export type BrandKey = 'required' | 'optional' | 'none';

/** The printer an adapter talks to. */
export interface BrandTarget {
  /** Its address on the local network: a name or an IP address, with a port where it is not the kind's own. */
  host: string;
  /** Its API key, where the kind uses one. */
  apiKey?: string | null;
}

/** A file on the printer. */
export interface BrandFile {
  path: string;
  name: string;
}

/** A file from the page. */
export interface BrandUpload {
  name: string;
  bytes: Uint8Array;
}

export interface BrandAdapter {
  readonly kind: BrandKind;
  readonly capabilities: BrandCapabilities;
  /** The status as last read (`connecting` until the first answer). */
  status(): BrandStatus;
  /** Status as it changes; the first subscriber opens the connection, the last one's leaving closes it. */
  subscribe(listener: (status: BrandStatus) => void): () => void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  /** Uploads the file and, with `start`, starts it (kinds with `upload`). Resolves to its path on the printer. */
  upload?(file: BrandUpload, options?: { start?: boolean; signal?: AbortSignal }): Promise<string>;
  listFiles?(): Promise<BrandFile[]>;
  /** Starts a file already on the printer (kinds with `startStored`). */
  startFile?(path: string): Promise<void>;
  /** The cameras it publishes (kinds with `camera`); none: an empty list. */
  cameras?(): Promise<BrandCamera[]>;
  /** Its job queue (kinds with `queue`); the queue itself arrives with the status. */
  queue?: BrandQueueControl;
  /** Ends the connection and every timer; the adapter is not used again. */
  close(): void;
}

/** What answered at an address that was tried as a kind. */
export type BrandProbe =
  | { found: true; name: string | null; model: string | null; firmware: string | null }
  | {
      found: false;
      /**
       * - `no-answer`: nothing answered, or the printer does not let this page in (its CORS setting): from a page the
       *   two look the same.
       * - `needs-key`: it answered and wants an API key.
       * - `wrong-key`: the key given was refused.
       * - `not-this-kind`: something answered, but not as this kind does.
       */
      why: 'no-answer' | 'needs-key' | 'wrong-key' | 'not-this-kind';
    };

/** The browser parts an adapter uses. Any left out are the browser's own. */
export interface BrandEnv {
  /** fetch for the local network (lanFetch: declares the request local on an HTTPS page). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  WebSocket: new (url: string, protocols?: string | string[]) => WebSocket;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Wall-clock time in ms. */
  now(): number;
  /** A random id (SDCP's request ids). */
  randomId(): string;
}
