import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createServer } from 'node:http';
import { createTestHarness, getPlatformProxy } from 'wrangler';
import { readAndEvaluate, runScheduledCheck } from '../src/index.ts';
import type { Env } from '../src/index.ts';
import { MemoryError } from '../src/trackingStore.ts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const root = fileURLToPath(new NodeURL('../', import.meta.url));
let scratch: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
async function open() {
  proxy = await getPlatformProxy<Env>({
    configPath: path.join(root, 'wrangler.jsonc'), environment: 'memory-local',
    remoteBindings: false, envFiles: [], persist: { path: scratch },
  });
  db = proxy.env.PULSO_DB!;
}
function env(overrides: Partial<Env> = {}): Env {
  return {
    PULSO_LOCAL_ONLY: 'true', PULSO_MEMORY: 'd1-local', PULSO_DB: db,
    RTDB_MODE: 'local-authenticated', RTDB_ORIGIN: 'http://127.0.0.1:9000',
    RTDB_NAMESPACE: 'demo-pulso-scheduled', BUS_ID: 'SCHEDULED-TEST',
    PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2',
    MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '1000', ...overrides,
  };
}
const active = (at: number) => ({ isActive: true, timestamp: at, latitude: -12, longitude: -77 });
const auth = { getIdToken: async () => 'PRIVATE_TEST_TOKEN' };
const dependencies = (at: number, data: unknown) => ({
  auth, now: () => at, fetchImpl: async () => new Response(JSON.stringify(data)),
});
const tick = (minute: number, data: unknown = active(NOW + minute * MINUTE)) =>
  runScheduledCheck(env(), dependencies(NOW + minute * MINUTE, data));
const outage = (minute: number) => runScheduledCheck(env(), {
  auth, now: () => NOW + minute * MINUTE,
  fetchImpl: async () => { throw new Error('PRIVATE network detail'); },
});
async function incidents() {
  return (await db.prepare('SELECT * FROM tracking_incidents ORDER BY opened_at, kind').all()).results;
}
async function snapshot() {
  return JSON.stringify(await Promise.all(['tracking_state', 'tracking_observations', 'tracking_incidents']
    .map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results)));
}
const memoryFailure = (code: string) => (error: unknown) => error instanceof MemoryError && error.code === code;

before(async () => {
  const parent = path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(path.join(parent, 'pulso-scheduled-'));
  await open();
  for (const name of ['0001_tracking_memory.sql', '0002_tracking_incidents.sql']) {
    const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
    await db.batch(sql.split(';').map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
  }
});
beforeEach(async () => {
  await db.batch(['tracking_incidents', 'tracking_observations', 'tracking_state'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
after(async () => {
  await proxy?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('comprobaciones programadas con D1 real y Firebase simulado', () => {
  it('conserva continuidad entre minutos y cierra un único incidente tras dos publicaciones distintas', async () => {
    await tick(0);
    await tick(1);
    await tick(2, active(NOW));
    await tick(3, active(NOW));
    assert.equal((await incidents()).length, 0);
    await tick(4, active(NOW));
    await tick(5, active(NOW));
    const opened = (await incidents())[0];
    assert.equal(opened.kind, 'tracking-interrupted');
    assert.equal(opened.check_count, 2);
    assert.equal((await tick(6)).evaluation.recoveryState, 'pending');
    assert.equal((await tick(7, active(NOW + 6 * MINUTE))).evaluation.recoveryValidObservations, 1);
    assert.equal((await incidents())[0].closed_at, null);
    assert.equal((await tick(8)).evaluation.recoveryState, 'confirmed');
    const closed = await incidents();
    assert.equal(closed.length, 1);
    assert.equal(closed[0].incident_id, opened.incident_id);
    assert.equal(closed[0].close_reason, 'publications-recovered');
    assert.equal(closed[0].duration_ms, 4 * MINUTE);
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM tracking_observations').first())?.total, 9);
  });

  it('no abre incidentes sin actividad observada ni después de inactividad, aunque pase la noche', async () => {
    await outage(0);
    await tick(1, null);
    await tick(2);
    await tick(6, active(NOW + 2 * MINUTE));
    await tick(7, { isActive: false });
    const stopped = await incidents();
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].close_reason, 'tracking-inactive');
    await outage(8);
    await outage(24 * 60);
    await tick(24 * 60 + 1, { isActive: false });
    assert.deepEqual(await incidents(), stopped);
    await tick(24 * 60 + 2);
    await outage(24 * 60 + 3);
    assert.equal((await incidents()).length, 2);
  });

  it('una caída de fuente se persiste y su regreso no oculta un seguimiento desactualizado', async () => {
    await tick(0);
    assert.equal((await outage(1)).source.error, 'network-error');
    await outage(2);
    assert.equal((await incidents()).length, 1);
    assert.equal((await incidents())[0].check_count, 2);
    await tick(4, active(NOW));
    const result = await incidents();
    assert.equal(result.length, 2);
    assert.equal(result[0].close_reason, 'source-accessible');
    assert.equal(result[1].kind, 'tracking-interrupted');
    assert.equal(result[1].closed_at, null);
    assert.ok(!(await snapshot()).includes('PRIVATE'));
  });

  it('un timeout queda registrado y una comprobación posterior continúa normalmente', async () => {
    await tick(0);
    const failed = await runScheduledCheck(env({ READ_TIMEOUT_MS: '10' }), {
      auth, now: () => NOW + MINUTE, fetchImpl: () => new Promise<Response>(() => {}),
    });
    assert.equal(failed.source.error, 'timeout');
    assert.equal(failed.continuity, 'persisted');
    await tick(2);
    assert.equal((await incidents())[0].close_reason, 'source-accessible');
  });

  it('la comprobación manual y la programada comparten la misma memoria', async () => {
    await readAndEvaluate(env(), dependencies(NOW, active(NOW)));
    await tick(4, active(NOW));
    const manual = await readAndEvaluate(env(), dependencies(NOW + 5 * MINUTE, active(NOW + 5 * MINUTE)));
    assert.equal(manual.evaluation.recoveryState, 'pending');
    assert.equal((await tick(6)).evaluation.recoveryState, 'confirmed');
    assert.equal((await incidents()).length, 1);
    assert.equal((await incidents())[0].close_reason, 'publications-recovered');
  });

  it('manual y programada simultáneas producen un ganador sin duplicar incidentes', async () => {
    await tick(0);
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const deps = { auth, now: () => NOW + 4 * MINUTE, fetchImpl: async () => {
      if (++waiting === 2) release();
      await barrier;
      return new Response(JSON.stringify(active(NOW)));
    } };
    const results = await Promise.allSettled([runScheduledCheck(env(), deps), readAndEvaluate(env(), deps)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && memoryFailure('memory-conflict')(rejected.reason));
    assert.equal((await incidents()).length, 1);
    assert.equal((await incidents())[0].check_count, 1);
  });

  it('reiniciar el runtime local conserva vigilancia e incidentes para la siguiente ejecución', async () => {
    await tick(0);
    await outage(1);
    const id = (await incidents())[0].incident_id;
    await proxy.dispose();
    await open();
    const result = await tick(2);
    assert.equal(result.memory?.revision, 3);
    assert.equal((await incidents())[0].incident_id, id);
    assert.equal((await incidents())[0].close_reason, 'source-accessible');
  });

  it('exige D1 y prohíbe el destino operativo antes de consultar la red', async () => {
    for (const overrides of [{ PULSO_MEMORY: 'off' }, { PULSO_DB: undefined }]) {
      await assert.rejects(runScheduledCheck(env(overrides), {
        fetchImpl: async () => assert.fail('No network allowed'),
      }), memoryFailure('memory-unavailable'));
    }
    await assert.rejects(runScheduledCheck(env({ RTDB_MODE: 'operative-public' }), {
      fetchImpl: async () => assert.fail('No production allowed'),
    }), { message: 'operative-manual-only' });
    await assert.rejects(runScheduledCheck(env({ PULSO_LOCAL_ONLY: 'false' }), {
      fetchImpl: async () => assert.fail('No network allowed'),
    }), /Invalid local/);
  });

  it('errores D1 no se convierten en incidentes de fuente ni escrituras parciales', async () => {
    await tick(0);
    const before = await snapshot();
    const broken = { prepare: () => { throw new Error('PRIVATE DB'); } } as unknown as D1Database;
    await assert.rejects(runScheduledCheck(env({ PULSO_DB: broken }), {
      fetchImpl: async () => assert.fail('No read after D1 error'),
    }), memoryFailure('memory-read-failed'));
    await db.prepare("CREATE TRIGGER reject_scheduled BEFORE INSERT ON tracking_observations BEGIN SELECT RAISE(ABORT, 'PRIVATE SQL'); END").run();
    try {
      await assert.rejects(outage(1), memoryFailure('memory-write-failed'));
      assert.equal(await snapshot(), before);
    } finally {
      await db.prepare('DROP TRIGGER reject_scheduled').run();
    }
    await outage(2);
    assert.equal((await incidents()).length, 1);
  });

  it('el handler real de workerd ejecuta scheduled, persiste y conserva el acceso manual', async () => {
    let status = 200;
    let calls = 0;
    const source = createServer((request, response) => {
      calls++;
      assert.equal(new URL(request.url!, 'http://localhost').pathname, '/ubicacion_buses/RUNTIME-TEST.json');
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? active(Date.now()) : { error: 'simulated' }));
    });
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    const address = source.address();
    assert.ok(address && typeof address !== 'string');
    const vars = env({ PULSO_DB: undefined, RTDB_ORIGIN: `http://127.0.0.1:${address.port}`, BUS_ID: 'RUNTIME-TEST' });
    const { PULSO_DB: _db, ...runtimeVars } = vars;
    const harness = createTestHarness({ workers: [{ config: {
      name: 'pulso-scheduled-test', main: path.join(root, 'src/index.ts'), compatibility_date: '2026-11-12',
      workers_dev: false, preview_urls: false, send_metrics: false,
      vars: { ...runtimeVars, FIREBASE_ID_TOKEN: 'local-simulated-token' },
      triggers: { crons: ['* * * * *'] },
      d1_databases: [{ binding: 'PULSO_DB', database_name: 'scheduled-test', database_id: '00000000-0000-0000-0000-000000000002',
        remote: false, migrations_dir: path.join(root, 'migrations') }],
    } }] });
    try {
      await harness.listen();
      const runtime = harness.getWorker<Env>();
      await runtime.applyD1Migrations('PULSO_DB');
      const runtimeDb = (await runtime.getEnv()).PULSO_DB!;
      assert.equal((await runtime.scheduled({ cron: '* * * * *', scheduledTime: new Date() })).outcome, 'ok');
      status = 503;
      assert.equal((await runtime.scheduled({ cron: '* * * * *', scheduledTime: new Date() })).outcome, 'ok');
      const records = (await runtimeDb.prepare('SELECT * FROM tracking_incidents').all()).results;
      assert.equal(records.length, 1);
      assert.equal(records[0].kind, 'source-unavailable');
      status = 200;
      const manual = await runtime.fetch('http://127.0.0.1/evaluate', { headers: { 'X-Pulso-Local': '1' } });
      assert.equal(manual.status, 200);
      const report = await manual.json() as { memory: { revision: number } };
      assert.equal(report.memory.revision, 3);
      assert.equal((await runtimeDb.prepare('SELECT close_reason FROM tracking_incidents').first())?.close_reason, 'source-accessible');
      assert.equal(calls, 3);
      await runtimeDb.prepare('UPDATE tracking_state SET state_version = 999').run();
      // Un fallo de infraestructura debe marcar la ejecución como fallida, no como fuente caída.
      const failed = await runtime.scheduled({ cron: '* * * * *', scheduledTime: new Date() });
      assert.notEqual(failed.outcome, 'ok');
    } finally {
      await harness.close();
      source.closeAllConnections();
      await new Promise<void>((resolve, reject) => source.close(error => error ? reject(error) : resolve()));
    }
  });
});
