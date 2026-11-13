// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/creality.ts), written by Muon 3D.
//
// Creality's stock firmware (K1, K2, Hi and their kin) on its WebSocket at port 9999 (or the port typed with its
// address): JSON telemetry, a field at a time, merged into one picture; `{"method":"get","params":{"ReqPrinterPara":1}}`
// asks for all of it; a heartbeat is answered `ok`. Pause, resume and stop are `set` commands. The firmware publishes no way for a page to upload a file
// or to start one, so neither is offered: a print starts on the printer's own screen.
import { fail } from '../errors/failure.ts';
import { printerError } from '../errors/kinds.ts';
import { brandEnv, emptyStatus, fraction, keepSocket, parseJson, record, seconds, socketAnswer, StatusHub, temp, text, withPort } from './live.ts';
import type { BrandAdapter, BrandCapabilities, BrandEnv, BrandProbe, BrandStatus, BrandTarget } from './types.ts';

export const CREALITY_CAPABILITIES: BrandCapabilities = { upload: false, startStored: false, listFiles: false, pauseResume: true, stop: true };

/** The firmware's own port. */
export const CREALITY_PORT = 9999;

const ASK_ALL = JSON.stringify({ method: 'get', params: { ReqPrinterPara: 1 } });

/** The status from the telemetry merged so far. `state`: 1 printing, 5 paused; an error code that is not 0 is an error. */
export function crealityStatus(t: Record<string, unknown>): BrandStatus {
  const err = record(t.err);
  const code = Number(err.errcode ?? 0);
  const state = Number(t.state);
  const active = state === 1 || state === 5;
  return {
    ...emptyStatus(),
    state: Number.isFinite(code) && code !== 0 ? 'error' : state === 5 ? 'paused' : state === 1 ? 'printing' : 'ready',
    message: Number.isFinite(code) && code !== 0 ? (text(err.errinfo) ?? `Error ${code}`) : null,
    file: text(t.printFileName),
    progress: active ? fraction(t.printProgress, true) : null,
    secondsLeft: active ? seconds(t.printLeftTime) : null,
    hotend: temp(t.nozzleTemp, t.targetNozzleTemp),
    bed: temp(t.bedTemp0, t.targetBedTemp0),
    chamber: temp(t.boxTemp, null),
  };
}

const socketUrl = (host: string) => `ws://${withPort(host, CREALITY_PORT)}`;

export function createCrealityAdapter(target: BrandTarget, env: Partial<BrandEnv> = {}): BrandAdapter {
  const e = brandEnv(env);
  let send: ((data: string) => void) | null = null;
  const hub = new StatusHub((h) => {
    let telemetry: Record<string, unknown> = {};
    const socket = keepSocket(e, h, socketUrl(target.host), undefined, {
      open(ws) {
        ws.send(ASK_ALL);
      },
      message(data, ws) {
        if (data === 'ok') return;
        const m = record(parseJson(data));
        if (m.ModeCode === 'heart_beat') {
          ws.send('ok');
          return;
        }
        if (!Object.keys(m).length) return;
        telemetry = { ...telemetry, ...m };
        h.set(crealityStatus(telemetry));
      },
    });
    send = socket.send;
    return () => {
      send = null;
      socket.end();
    };
  });
  const set = async (params: Record<string, number>) => {
    if (!send) throw fail(printerError('offline', 'The printer is not connected'));
    send(JSON.stringify({ method: 'set', params }));
  };
  return {
    kind: 'creality',
    capabilities: CREALITY_CAPABILITIES,
    status: () => hub.get(),
    subscribe: (listener) => hub.subscribe(listener),
    pause: () => set({ pause: 1 }),
    resume: () => set({ pause: 0 }),
    stop: () => set({ stop: 1 }),
    close: () => hub.close(),
  };
}

/**
 * Whether Creality's firmware answers at `target.host`: its host name and model from the first telemetry. No firmware
 * version: the telemetry's `modelVersion` lists the boards' hardware versions, which are no use to a person.
 */
export async function probeCreality(target: BrandTarget, env: Partial<BrandEnv> = {}): Promise<BrandProbe> {
  const e = brandEnv(env);
  let answered = false;
  const found = await socketAnswer(
    e,
    socketUrl(target.host),
    undefined,
    (ws) => {
      answered = true;
      ws.send(ASK_ALL);
    },
    (data) => {
      const m = record(parseJson(data));
      return 'model' in m || 'hostname' in m || 'nozzleTemp' in m ? m : null;
    },
  );
  if (!found) return { found: false, why: answered ? 'not-this-kind' : 'no-answer' };
  return { found: true, name: text(found.hostname), model: text(found.model), firmware: null };
}
