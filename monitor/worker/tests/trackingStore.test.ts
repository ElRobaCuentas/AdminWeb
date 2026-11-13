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
function unavailable(at: number, overrides: Partial<Env> = {}) {
  return readAndEvaluate(env(overrides), { auth, now: () => at, fetchImpl: async () => { throw new Error('PRIVATE NETWORK ERROR'); } });
}
async function rows(table: 'tracking_state' | 'tracking_observations' | 'tracking_incidents') {
  const order = table === 'tracking_incidents' ? 'opened_at, incident_id' : 'source_key, bus_id, revision';
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results;
}
async function snapshot() { return JSON.stringify([await rows('tracking_state'), await rows('tracking_observations'), await rows('tracking_incidents')]); }
const memoryFailure = (code: string) => (error: unknown) => error instanceof MemoryError && error.code === code && error.message === code;

before(async () => {
  const parent = path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(path.join(parent, 'pulso-d1-test-'));
  await open();
  for (const name of ['0001_tracking_memory.sql', '0002_tracking_incidents.sql']) {
    const migration = await readFile(new NodeURL(`../migrations/${name}`, import.meta.url), 'utf8');
    await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  }
});
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM tracking_incidents'), db.prepare('DELETE FROM tracking_observations'), db.prepare('DELETE FROM tracking_state')]);
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
    await db.batch([db.prepare('DELETE FROM tracking_incidents'), db.prepare('DELETE FROM tracking_observations'), db.prepare('DELETE FROM tracking_state')]);
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

  it('no abre incidentes antes de observar actividad ni después de observar una parada', async () => {
    await unavailable(NOW);
    await check(NOW + 1, null);
    await unavailable(NOW + 2);
    await check(NOW + 3, { isActive: false });
    await unavailable(NOW + 4);
    assert.equal((await rows('tracking_incidents')).length, 0);
    assert.equal((await rows('tracking_state'))[0].monitoring_active, 0);
  });

  it('publicaciones sanas y coordenadas repetidas no abren incidentes', async () => {
    await check();
    await check(NOW + 60_000);
    assert.equal((await rows('tracking_incidents')).length, 0);
    assert.equal((await rows('tracking_state'))[0].monitoring_active, 1);
  });

  it('abre al superar tres minutos y actualiza el mismo incidente continuo', async () => {
    const data = { ...payload(NOW), timestamp: NOW };
    await check(NOW, data);
    await check(NOW + 180_000, data);
    assert.equal((await rows('tracking_incidents')).length, 0);
    await check(NOW + 180_001, data);
    const first = (await rows('tracking_incidents'))[0];
    await check(NOW + 240_000, data);
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].incident_id, first.incident_id);
    assert.equal(incidents[0].kind, 'tracking-interrupted');
    assert.equal(incidents[0].opened_at, NOW + 180_001);
    assert.equal(incidents[0].updated_at, NOW + 240_000);
    assert.equal(incidents[0].check_count, 2);
    assert.equal(incidents[0].closed_at, null);
  });

  it('cierra seguimiento solo con dos publicaciones crecientes, sin contar lecturas repetidas', async () => {
    await check(NOW, payload(NOW - 240_000));
    await check(NOW + 60_000);
    await check(NOW + 61_000, payload(NOW + 60_000));
    assert.equal((await rows('tracking_incidents'))[0].closed_at, null);
    await check(NOW + 120_000);
    const incident = (await rows('tracking_incidents'))[0];
    assert.equal(incident.close_reason, 'publications-recovered');
    assert.equal(incident.closed_at, NOW + 120_000);
    assert.equal(incident.duration_ms, 120_000);
    assert.equal(incident.check_count, 4);
    await check(NOW + 180_000);
    assert.deepEqual((await rows('tracking_incidents'))[0], incident);
    await check(NOW + 420_000, payload(NOW + 180_000));
    assert.equal((await rows('tracking_incidents')).length, 2);
  });

  it('una recaída durante recuperación conserva el incidente y exige dos confirmaciones nuevas', async () => {
    await check(NOW, payload(NOW - 240_000));
    const id = (await rows('tracking_incidents'))[0].incident_id;
    await check(NOW + 60_000);
    await check(NOW + 300_000, payload(NOW + 60_000));
    await check(NOW + 360_000);
    assert.equal((await rows('tracking_incidents'))[0].closed_at, null);
    await check(NOW + 420_000);
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].incident_id, id);
    assert.equal(incidents[0].close_reason, 'publications-recovered');
  });

  it('fuente inaccesible se abre una vez durante vigilancia y cierra al volver aunque siga desactualizado', async () => {
    await check();
    await unavailable(NOW + 60_000);
    await unavailable(NOW + 120_000);
    let incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].kind, 'source-unavailable');
    assert.equal(incidents[0].check_count, 2);
    await check(NOW + 240_000, payload(NOW));
    incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].close_reason, 'source-accessible');
    assert.equal(incidents[0].duration_ms, 180_000);
    assert.equal(incidents[1].kind, 'tracking-interrupted');
    assert.equal(incidents[1].closed_at, null);
    await unavailable(NOW + 300_000);
    incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 3);
    assert.equal(incidents[1].closed_at, null);
    assert.equal(incidents[2].kind, 'source-unavailable');
  });

  it('ambos incidentes pueden coexistir sin perder recuperación pendiente ante fallo de fuente', async () => {
    await check(NOW, payload(NOW - 240_000));
    await check(NOW + 60_000);
    await unavailable(NOW + 120_000);
    const open = await rows('tracking_incidents');
    assert.equal(open.length, 2);
    assert.ok(open.every(incident => incident.closed_at === null));
    await check(NOW + 180_000);
    const closed = await rows('tracking_incidents');
    assert.equal(closed.find(i => i.kind === 'tracking-interrupted')?.close_reason, 'publications-recovered');
    assert.equal(closed.find(i => i.kind === 'source-unavailable')?.close_reason, 'source-accessible');
  });

  it('DETENER cierra sin inventar recuperación y los fallos nocturnos no abren incidentes', async () => {
    await check(NOW, payload(NOW - 240_000));
    await unavailable(NOW + 60_000);
    const stopped = await check(NOW + 120_000, { isActive: false });
    assert.equal(stopped.evaluation.recoveryState, 'none');
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.find(i => i.kind === 'tracking-interrupted')?.close_reason, 'tracking-inactive');
    assert.equal(incidents.find(i => i.kind === 'source-unavailable')?.close_reason, 'source-accessible');
    await unavailable(NOW + DAY);
    await check(NOW + DAY + 1, { isActive: false });
    assert.deepEqual(await rows('tracking_incidents'), incidents);
    await check(NOW + DAY + 2);
    await unavailable(NOW + DAY + 3);
    assert.equal((await rows('tracking_incidents')).length, 3);
  });

  it('datos ausentes o inválidos no detienen vigilancia ni simulan recuperación', async () => {
    await check(NOW, payload(NOW - 240_000));
    await check(NOW + 60_000, null);
    await check(NOW + 120_000, { isActive: 'false' });
    await unavailable(NOW + 180_000);
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 2);
    assert.ok(incidents.every(incident => incident.closed_at === null));
    await check(NOW + 240_000, null);
    const after = await rows('tracking_incidents');
    assert.equal(after.find(i => i.kind === 'source-unavailable')?.close_reason, 'source-accessible');
    assert.equal(after.find(i => i.kind === 'tracking-interrupted')?.closed_at, null);
  });

  it('isActive true inicia vigilancia aunque todavía no haya timestamp utilizable', async () => {
    await check(NOW, { isActive: true });
    assert.equal((await rows('tracking_incidents')).length, 0);
    await unavailable(NOW + 1);
    assert.equal((await rows('tracking_incidents'))[0].kind, 'source-unavailable');
  });

  it('HTTP fallido y respuesta inválida mantienen un único incidente de fuente', async () => {
    await check();
    for (const [offset, response] of [
      [1, new Response('PRIVATE ERROR', { status: 403 })],
      [2, new Response('invalid json')],
    ] as const) {
      await readAndEvaluate(env(), { auth, now: () => NOW + offset, fetchImpl: async () => response });
    }
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].check_count, 2);
    assert.ok(!JSON.stringify(incidents).includes('PRIVATE'));
  });

  it('incidentes y vigilancia sobreviven reinicio de D1 y poda de observaciones', async () => {
    await check(NOW - 8 * DAY, payload(NOW - 9 * DAY));
    const id = (await rows('tracking_incidents'))[0].incident_id;
    await proxy.dispose();
    await open();
    await unavailable(NOW);
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 2);
    assert.equal(incidents.find(i => i.kind === 'tracking-interrupted')?.incident_id, id);
    assert.equal(incidents.find(i => i.kind === 'tracking-interrupted')?.closed_at, null);
    assert.equal((await rows('tracking_observations')).length, 1);
    await check(NOW + 60_000);
    await check(NOW + 120_000);
    assert.equal((await rows('tracking_incidents')).find(i => i.incident_id === id)?.duration_ms, 8 * DAY + 120_000);
  });

  it('aísla incidentes y vigilancia por bus y fuente', async () => {
    await check();
    await unavailable(NOW + 1, { BUS_ID: 'OTHER-TEST' });
    await unavailable(NOW + 1, { RTDB_NAMESPACE: 'demo-other-memory' });
    assert.equal((await rows('tracking_incidents')).length, 0);
    await unavailable(NOW + 2);
    await check(NOW + 2, { isActive: false }, { BUS_ID: 'OTHER-TEST' });
    assert.equal((await rows('tracking_incidents')).length, 1);
    assert.equal((await rows('tracking_incidents'))[0].closed_at, null);
  });

  it('dos comprobaciones concurrentes no duplican ni actualizan dos veces el incidente', async () => {
    await check(NOW, payload(NOW - 240_000));
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = async () => {
      if (++waiting === 2) release();
      await barrier;
      return new Response(JSON.stringify(payload(NOW - 240_000)));
    };
    const results = await Promise.allSettled([1, 2].map(() =>
      readAndEvaluate(env(), { auth, now: () => NOW + 60_000, fetchImpl })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].check_count, 2);
    assert.equal((await rows('tracking_observations')).length, 2);
  });

  it('dos primeras detecciones simultáneas crean un solo incidente', async () => {
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = async () => {
      if (++waiting === 2) release();
      await barrier;
      return new Response(JSON.stringify(payload(NOW - 240_000)));
    };
    const results = await Promise.allSettled([1, 2].map(() =>
      readAndEvaluate(env(), { auth, now: () => NOW, fetchImpl })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && memoryFailure('memory-conflict')(rejected.reason));
    const incidents = await rows('tracking_incidents');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].check_count, 1);
    assert.equal((await rows('tracking_state'))[0].revision, 1);
    assert.equal((await rows('tracking_observations')).length, 1);
  });

  it('migrar D1 existente conserva observaciones y la última declaración sin inventar incidentes históricos', async () => {
    const legacy = await getPlatformProxy<Env>({
      configPath: path.join(root, 'wrangler.jsonc'), environment: 'memory-local',
      remoteBindings: false, envFiles: [], persist: { path: path.join(scratch, 'upgrade') },
    });
    try {
      const legacyDb = legacy.env.PULSO_DB!;
      const initial = await readFile(new NodeURL('../migrations/0001_tracking_memory.sql', import.meta.url), 'utf8');
      await legacyDb.batch(initial.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => legacyDb.prepare(sql)));
      for (const [bus, declared, classification] of [
        ['ACTIVE', 1, 'source-unavailable'], ['STOPPED', 0, 'source-unavailable'],
        ['UNKNOWN', null, 'insufficient-data'], ['ACTIVE-WITHOUT-HISTORY', null, 'active-publishing'],
      ] as const) {
        await legacyDb.prepare(`INSERT INTO tracking_state
          (source_key, bus_id, revision, last_check_id, evaluated_at, state_version, config_json, last_classification, prior_state_json)
          VALUES ('legacy', ?, 2, ?, ?, 1, '{}', ?, '{}')`).bind(bus, bus, NOW, classification).run();
        await legacyDb.prepare(`INSERT INTO tracking_observations
          (check_id, source_key, bus_id, revision, evaluated_at, source_status, declared_active, summary_json, config_json)
          VALUES (?, 'legacy', ?, 1, ?, 'ok', ?, '{}', '{}')`).bind(bus, bus, NOW - 1, declared).run();
        await legacyDb.prepare(`INSERT INTO tracking_observations
          (check_id, source_key, bus_id, revision, evaluated_at, source_status, summary_json, config_json)
          VALUES (?, 'legacy', ?, 2, ?, 'unavailable', '{}', '{}')`).bind(`${bus}-latest`, bus, NOW).run();
      }
      const migration = await readFile(new NodeURL('../migrations/0002_tracking_incidents.sql', import.meta.url), 'utf8');
      await legacyDb.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => legacyDb.prepare(sql)));
      const states = (await legacyDb.prepare('SELECT * FROM tracking_state ORDER BY bus_id').all()).results;
      assert.deepEqual(states.map(row => [row.bus_id, row.monitoring_active]), [
        ['ACTIVE', 1], ['ACTIVE-WITHOUT-HISTORY', 1], ['STOPPED', 0], ['UNKNOWN', 0],
      ]);
      assert.ok(states.every(row => row.revision === 2 && row.evaluated_at === NOW && row.prior_state_json === '{}'));
      assert.equal((await legacyDb.prepare('SELECT * FROM tracking_observations').all()).results.length, 8);
      assert.equal((await legacyDb.prepare('SELECT * FROM tracking_incidents').all()).results.length, 0);
    } finally {
      await legacy.dispose();
    }
  });

  it('un error al crear incidente revierte snapshot, historial y poda', async () => {
    await check(NOW - 8 * DAY);
    const before = await snapshot();
    await db.prepare("CREATE TRIGGER reject_incident BEFORE INSERT ON tracking_incidents BEGIN SELECT RAISE(ABORT, 'PRIVATE SQL'); END").run();
    try {
      await assert.rejects(check(NOW, payload(NOW - 240_000)), memoryFailure('memory-write-failed'));
      assert.equal(await snapshot(), before);
    } finally {
      await db.prepare('DROP TRIGGER reject_incident').run();
    }
  });

  it('un error al cerrar incidente revierte también la recuperación del evaluador', async () => {
    await check(NOW, payload(NOW - 240_000));
    await check(NOW + 60_000);
    const before = await snapshot();
    await db.prepare("CREATE TRIGGER reject_incident_update BEFORE UPDATE ON tracking_incidents BEGIN SELECT RAISE(ABORT, 'PRIVATE SQL'); END").run();
    try {
      await assert.rejects(check(NOW + 120_000), memoryFailure('memory-write-failed'));
      assert.equal(await snapshot(), before);
    } finally {
      await db.prepare('DROP TRIGGER reject_incident_update').run();
    }
    await check(NOW + 120_000);
    assert.equal((await rows('tracking_incidents'))[0].close_reason, 'publications-recovered');
  });
});
