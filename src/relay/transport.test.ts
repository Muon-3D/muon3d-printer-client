// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/managed-transport/__tests__/managed-transport.spec.ts and managed-transport-redial.spec.ts), written by Muon 3D.
// One printer through the relay (transport.ts): dialled on the first request and shared by HTTP and WebSocket
// traffic; a connection that failed a request dropped and dialled again, later each time; a new grant after two failed
// dials, refused when it is for another printer; and close, which ends it all, a late dial included.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failureOf } from '../errors/failure.ts';
import type { PrinterSocket, PrinterSocketListener, RelayPrinter } from './printer.ts';
import { createRelayTransport, type RelayGrant, type RelayStatus } from './transport.ts';

const GRANT: RelayGrant = { printerId: 'p'.repeat(64), relayUrl: 'https://relay.example/', expiresAt: 4_000_000_000 };

function contractSocket(): PrinterSocket & { fireClose: () => void; closed: number } {
  const listeners: PrinterSocketListener[] = [];
  const socket = {
    readyState: 1,
    closed: 0,
    send: () => undefined,
    close: () => {
      socket.closed++;
    },
    addEventListener: (type: string, listener: PrinterSocketListener) => {
      if (type === 'close') listeners.push(listener);
    },
    removeEventListener: () => undefined,
    fireClose: () => listeners.forEach((l) => l({ code: 1000 })),
  };
  return socket;
}

/** A connection whose requests fail once it is "lost". */
function relay(name: string, log: string[]): RelayPrinter & { lose: () => void } {
  let lost = false;
  return {
    fetch: async () => {
      if (lost) throw new Error('connection lost');
      log.push(`${name}:fetch`);
      return new Response(null, { status: 204 });
    },
    openWebSocket: async () => contractSocket(),
    close: () => void log.push(`${name}:close`),
    lose: () => {
      lost = true;
    },
  };
}

/** A clock the test moves, and a sleep that waits for it. */
function fakeTime() {
  let now = 0;
  const sleepers: { until: number; wake: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((wake) => sleepers.push({ until: now + ms, wake })),
    async advance(ms: number) {
      now += ms;
      for (const s of sleepers.filter((x) => x.until <= now)) {
        sleepers.splice(sleepers.indexOf(s), 1);
        s.wake();
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    waiting: () => sleepers.length,
  };
}

describe('the relay transport', () => {
  it('dials on the first request, not before, and shares one connection across HTTP and WebSocket traffic', async () => {
    const log: string[] = [];
    const dials: RelayGrant[] = [];
    const statuses: string[] = [];
    const transport = createRelayTransport({
      grant: GRANT,
      dial: async (g) => {
        dials.push(g);
        return relay('one', log);
      },
      onStatus: (s: RelayStatus) => statuses.push(`${s.connection}:${s.usage}`),
    });
    assert.equal(dials.length, 0);
    assert.deepEqual(transport.status, { connection: 'idle', usage: 'idle' });
    assert.equal((await transport.fetch('/server/info')).status, 204);
    const socket = await transport.openWebSocket('/websocket');
    assert.deepEqual(dials, [GRANT]);
    assert.deepEqual(transport.status, { connection: 'connected', usage: 'websocket' });
    await transport.fetch('/server/files/upload', { method: 'POST' }, 'upload');
    assert.ok(statuses.includes('connecting:upload'));
    assert.deepEqual(transport.status, { connection: 'connected', usage: 'websocket' }, 'the socket is still open');
    (socket as ReturnType<typeof contractSocket>).fireClose();
    assert.deepEqual(transport.status, { connection: 'connected', usage: 'idle' });
  });

  it('drops a connection that failed a request, and dials a new one for the next', async () => {
    const log: string[] = [];
    const first = relay('first', log);
    const second = relay('second', log);
    const connections = [first, second];
    const transport = createRelayTransport({ grant: GRANT, dial: async () => connections.shift()! });
    await transport.fetch('/server/info');
    first.lose();
    await assert.rejects(transport.fetch('/server/info'), /connection lost/);
    assert.equal(transport.status.connection, 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 1));
    await transport.fetch('/server/info');
    assert.deepEqual(log, ['first:fetch', 'first:close', 'second:fetch']);
  });

  it('waits longer after each failed dial, and asks for a new grant after two', async () => {
    const time = fakeTime();
    const log: string[] = [];
    const tried: string[] = [];
    let regrants = 0;
    const transport = createRelayTransport({
      grant: { ...GRANT, relayUrl: 'https://relay-1.example/' },
      dial: async (g) => {
        tried.push(g.relayUrl);
        if (g.relayUrl === 'https://relay-1.example/') throw new Error('refused');
        return relay('fresh', log);
      },
      regrant: async () => {
        regrants++;
        return { ...GRANT, relayUrl: 'https://relay-2.example/' };
      },
      now: time.now,
      sleep: time.sleep,
    });
    await assert.rejects(transport.fetch('/server/info'), /refused/);
    // The second dial waits a second before going out.
    const second = transport.fetch('/server/info');
    second.catch(() => undefined);
    await time.advance(999);
    assert.equal(tried.length, 1);
    await time.advance(1);
    await assert.rejects(second, /refused/);
    assert.equal(regrants, 0);
    // Two failures: the third dial asks for a new grant first, two seconds on.
    const third = transport.fetch('/server/info');
    await time.advance(1999);
    assert.equal(regrants, 0);
    await time.advance(1);
    await third;
    assert.equal(regrants, 1);
    assert.deepEqual(tried, ['https://relay-1.example/', 'https://relay-1.example/', 'https://relay-2.example/']);
    assert.deepEqual(log, ['fresh:fetch']);
  });

  it('refuses a new grant for another printer, or one that has ended', async () => {
    for (const bad of [{ ...GRANT, printerId: 'q'.repeat(64) }, { ...GRANT, expiresAt: 1 }]) {
      let failures = 0;
      const transport = createRelayTransport({
        grant: GRANT,
        dial: async () => {
          failures++;
          throw new Error('refused');
        },
        regrant: async () => bad,
        sleep: async () => undefined,
      });
      await assert.rejects(transport.fetch('/x'));
      await assert.rejects(transport.fetch('/x'));
      await assert.rejects(transport.fetch('/x'), (err) => failureOf(err).kind === 'protocol');
      assert.equal(failures, 2, 'nothing is dialled with it');
    }
  });

  it('closes a late connection when the transport has closed, and every socket and connection on close', async () => {
    let arrive!: (r: RelayPrinter) => void;
    const log: string[] = [];
    const late = createRelayTransport({ grant: GRANT, dial: () => new Promise((resolve) => (arrive = resolve)) });
    const inFlight = late.fetch('/server/info');
    await new Promise((resolve) => setTimeout(resolve, 1));
    late.close();
    arrive(relay('late', log));
    await assert.rejects(inFlight, (err) => failureOf(err).kind === 'cancelled');
    assert.deepEqual(log, ['late:close']);
    assert.equal(late.status.connection, 'closed');
    await assert.rejects(late.fetch('/x'), (err) => failureOf(err).kind === 'cancelled');

    const open = createRelayTransport({ grant: GRANT, dial: async () => relay('open', log) });
    const socket = (await open.openWebSocket('/websocket')) as ReturnType<typeof contractSocket>;
    open.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(socket.closed, 1);
    assert.deepEqual(log, ['late:close', 'open:close']);
    assert.deepEqual(open.status, { connection: 'closed', usage: 'idle' });
  });
});
