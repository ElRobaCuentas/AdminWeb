import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import worker, { readAndEvaluate } from '../src/index.ts';
import type { Env } from '../src/index.ts';
import { handlePulsoRead } from '../src/pulsoRead.ts';
import { requireAdministrator } from '../src/adminAuthorization.ts';

const NOW = 1_800_000_000_000;
const project = 'demo-pulso-api';
const root = fileURLToPath(new NodeURL('../', import.meta.url));
let scratch: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
const claims = { sub: 'admin-test', aud: project, iss: `https://securetoken.google.com/${project}`,
  iat: NOW / 1000 - 60, auth_time: NOW / 1000 - 60, exp: NOW / 1000 + 3600 };
function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'none' }) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode({ ...claims, ...changes })}.`;
}
function env(changes: Partial<Env> = {}): Env {
  return {
    PULSO_LOCAL_ONLY: 'true', PULSO_MEMORY: 'd1-local', PULSO_DB: db,
    RTDB_MODE: 'local-authenticated', RTDB_ORIGIN: 'http://127.0.0.1:9000', RTDB_NAMESPACE: project, BUS_ID: 'API-TEST',
    PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2', MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '1000',
    PULSO_ADMIN_PROJECT_ID: project, PULSO_ADMIN_RTDB_ORIGIN: 'http://127.0.0.1:9000', PULSO_ADMIN_RTDB_NAMESPACE: project,
    ...changes,
  };
}
function request(idToken: string | null = token(), url = 'http://localhost/api/pulso', init: RequestInit = {}) {
  return new Request(url, { ...init, headers: { ...(idToken === null ? {} : { Authorization: `Bearer ${idToken}` }), ...init.headers } });
}
const admin = async (url: string, init: RequestInit) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'http://127.0.0.1:9000');
  assert.equal(parsed.pathname, '/administradores/admin-test.json');
  assert.equal(parsed.searchParams.get('ns'), project);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  return Response.json({ nombres: 'PRIVATE administrator data' });
};
const api = (at = NOW, changes: Partial<Env> = {}) => handlePulsoRead(request(), env(changes), { fetchImpl: admin, now: () => at });
async function check(at: number, data: unknown = { isActive: true, timestamp: at, latitude: -12.123456, longitude: -77.123456 }) {
  const result = await readAndEvaluate(env(), { now: () => at, auth: { getIdToken: async () => 'PRIVATE_SOURCE_TOKEN' },
    fetchImpl: async () => data === 'outage' ? new Response('', { status: 503 }) : Response.json(data) });
  assert.equal(result.source.status, data === 'outage' ? 'unavailable' : data === null ? 'missing' : 'ok');
  return result;
}
async function snapshot() {
  return JSON.stringify(await Promise.all(['tracking_state', 'tracking_observations', 'tracking_incidents']
    .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results)));
}

before(async () => {
  const parent = path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(path.join(parent, 'pulso-read-'));
  proxy = await getPlatformProxy<Env>({ configPath: path.join(root, 'wrangler.jsonc'), environment: 'memory-local',
    remoteBindings: false, envFiles: [], persist: { path: scratch } });
  db = proxy.env.PULSO_DB!;
  for (const name of ['0001_tracking_memory.sql', '0002_tracking_incidents.sql', '0003_tracking_observed_start.sql']) {
    const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
    await db.batch(sql.split(';').map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
  }
});
beforeEach(async () => {
  await db.batch(['tracking_incidents', 'tracking_observations', 'tracking_state'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
after(async () => { await proxy?.dispose(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

describe('autorización delegada a las reglas de Firebase, sin credenciales nuevas', () => {
  it('exige Bearer aunque haya UID y cabecera local; no toca red ni D1 sin sesión', async () => {
    const response = await worker.fetch(request(null, 'http://localhost/api/pulso', {
      headers: { 'X-Pulso-Local': '1', 'X-User-Uid': 'admin-test' },
    }), env());
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'authentication-required' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
  it('delega el token completo exclusivamente al nodo de administrador configurado', async () => {
    let calls = 0;
    await requireAdministrator(request(), env(), async (url, init) => {
      calls++;
      assert.equal(new URL(url).searchParams.get('auth'), token());
      return admin(url, init);
    }, NOW);
    assert.equal(calls, 1);
  });
  it('comprueba existencia del nodo sin imponer otro esquema de perfil o contraseña', async () => {
    await requireAdministrator(request(), env(), async () => Response.json(false), NOW);
  });
  it('rechaza tokens malformados, vencidos, de otro proyecto o con claims inválidos antes de la red', async () => {
    const invalid = ['owner', 'bad.token', token({ exp: NOW / 1000 }), token({ aud: 'other' }),
      token({ iss: 'other' }), token({ sub: '../admin' }), token({ iat: NOW / 1000 + 1 }),
      token({ auth_time: NOW / 1000 + 1 }), token({ exp: '999999999999' }), token({}, { alg: 'HS256' })];
    for (const value of invalid) {
      const result = await handlePulsoRead(request(value), env(), { now: () => NOW,
        fetchImpl: async () => assert.fail('Invalid credentials must not reach Firebase') });
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { error: 'invalid-token' });
    }
  });
  it('deniega usuario sin rol, token rechazado por Firebase y nodo ausente antes de leer D1', async () => {
    const broken = { prepare: () => assert.fail('No D1 before authorization') } as unknown as D1Database;
    for (const response of [new Response('PRIVATE', { status: 401 }), new Response('PRIVATE', { status: 403 }), Response.json(null)]) {
      const result = await handlePulsoRead(request(), env({ PULSO_DB: broken }), { now: () => NOW, fetchImpl: async () => response });
      assert.deepEqual(result, { status: 403, body: { error: 'access-denied' } });
    }
  });
  it('no confunde fallos de autorización con ausencia de datos ni filtra información del proveedor', async () => {
    for (const response of [new Response('PRIVATE', { status: 500 }), new Response('PRIVATE', { status: 302 }),
      new Response('not-json'), new Response('x'.repeat(16_385))]) {
      const result = await handlePulsoRead(request(), env(), { now: () => NOW, fetchImpl: async () => response });
      assert.deepEqual(result, { status: 503, body: { error: 'authorization-unavailable' } });
    }
    const result = await handlePulsoRead(request(), env(), { now: () => NOW,
      fetchImpl: async () => { throw new Error('PRIVATE network'); } });
    assert.deepEqual(result, { status: 503, body: { error: 'authorization-unavailable' } });
  });
  it('acota autorización aunque el transporte no atienda abort', async () => {
    const result = await handlePulsoRead(request(), env(), { now: () => NOW, fetchImpl: () => new Promise<Response>(() => {}) });
    assert.deepEqual(result, { status: 503, body: { error: 'authorization-unavailable' } });
  });
  it('falla cerrado sin configuración o con destino de autorización arbitrario', async () => {
    for (const changes of [{ PULSO_ADMIN_PROJECT_ID: undefined }, { PULSO_ADMIN_RTDB_NAMESPACE: 'other' },
      { PULSO_ADMIN_RTDB_ORIGIN: 'https://evil.invalid' }, { PULSO_ADMIN_RTDB_ORIGIN: 'http://user:secret@localhost:9000' }]) {
      const result = await handlePulsoRead(request(), env(changes), { now: () => NOW, fetchImpl: async () => assert.fail('No network') });
      assert.deepEqual(result, { status: 503, body: { error: 'authorization-not-configured' } });
    }
  });
  it('no admite tokens unsigned del emulador para el destino operativo', async () => {
    const result = await handlePulsoRead(request(token({ aud: 'burritounmsm', iss: 'https://securetoken.google.com/burritounmsm' })), env({
      PULSO_ADMIN_PROJECT_ID: 'burritounmsm', PULSO_ADMIN_RTDB_ORIGIN: 'https://burritounmsm-default-rtdb.firebaseio.com',
      PULSO_ADMIN_RTDB_NAMESPACE: 'burritounmsm-default-rtdb',
    }), { now: () => NOW, fetchImpl: async () => assert.fail('No production request') });
    assert.equal(result.status, 401);
  });
  it('un UID RS256 no concede acceso si Firebase rechaza su token; transporte enteramente simulado', async () => {
    let calls = 0;
    const signedShape = `${token({ aud: 'burritounmsm', iss: 'https://securetoken.google.com/burritounmsm' },
      { alg: 'RS256', kid: 'test-key' })}fake-signature`;
    const result = await handlePulsoRead(request(signedShape), env({
      PULSO_ADMIN_PROJECT_ID: 'burritounmsm', PULSO_ADMIN_RTDB_ORIGIN: 'https://burritounmsm-default-rtdb.firebaseio.com',
      PULSO_ADMIN_RTDB_NAMESPACE: 'burritounmsm-default-rtdb',
      PULSO_DB: { prepare: () => assert.fail('No D1 for rejected token') } as unknown as D1Database,
    }), { now: () => NOW, fetchImpl: async (url, init) => {
      calls++;
      assert.equal(new URL(url).pathname, '/administradores/admin-test.json');
      assert.equal(init.method, 'GET');
      return new Response('PRIVATE rejection', { status: 401 });
    } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { status: 403, body: { error: 'access-denied' } });
  });
  it('mantiene la frontera local, rechaza otros métodos y no acepta parámetros del navegador', async () => {
    for (const [url, init, status] of [
      ['http://evil.invalid/api/pulso', {}, 403], ['http://localhost/api/pulso', { headers: { Origin: 'null' } }, 403],
      ['http://localhost/api/pulso', { method: 'POST' }, 405], ['http://localhost/api/pulso?uid=admin', {}, 400],
    ] as const) {
      const result = await handlePulsoRead(request(token(), url, init), env(), { fetchImpl: async () => assert.fail('No network') });
      assert.equal(result.status, status);
    }
  });
});

describe('lectura exclusiva de datos persistidos en D1 local real', () => {
  it('distingue D1 vacía de una comprobación guardada sin incidentes', async () => {
    assert.deepEqual(await api(), { status: 200, body: { status: 'no-data', busId: 'API-TEST', observedState: null,
      lastCheck: null, activeIncidents: [], recentIncidents: [] } });
    await check(NOW);
    const result = await api();
    assert.equal(result.status, 200);
    const body = result.body as any;
    assert.equal(body.status, 'observed');
    assert.equal(body.observedState.classification, 'active-publishing');
    assert.equal(body.observedState.observedTripStartedAt, NOW);
    assert.equal(body.lastCheck.evaluatedAt, NOW);
    assert.deepEqual(body.activeIncidents, []);
    assert.deepEqual(body.recentIncidents, []);
  });
  it('informa la antigüedad sin reevaluar ni cambiar el último estado observado', async () => {
    await check(NOW);
    const recent = (await api(NOW + 180_000)).body as any;
    const old = (await api(NOW + 180_001)).body as any;
    assert.equal(recent.lastCheck.freshness, 'recent');
    assert.equal(old.lastCheck.freshness, 'old');
    assert.equal(old.lastCheck.ageMs, 180_001);
    assert.equal(old.lastCheck.staleAfterMs, 180_000);
    assert.equal(old.observedState.classification, 'active-publishing');
    assert.deepEqual(old.activeIncidents, []);
  });
  it('muestra apertura y cierre realmente guardados, incluidos ambos tipos de incidentes', async () => {
    await check(NOW);
    await check(NOW + 240_000, { isActive: true, timestamp: NOW });
    await check(NOW + 300_000, 'outage');
    const opened = (await api(NOW + 300_000)).body as any;
    assert.equal(opened.activeIncidents.length, 2);
    assert.equal(opened.observedState.classification, 'source-unavailable');
    assert.equal(opened.lastCheck.sourceStatus, 'unavailable');
    assert.ok(opened.activeIncidents.every((record: any) => record.durationMs === null));
    await check(NOW + 360_000);
    await check(NOW + 420_000);
    const closed = (await api(NOW + 420_000)).body as any;
    assert.deepEqual(closed.activeIncidents, []);
    assert.equal(closed.recentIncidents.length, 2);
    assert.deepEqual(new Set(closed.recentIncidents.map((record: any) => record.closeReason)),
      new Set(['source-accessible', 'publications-recovered']));
    assert.ok(closed.recentIncidents.every((record: any) => record.closedAt !== null && record.durationMs > 0));
  });
  it('devuelve los últimos 20 incidentes en orden estable sin perder los abiertos', async () => {
    for (let cycle = 0; cycle < 22; cycle++) {
      await check(NOW + cycle * 1000);
      await check(NOW + cycle * 1000 + 1, 'outage');
    }
    const result = (await api(NOW + 22_000)).body as any;
    assert.equal(result.recentIncidents.length, 20);
    assert.equal(result.activeIncidents.length, 1);
    assert.equal(result.recentIncidents[0].id, result.activeIncidents[0].id);
    assert.equal(result.recentIncidents[19].openedAt, NOW + 2001);
  });
  it('distingue DETENER de no haber observado actividad y conserva lo desconocido', async () => {
    await check(NOW, null);
    assert.equal(((await api()).body as any).observedState.declaredActive, null);
    await check(NOW + 1, { isActive: false });
    const stopped = ((await api()).body as any).observedState;
    assert.equal(stopped.declaredActive, false);
    assert.equal(stopped.monitoringActive, false);
    assert.equal(stopped.observedTripStartedAt, null);
    assert.equal(stopped.classification, 'inactive-unconfirmed');
    await check(NOW + 2, { isActive: true, timestamp: -1 });
    assert.equal(((await api()).body as any).observedState.publicationTimestamp, null);
  });
  it('expone el inicio persistido sin reconstruir períodos anteriores ni cambiarlo por errores de fuente', async () => {
    await check(NOW);
    await check(NOW + 60_000, 'outage');
    assert.equal(((await api(NOW + 60_000)).body as any).observedState.observedTripStartedAt, NOW);
    await db.prepare('UPDATE tracking_state SET observed_trip_started_at = NULL').run();
    await check(NOW + 120_000);
    assert.equal(((await api(NOW + 120_000)).body as any).observedState.observedTripStartedAt, null);
  });
  it('aísla fuente y bus y no expone coordenadas, token, perfil, SQL ni estado interno', async () => {
    await check(NOW);
    const result = await api();
    const text = JSON.stringify(result);
    for (const secret of ['PRIVATE', '-12.123456', '-77.123456', 'prior_state', 'source_key', 'config_json', 'lastCheckId']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.equal(((await api(NOW, { BUS_ID: 'OTHER' })).body as any).status, 'no-data');
    assert.equal(((await api(NOW, { RTDB_NAMESPACE: 'demo-other' })).body as any).status, 'no-data');
  });
  it('consulta solo SELECT y no altera snapshot, observaciones ni incidentes', async () => {
    await check(NOW);
    await check(NOW + 240_000, { isActive: true, timestamp: NOW });
    const previous = await snapshot();
    let reads = 0;
    const readOnly = {
      prepare(sql: string) { assert.match(sql, /^SELECT\b/); reads++; return db.prepare(sql); },
      batch: db.batch.bind(db),
    } as unknown as D1Database;
    assert.equal((await api(NOW + 240_000, { PULSO_DB: readOnly })).status, 200);
    assert.equal(reads, 3);
    assert.equal(await snapshot(), previous);
  });
  it('no transforma D1 ausente, errores SQL ni observación faltante en un estado vacío', async () => {
    assert.deepEqual(await api(NOW, { PULSO_DB: undefined }), { status: 503, body: { error: 'read-not-configured' } });
    const broken = { prepare: () => { throw new Error('PRIVATE SQL SELECT secret'); } } as unknown as D1Database;
    assert.deepEqual(await api(NOW, { PULSO_DB: broken }), { status: 503, body: { error: 'read-failed' } });
    await check(NOW);
    await db.prepare('DELETE FROM tracking_observations').run();
    assert.deepEqual(await api(), { status: 503, body: { error: 'read-failed' } });
  });
});
