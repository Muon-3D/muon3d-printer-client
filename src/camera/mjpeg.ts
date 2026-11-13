// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
//
// A printer's camera in a page, read with fetch: the JPEG pictures of an MJPEG stream (multipart/x-mixed-replace) as
// they come, or one picture at a time from a snapshot address. The page shows each as a blob: image. An <img> pointing
// at the printer would not do: a cross-origin-isolated page (COEP require-corp) refuses a picture from another origin
// that does not send Cross-Origin-Resource-Policy, and an HTTPS page has Chrome ask for a plain-HTTP picture over HTTPS.
// fetch can say the request is local (lanFetch), but the camera must then let the page read it (CORS:
// Access-Control-Allow-Origin, which mjpg-streamer sends); when it does not, the watch reports `unreachable`, which a
// page cannot tell apart from a camera that is off.

/** The longest picture read, in bytes: anything longer is not a camera's picture, and is dropped. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** Where a JPEG starts (FF D8 FF: SOI and the next marker) at or after `from`; -1 for none. */
function startOf(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 2 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) return i;
  return -1;
}

/**
 * Where the JPEG that starts at `start` ends (just after EOI): -1 while it is not all here, -2 when it is not a JPEG
 * after all. Marker segments are skipped by their length (so a thumbnail's FF D9 in an APP segment does not end it);
 * a scan's data runs to the next marker that is not a stuffed FF 00 or a restart.
 */
function endOf(bytes: Uint8Array, start: number): number {
  let p = start + 2;
  for (;;) {
    if (p + 1 >= bytes.length) return -1;
    if (bytes[p] !== 0xff) return -2;
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd9) return p + 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (p + 3 >= bytes.length) return -1;
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2) return -2;
    const next = p + 2 + length;
    if (marker !== 0xda) {
      p = next;
      continue;
    }
    let q = next;
    for (;;) {
      if (q + 1 >= bytes.length) return -1;
      if (bytes[q] !== 0xff) {
        q++;
        continue;
      }
      const m = bytes[q + 1];
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) q += 2;
      else if (m === 0xff) q++;
      else break;
    }
    p = q;
  }
}

/** Reads JPEG pictures out of bytes as they arrive (any framing around them is skipped): push() returns those completed. */
export function jpegFrames(): { push(chunk: Uint8Array): Uint8Array[] } {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = concat(buffer, chunk);
      const out: Uint8Array[] = [];
      for (;;) {
        const start = startOf(buffer, 0);
        if (start < 0) {
          // Keep the last two bytes: a picture may start across the next chunk.
          buffer = buffer.slice(Math.max(0, buffer.length - 2));
          break;
        }
        const end = endOf(buffer, start);
        if (end === -1) {
          buffer = buffer.length - start > MAX_FRAME_BYTES ? new Uint8Array(0) : buffer.slice(start);
          break;
        }
        if (end === -2) {
          buffer = buffer.slice(start + 2);
          continue;
        }
        out.push(buffer.slice(start, end));
        buffer = buffer.slice(end);
      }
      return out;
    },
  };
}

/** What a watch found wrong: nothing let the page read it (or nothing answered), or what answered is not a picture. */
export type CameraTrouble = 'unreachable' | 'not-a-picture';

export interface CameraWatchOptions {
  /** fetch for the local network (a page passes lanFetch). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Each picture, as a JPEG. */
  onFrame(picture: Blob): void;
  /** Called once, when the watch ends for a reason other than stop(). */
  onTrouble(trouble: CameraTrouble): void;
  /** At most one picture per this many ms from a stream (default 100: ten a second). */
  frameMs?: number;
  /** How long between snapshots, in ms (default 1000). */
  snapshotMs?: number;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  now?(): number;
}

/**
 * Watches a camera: `mjpeg` reads its stream's pictures as they come (an answer that is a single picture is asked for
 * again, as a snapshot), `snapshot` asks for a picture every `snapshotMs`. stop() ends it, with no onTrouble.
 */
export function watchCamera(camera: { kind: 'mjpeg' | 'snapshot'; url: string }, options: CameraWatchOptions): { stop(): void } {
  const g = globalThis as unknown as { fetch: NonNullable<CameraWatchOptions['fetch']>; setTimeout(cb: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  const fetchFn = options.fetch ?? ((url: string, init?: RequestInit) => g.fetch(url, init));
  const later = options.setTimeout ?? ((cb: () => void, ms: number) => g.setTimeout(cb, ms));
  const cancel = options.clearTimeout ?? ((h: unknown) => g.clearTimeout(h));
  const now = options.now ?? (() => Date.now());
  const frameMs = options.frameMs ?? 100;
  const snapshotMs = options.snapshotMs ?? 1000;
  const controller = new AbortController();
  let stopped = false;
  let timer: unknown = null;
  const trouble = (what: CameraTrouble) => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    options.onTrouble(what);
  };
  const show = (picture: Uint8Array) => {
    if (!stopped) options.onFrame(new Blob([picture as BlobPart], { type: 'image/jpeg' }));
  };

  const ask = async (): Promise<Response | null> => {
    try {
      const response = await fetchFn(camera.url, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
      if (!response.ok || !response.body) {
        trouble('unreachable');
        return null;
      }
      if (!/^(?:multipart\/|image\/)/i.test(response.headers.get('content-type') ?? '')) {
        trouble('not-a-picture');
        return null;
      }
      return response;
    } catch {
      trouble('unreachable');
      return null;
    }
  };

  const snapshots = async () => {
    while (!stopped) {
      const response = await ask();
      if (!response) return;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        return trouble('unreachable');
      }
      const pictures = jpegFrames().push(bytes);
      if (pictures.length === 0) return trouble('not-a-picture');
      show(pictures[pictures.length - 1]);
      await new Promise<void>((resolve) => {
        timer = later(resolve, snapshotMs);
      });
    }
  };

  const stream = async () => {
    const response = await ask();
    if (!response) return;
    if (/^image\//i.test(response.headers.get('content-type') ?? '')) {
      // A single picture: this camera is read a picture at a time.
      const pictures = jpegFrames().push(new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0))));
      if (pictures.length === 0) return trouble('not-a-picture');
      show(pictures[pictures.length - 1]);
      await new Promise<void>((resolve) => {
        timer = later(resolve, snapshotMs);
      });
      return snapshots();
    }
    const reader = response.body!.getReader();
    const frames = jpegFrames();
    let shownAt = -Infinity;
    let waiting: Uint8Array | null = null;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done || stopped) break;
      for (const picture of frames.push(chunk.value)) waiting = picture;
      if (waiting && now() - shownAt >= frameMs) {
        show(waiting);
        waiting = null;
        shownAt = now();
      }
    }
    if (waiting) show(waiting);
    trouble('unreachable');
  };

  void (camera.kind === 'snapshot' ? snapshots() : stream());
  return {
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      controller.abort();
    },
  };
}
