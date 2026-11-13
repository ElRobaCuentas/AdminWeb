import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import worker, { readAndEvaluate } from '../src/index.ts';
import type { Env } from '../src/index.ts';
import { MemoryError } from '../src/trackingStore.ts';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const root = fileURLToPath(new NodeURL('../', import.meta.url));
let scratch: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

async function open() {
  proxy = await getPlatformProxy<Env>({
    configPath: path.join(root, 'wrangler.jsonc'), environment: 'memory-local',
    remoteBindings: false, envFiles: [], persist: { path: scratch },
  });
  assert.ok(proxy.env.PULSO_DB);
  db = proxy.env.PULSO_DB;
}
function env(overrides: Partial<Env> = {}): Env {
  return {
    PULSO_LOCAL_ONLY: 'true', PULSO_MEMORY: 'd1-local', PULSO_DB: db,
    RTDB_ORIGIN: 'http://127.0.0.1:9000', RTDB_NAMESPACE: 'demo-pulso-memory', BUS_ID: 'MEMORY-TEST',
    PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2',
    MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '1000', ...overrides,
  };
}
function payload(at: number) {
  return { isActive: true, timestamp: at - 10_000, latitude: -12.05123, longitude: -77.08123, heading: 0, speed: 0 };
}
const auth = { getIdToken: async () => 'PRIVATE_TEST_TOKEN' };
function check(at = NOW, data: unknown = payload(at), overrides: Partial<Env> = {}) {
  return readAndEvaluate(env(overrides), { auth, now: () => at, fetchImpl: async () => new Response(JSON.stringify(data)) });
}
async function rows(table: 'tracking_state' | 'tracking_observations') {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY source_key, bus_id, revision`).all()).results;
}
async function snapshot() { return JSON.stringify([await rows('tracking_state'), await rows('tracking_observations')]); }
const memoryFailure = (code: string) => (error: unknown) => error instanceof MemoryError && error.code === code && error.message === code;

before(async () => {
  const parent = path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(path.join(parent, 'pulso-d1-test-'));
  await open();
  const migration = await readFile(new NodeURL('../migrations/0001_tracking_memory.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
});
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM tracking_observations'), db.prepare('DELETE FROM tracking_state')]);
});
after(async () => {
  await proxy?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('memoria real D1 local, con RTDB simulada', () => {
  it('la primera evaluación guarda snapshot e historial sin secretos ni coordenadas históricas', async () => {
    const result = await check(NOW, { ...payload(NOW), privateToken: 'PRIVATE_TEST_TOKEN' });
    assert.equal(result.continuity, 'persisted');
    assert.equal(result.memory?.revision, 1);
    assert.equal(result.memory?.reusedPrevious, false);
    const states = await rows('tracking_state');
    const observations = await rows('tracking_observations');
    assert.equal(states.length, 1);
    assert.equal(observations.length, 1);
    assert.equal(states[0].last_check_id, observations[0].check_id);
    assert.equal(JSON.parse(String(states[0].prior_state_json)).lastLatitude, -12.05123);
    assert.ok(!JSON.stringify(observations).includes('-12.05123'));
    assert.ok(!JSON.stringify(observations).includes('-77.08123'));
    const summary = JSON.parse(String(observations[0].summary_json));
    assert.equal(Object.hasOwn(summary.input, 'longitude'), false);
    assert.ok(!(await snapshot()).includes('PRIVATE_TEST_TOKEN'));
    assert.ok(!JSON.stringify(result).includes('-12.05123'));
  });

  it('reutiliza el estado y confirma recuperación solo con dos publicaciones válidas crecientes', async () => {
    assert.equal((await check()).evaluation.classification, 'active-publishing');
    assert.equal((await check(NOW + 240_000, payload(NOW))).evaluation.classification, 'active-publication-stale');
    const first = await check(NOW + 300_000);
    assert.equal(first.evaluation.classification, 'recovering-pending');
    assert.equal(first.evaluation.recoveryValidObservations, 1);
    const repeated = await check(NOW + 310_000, payload(NOW + 300_000));
    assert.equal(repeated.evaluation.recoveryValidObservations, 1);
    assert.equal(repeated.evaluation.classification, 'recovering-pending');
    const recovered = await check(NOW + 360_000);
    assert.equal(recovered.evaluation.classification, 'recovering-confirmed');
    assert.equal(recovered.evaluation.recoveryValidObservations, 2);
    assert.equal(recovered.memory?.revision, 5);
    assert.equal((await rows('tracking_observations')).length, 5);
  });

  it('conserva memoria tras el reinicio del runtime de D1 y una nueva instancia', async () => {
    await check(NOW, { ...payload(NOW), timestamp: NOW - 240_000 });
    await proxy.dispose();
    await open();
    const result = await check(NOW + 60_000);
    assert.equal(result.memory?.reusedPrevious, true);
    assert.equal(result.memory?.revision, 2);
    assert.equal(result.evaluation.classification, 'recovering-pending');
    assert.equal((await rows('tracking_observations')).length, 2);
  });

  it('persiste fallo de Firebase conservando una recuperación pendiente', async () => {
    await check(NOW, { ...payload(NOW), timestamp: NOW - 240_000 });
    await check(NOW + 60_000);
    const result = await readAndEvaluate(env(), {
      auth, now: () => NOW + 120_000, fetchImpl: async () => { throw new Error('PRIVATE NETWORK URL'); },
    });
    assert.equal(result.continuity, 'persisted');
    assert.equal(result.source.error, 'network-error');
    assert.equal(result.evaluation.classification, 'source-unavailable');
    assert.equal(result.evaluation.recoveryState, 'pending');
    assert.equal(result.evaluation.recoveryValidObservations, 1);
    assert.ok(!(await snapshot()).includes('PRIVATE'));
    assert.equal((await check(NOW + 180_000)).evaluation.classification, 'recovering-confirmed');
  });

  it('distingue información ausente e inactividad sin inventar finalización', async () => {
    await check(NOW, { ...payload(NOW), timestamp: NOW - 240_000 });
    assert.equal((await check(NOW + 60_000, null)).evaluation.classification, 'insufficient-data');
    const result = await check(NOW + 120_000, { isActive: false });
    assert.equal(result.evaluation.classification, 'inactive-unconfirmed');
    assert.equal(result.evaluation.recoveryState, 'none');
  });

  it('aísla memoria por fuente y bus', async () => {
    await check(NOW, { ...payload(NOW), timestamp: NOW - 240_000 });
    const otherBus = await check(NOW + 60_000, payload(NOW + 60_000), { BUS_ID: 'OTHER-TEST' });
    const otherSource = await check(NOW + 60_000, payload(NOW + 60_000), { RTDB_NAMESPACE: 'demo-other-memory' });
    assert.equal(otherBus.evaluation.classification, 'active-publishing');
    assert.equal(otherSource.memory?.revision, 1);
    assert.equal((await rows('tracking_state')).length, 3);
  });

  it('la memoria desactivada ignora D1 y conserva el modo manual anterior', async () => {
    const broken = { prepare: () => { throw new Error('Must not access D1'); } } as unknown as D1Database;
    const result = await check(NOW, payload(NOW), { PULSO_MEMORY: 'off', PULSO_DB: broken });
    assert.equal(result.continuity, 'not-persisted');
    assert.equal(result.memory, undefined);
    assert.equal((await rows('tracking_state')).length, 0);
  });

  it('D1 ausente o ilegible no provoca consultas a Firebase ni fallback', async () => {
    for (const database of [undefined, { prepare: () => { throw new Error('PRIVATE DB'); } } as unknown as D1Database]) {
      await assert.rejects(readAndEvaluate(env({ PULSO_DB: database }), {
        auth, fetchImpl: async () => assert.fail('Firebase must not be queried'),
      }), memoryFailure(database ? 'memory-read-failed' : 'memory-unavailable'));
    }
  });

  for (const [name, sql, override, code] of [
    ['snapshot inválido', "UPDATE tracking_state SET prior_state_json = '{}'", {}, 'memory-state-invalid'],
    ['estado de recuperación no textual', `UPDATE tracking_state SET prior_state_json = json_set(prior_state_json, '$.recoveryState', json('["pending"]'))`, {}, 'memory-state-invalid'],
    ['versión incompatible', 'UPDATE tracking_state SET state_version = 2', {}, 'memory-state-incompatible'],
    ['umbrales diferentes', '', { RECOVERY_CONFIRMATIONS_REQUIRED: '3' }, 'memory-state-incompatible'],
  ] as const) {
    it(`rechaza ${name} antes de leer Firebase`, async () => {
      await check();
      if (sql) await db.prepare(sql).run();
      const before = await snapshot();
      await assert.rejects(readAndEvaluate(env(override), {
        auth, fetchImpl: async () => assert.fail('Firebase must not be queried'),
      }), memoryFailure(code));
      assert.equal(await snapshot(), before);
    });
  }

  it('un fallo SQL al guardar revierte snapshot e historial completos', async () => {
    await check();
    const before = await snapshot();
    await db.prepare("CREATE TRIGGER reject_observation BEFORE INSERT ON tracking_observations BEGIN SELECT RAISE(ABORT, 'PRIVATE SQL ERROR'); END").run();
    try {
      await assert.rejects(check(NOW + 60_000), memoryFailure('memory-write-failed'));
      assert.equal(await snapshot(), before);
    } finally {
      await db.prepare('DROP TRIGGER reject_observation').run();
    }
  });

  it('dos evaluaciones simultáneas producen un ganador y un conflicto, sin filas parciales', async () => {
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = async () => {
      waiting++;
      if (waiting === 2) release();
      await barrier;
      return new Response(JSON.stringify(payload(NOW)));
    };
    const results = await Promise.allSettled([
      readAndEvaluate(env(), { auth, fetchImpl, now: () => NOW }),
      readAndEvaluate(env(), { auth, fetchImpl, now: () => NOW }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && memoryFailure('memory-conflict')(rejected.reason));
    assert.equal((await rows('tracking_state'))[0].revision, 1);
    assert.equal((await rows('tracking_observations')).length, 1);
  });

  it('una evaluación lenta no sobrescribe una comprobación más nueva', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const delay = new Promise<void>(resolve => { release = resolve; });
    const slow = readAndEvaluate(env(), { auth, now: () => NOW + 120_000, fetchImpl: async () => {
      started(); await delay; return new Response(JSON.stringify(payload(NOW)));
    } });
    await ready;
    await check(NOW + 60_000);
    const before = await snapshot();
    release();
    await assert.rejects(slow, memoryFailure('memory-conflict'));
    assert.equal(await snapshot(), before);
  });

  it('un snapshot anterior no sobrescribe una memoria recreada con la misma revisión', async () => {
    await check();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const delay = new Promise<void>(resolve => { release = resolve; });
    const slow = readAndEvaluate(env(), { auth, now: () => NOW + 120_000, fetchImpl: async () => {
      started(); await delay; return new Response(JSON.stringify(payload(NOW + 120_000)));
    } });
    await ready;
    await db.batch([db.prepare('DELETE FROM tracking_observations'), db.prepare('DELETE FROM tracking_state')]);
    await check(NOW + 60_000);
    const before = await snapshot();
    release();
    await assert.rejects(slow, memoryFailure('memory-conflict'));
    assert.equal(await snapshot(), before);
  });

  it('elimina historial de más de siete días sin borrar el snapshot actual', async () => {
    await check(NOW - 8 * DAY);
    await check(NOW);
    assert.equal((await rows('tracking_state')).length, 1);
    const history = await rows('tracking_observations');
    assert.equal(history.length, 1);
    assert.equal(history[0].evaluated_at, NOW);
  });

  it('HTTP distingue un fallo de memoria de una mala configuración o fallo del bus', async () => {
    const response = await worker.fetch(new Request('http://127.0.0.1:8787/evaluate', { headers: { 'X-Pulso-Local': '1' } }), env({ PULSO_DB: undefined }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'memory-unavailable' });
  });

  it('revierte el batch completo si falla la poda final', async () => {
    await check(NOW - 8 * DAY);
    const before = await snapshot();
    await db.prepare("CREATE TRIGGER reject_prune BEFORE DELETE ON tracking_observations BEGIN SELECT RAISE(ABORT, 'PRIVATE PRUNE ERROR'); END").run();
    try {
      await assert.rejects(check(NOW), memoryFailure('memory-write-failed'));
      assert.equal(await snapshot(), before);
    } finally {
      await db.prepare('DROP TRIGGER reject_prune').run();
    }
  });

  it('un reloj anterior no modifica estado ni historial', async () => {
    await check(NOW);
    const before = await snapshot();
    await assert.rejects(check(NOW - 1), memoryFailure('memory-conflict'));
    assert.equal(await snapshot(), before);
  });

  it('un snapshot JSON null falla antes de consultar la fuente', async () => {
    await check();
    await db.prepare("UPDATE tracking_state SET prior_state_json = 'null'").run();
    const before = await snapshot();
    await assert.rejects(readAndEvaluate(env(), {
      auth, now: () => NOW + 1, fetchImpl: async () => assert.fail('No debe consultar la fuente'),
    }), memoryFailure('memory-state-invalid'));
    assert.equal(await snapshot(), before);
  });

  it('las actualizaciones concurrentes no duplican una confirmación', async () => {
    await check(NOW, { ...payload(NOW), timestamp: NOW - 240_000 });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const slow = readAndEvaluate(env(), {
      auth, now: () => NOW + 60_000, fetchImpl: async () => {
        started(); await wait; return new Response(JSON.stringify(payload(NOW + 60_000)));
      },
    });
    await ready;
    assert.equal((await check(NOW + 60_000)).evaluation.recoveryValidObservations, 1);
    const before = await snapshot();
    release();
    await assert.rejects(slow, memoryFailure('memory-conflict'));
    assert.equal(await snapshot(), before);
    assert.equal((await check(NOW + 60_001, payload(NOW + 60_000))).evaluation.recoveryValidObservations, 1);
  });
});
