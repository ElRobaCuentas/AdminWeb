import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_INTERVAL_MS, watchLocal } from '../scripts/watch-local.ts';

describe('reloj local para eventos programados', () => {
  it('dispara cada minuto, espera cada llamada y solo usa la entrada local fija', async () => {
    const controller = new AbortController();
    let clock = 0;
    let inFlight = false;
    const starts: number[] = [];
    const waits: number[] = [];
    await watchLocal({
      signal: controller.signal, now: () => clock, report: () => {},
      fetchImpl: async (url, init) => {
        assert.equal(inFlight, false);
        inFlight = true;
        const target = new URL(String(url));
        assert.equal(target.origin, 'http://127.0.0.1:8787');
        assert.equal(target.pathname, '/cdn-cgi/local/scheduled');
        assert.equal(target.searchParams.get('cron'), '* * * * *');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        starts.push(clock);
        await Promise.resolve();
        clock += 5_000;
        inFlight = false;
        return new Response('ok');
      },
      sleep: async ms => {
        waits.push(ms);
        clock += ms;
        if (starts.length === 3) controller.abort();
      },
    });
    assert.equal(CHECK_INTERVAL_MS, 60_000);
    assert.deepEqual(starts, [0, 60_000, 120_000]);
    assert.deepEqual(waits, [55_000, 55_000, 55_000]);
  });

  it('continúa al minuto siguiente ante error HTTP o red sin exponer respuestas ni errores', async () => {
    const controller = new AbortController();
    const reports: string[] = [];
    let calls = 0;
    await watchLocal({
      signal: controller.signal, now: () => 0, report: message => reports.push(message),
      fetchImpl: async () => {
        if (++calls === 1) throw new Error('PRIVATE network details');
        return new Response('PRIVATE response', { status: calls === 2 ? 500 : 200 });
      },
      sleep: async ms => {
        assert.equal(ms, 60_000);
        if (calls === 3) controller.abort();
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(reports.map(message => JSON.parse(message).status), ['request-failed', 'failed', 'ok']);
    assert.ok(!reports.join('').includes('PRIVATE'));
  });

  it('cancelar interrumpe la llamada o la espera y no deja ciclos pendientes', async () => {
    for (const stage of ['request', 'sleep']) {
      const controller = new AbortController();
      let calls = 0;
      await watchLocal({
        signal: controller.signal, report: () => {},
        fetchImpl: async (_url, init) => {
          calls++;
          if (stage === 'request') {
            controller.abort();
            init?.signal?.throwIfAborted();
          }
          return new Response('ok');
        },
        sleep: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); },
      });
      assert.equal(calls, 1);
    }
  });
});
