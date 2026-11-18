import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import worker, { readAndEvaluate, runScheduledCheck } from '../src/index.ts';
import type { Env } from '../src/index.ts';

const NOW = Date.now();
const sourceOrigin = 'https://burritounmsm-default-rtdb.firebaseio.com';
const central = 'https://central.test.invalid';
const endpoint = 'https://pulso.test.invalid/api/pulso';
const root = fileURLToPath(new NodeURL('../', import.meta.url));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const claims = { sub: 'test-admin', aud: 'burritounmsm', iss: 'https://securetoken.google.com/burritounmsm',
  iat: Math.floor(NOW / 1000) - 60, auth_time: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 3600 };
// Solo forma de JWT: la respuesta de autorización de Firebase se simula íntegramente.
const token = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}.test-signature`;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
let scratch: string;
let source: unknown;
let sourceUnavailable: boolean;
let adminStatus: number;
let calls: string[];
const originalFetch = globalThis.fetch;

function env(changes: Partial<Env> = {}): Env {
  return {
    PULSO_EXECUTION: 'cloudflare', PULSO_LOCAL_ONLY: 'false', PULSO_MEMORY: 'd1', PULSO_DB: db,
    PULSO_SCHEDULE_ENABLED: 'true', PULSO_CENTRAL_ORIGIN: central,
    RTDB_MODE: 'operative-public', RTDB_ORIGIN: sourceOrigin, RTDB_NAMESPACE: 'burritounmsm-default-rtdb', BUS_ID: 'AHK-459',
    PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2', MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '5000',
    PULSO_ADMIN_PROJECT_ID: 'burritounmsm', PULSO_ADMIN_RTDB_ORIGIN: sourceOrigin,
    PULSO_ADMIN_RTDB_NAMESPACE: 'burritounmsm-default-rtdb', ...changes,
  };
}

function request(init: RequestInit = {}, idToken: string | null = token, url = endpoint) {
  return new Request(url, { ...init, headers: { Origin: central, 'Sec-Fetch-Site': 'cross-site',
    ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}), ...init.headers } });
}

// Ninguna petición sale hacia Firebase. Una ruta o transporte inesperado falla la prueba.
const simulatedFetch: typeof fetch = async (input, init) => {
  assert.equal(typeof input, 'string');
  const url = new URL(String(input));
  assert.equal(url.origin, sourceOrigin);
  assert.equal(init?.method, 'GET');
  assert.equal(init?.body, undefined);
  calls.push(url.pathname);
  if (url.pathname === '/ubicacion_buses/AHK-459.json') {
    assert.equal(url.search, '');
    assert.equal(init?.headers && new Headers(init.headers).get('Authorization'), null);
    return sourceUnavailable ? new Response('PRIVATE source error', { status: 503 }) : Response.json(source);
  }
  assert.equal(url.pathname, '/administradores/test-admin.json');
  assert.equal(url.searchParams.get('auth'), token);
  return adminStatus === 200 ? Response.json({ nombres: 'PRIVATE admin' }) : new Response('PRIVATE denial', { status: adminStatus });
};

async function snapshot() {
  return JSON.stringify(await Promise.all(['tracking_state', 'tracking_observations', 'tracking_incidents']
    .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results)));
}

before(async () => {
  const parent = path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(path.join(parent, 'pulso-remote-test-'));
  proxy = await getPlatformProxy<Env>({ configPath: path.join(root, 'wrangler.jsonc'), environment: 'memory-local',
    remoteBindings: false, envFiles: [], persist: { path: scratch } });
  db = proxy.env.PULSO_DB!;
  for (const file of ['0001_tracking_memory.sql', '0002_tracking_incidents.sql', '0003_tracking_observed_start.sql']) {
    const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
    await db.batch(sql.split(';').map(v => v.trim()).filter(Boolean).map(v => db.prepare(v)));
  }
  globalThis.fetch = simulatedFetch;
});
beforeEach(async () => {
  await db.batch(['tracking_incidents', 'tracking_observations', 'tracking_state'].map(table => db.prepare(`DELETE FROM ${table}`)));
  source = { isActive: true, timestamp: NOW, latitude: -12, longitude: -77 };
  sourceUnavailable = false;
  adminStatus = 200;
  calls = [];
});
after(async () => {
  globalThis.fetch = originalFetch;
  await proxy?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('Cloudflare preparado, sin transporte real ni D1 remota', () => {
  it('configura production con vigilancia cada minuto y permite apagarla sin consultar ni escribir', async () => {
    const config = JSON.parse((await readFile(path.join(root, 'wrangler.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    const production = config.env.production;
    assert.deepEqual(production.triggers.crons, ['* * * * *']);
    assert.equal(production.d1_databases[0].binding, 'PULSO_DB');
    assert.equal(production.d1_databases[0].database_name, 'pulso-memory-production');
    assert.equal(production.d1_databases[0].database_id, '47e5664d-f9bd-435a-8f77-f4f8873c69cb');
    assert.equal(production.vars.PULSO_CENTRAL_ORIGIN, 'https://burritounmsm.web.app');
    assert.equal(production.vars.PULSO_SCHEDULE_ENABLED, 'true');
    const before = await snapshot();
    await assert.rejects(runScheduledCheck({ ...production.vars, PULSO_SCHEDULE_ENABLED: 'false', PULSO_DB: db }), /schedule-disabled/);
    assert.deepEqual(calls, []);
    assert.equal(await snapshot(), before);
  });

  it('apagado no consulta ni escribe; activado conserva la comprobación en D1 local de prueba', async () => {
    const before = await snapshot();
    for (const check of [runScheduledCheck, readAndEvaluate]) {
      await assert.rejects(check(env({ PULSO_SCHEDULE_ENABLED: 'false' })), /schedule-disabled/);
    }
    await worker.scheduled({} as ScheduledController, env({ PULSO_SCHEDULE_ENABLED: 'false' }));
    assert.deepEqual(calls, []);
    assert.equal(await snapshot(), before);
    const result = await runScheduledCheck(env(), { now: () => NOW });
    assert.equal(result.continuity, 'persisted');
    assert.equal(result.mode, 'operative-public');
    assert.equal(result.authentication, 'public-no-token');
    assert.equal(result.source.status, 'ok');
    assert.equal(result.evaluation.classification, 'active-publishing');
    assert.equal(result.memory?.revision, 1);
    assert.equal(calls.length, 1);
  });

  it('configuración incompleta o mezclada falla antes de cualquier HTTP o escritura', async () => {
    const before = await snapshot();
    const invalid: Partial<Env>[] = [
      { PULSO_EXECUTION: 'production' }, { PULSO_EXECUTION: undefined }, { PULSO_LOCAL_ONLY: 'true' },
      { PULSO_MEMORY: 'off' }, { PULSO_MEMORY: 'd1-local' }, { PULSO_DB: undefined },
      { PULSO_SCHEDULE_ENABLED: undefined }, { PULSO_SCHEDULE_ENABLED: 'TRUE' },
      { PULSO_CENTRAL_ORIGIN: '' }, { PULSO_CENTRAL_ORIGIN: 'http://central.test.invalid' },
      { PULSO_CENTRAL_ORIGIN: `${central}/path` }, { PULSO_CENTRAL_ORIGIN: 'https://localhost' },
      { RTDB_MODE: 'local-authenticated' }, { RTDB_ORIGIN: 'https://other.invalid' }, { BUS_ID: '' },
      { PUBLICATION_STALE_AFTER_MS: '60000' }, { RECOVERY_CONFIRMATIONS_REQUIRED: '1' },
      { MAX_FUTURE_SKEW_MS: undefined }, { READ_TIMEOUT_MS: '' },
      { PULSO_ADMIN_PROJECT_ID: undefined }, { PULSO_ADMIN_RTDB_NAMESPACE: 'other' },
      { PULSO_ADMIN_RTDB_ORIGIN: 'http://localhost:19000', PULSO_ADMIN_PROJECT_ID: 'demo-test', PULSO_ADMIN_RTDB_NAMESPACE: 'demo-test' },
    ];
    for (const changes of invalid) await assert.rejects(runScheduledCheck(env(changes)));
    assert.deepEqual(calls, []);
    assert.equal(await snapshot(), before);
  });

  it('conserva continuidad, dos confirmaciones distintas y la detención normal', async () => {
    const tick = (at: number) => runScheduledCheck(env(), { now: () => at });
    await tick(NOW);
    await tick(NOW + 180000);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tracking_incidents').first())?.n, 0);
    await tick(NOW + 240000);
    await tick(NOW + 300000);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tracking_incidents').first())?.n, 1);
    source = { isActive: true, timestamp: NOW + 360000 };
    assert.equal((await tick(NOW + 360000)).evaluation.recoveryState, 'pending');
    assert.equal((await tick(NOW + 420000)).evaluation.recoveryState, 'pending');
    source = { isActive: true, timestamp: NOW + 480000 };
    assert.equal((await tick(NOW + 480000)).evaluation.recoveryState, 'confirmed');
    assert.equal((await db.prepare('SELECT close_reason FROM tracking_incidents').first())?.close_reason, 'publications-recovered');
    source = { isActive: false };
    await tick(NOW + 540000);
    sourceUnavailable = true;
    await tick(NOW + 86400000);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tracking_incidents').first())?.n, 1);
    assert.equal((await db.prepare('SELECT monitoring_active FROM tracking_state').first())?.monitoring_active, 0);
  });

  it('concurrencia remota conserva un ganador sin duplicar incidentes', async () => {
    await runScheduledCheck(env(), { now: () => NOW });
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = async (url: string, init: RequestInit) => {
      if (++ready === 2) release();
      await barrier;
      return simulatedFetch(url, init);
    };
    const results = await Promise.allSettled([1, 2].map(() => runScheduledCheck(env(), { now: () => NOW + 240000, fetchImpl })));
    assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
    const rejected = results.find(v => v.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason.message === 'memory-conflict');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tracking_incidents').first())?.n, 1);
  });

  it('el handler scheduled real guarda y actualiza un solo incidente de fuente', async () => {
    await worker.scheduled({} as ScheduledController, env());
    sourceUnavailable = true;
    await worker.scheduled({} as ScheduledController, env());
    await worker.scheduled({} as ScheduledController, env());
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tracking_incidents').first())?.n, 1);
    sourceUnavailable = false;
    await worker.scheduled({} as ScheduledController, env());
    assert.equal((await db.prepare('SELECT close_reason FROM tracking_incidents').first())?.close_reason, 'source-accessible');
  });

  it('OPTIONS permite solo el origen exacto, GET y Authorization, sin autorización ni escrituras', async () => {
    const before = await snapshot();
    const headers = { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' };
    const response = await worker.fetch(request({ method: 'OPTIONS', headers }, null), env());
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), central);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const deniedHeaders: Record<string, string>[] = [{ Origin: 'https://other.invalid' }, { Origin: 'null' },
      { 'Access-Control-Request-Method': 'POST' }, { 'Access-Control-Request-Headers': 'authorization,x-bypass' }];
    for (const denied of deniedHeaders) {
      const result = await worker.fetch(request({ method: 'OPTIONS', headers: { ...headers, ...denied } }, null), env());
      assert.equal(result.status, 403);
      assert.notEqual(result.headers.get('Access-Control-Allow-Origin'), '*');
      if ('Origin' in denied) assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
    }
    assert.deepEqual(calls, []);
    assert.equal(await snapshot(), before);
  });

  it('la lectura remota reutiliza el token, solo consulta SELECT y funciona con cron apagado', async () => {
    await runScheduledCheck(env(), { now: () => NOW });
    const before = await snapshot();
    calls = [];
    const readOnly = { prepare(sql: string) { assert.match(sql, /^SELECT\b/); return db.prepare(sql); }, batch: db.batch.bind(db) } as unknown as D1Database;
    const response = await worker.fetch(request(), env({ PULSO_DB: readOnly, PULSO_SCHEDULE_ENABLED: 'false' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), central);
    assert.equal(response.headers.get('Vary'), 'Origin');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    assert.equal(JSON.parse(text).status, 'observed');
    for (const privateValue of ['PRIVATE', 'source_key', 'prior_state', token]) assert.ok(!text.includes(privateValue));
    assert.deepEqual(calls, ['/administradores/test-admin.json']);
    assert.equal(await snapshot(), before);
  });

  it('errores de autorización y D1 llevan CORS y nunca exponen datos ni desencadenan evaluación', async () => {
    const assertError = async (expected: number, idToken: string | null, changes: Partial<Env> = {}) => {
      const response = await worker.fetch(request({}, idToken), env(changes));
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), central);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.ok(!(await response.text()).includes('PRIVATE'));
    };
    await assertError(401, null);
    await assertError(401, 'invalid.token');
    const unsigned = `${encode({ alg: 'none' })}.${encode(claims)}.`;
    await assertError(401, unsigned);
    const expired = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ ...claims, exp: 1 })}.fake`;
    await assertError(401, expired);
    assert.deepEqual(calls, []);
    adminStatus = 403;
    await assertError(403, token);
    adminStatus = 503;
    await assertError(503, token);
    adminStatus = 200;
    await assertError(503, token, { PULSO_DB: { prepare: () => { throw new Error('PRIVATE SQL'); } } as unknown as D1Database });
    assert.ok(calls.every(v => v === '/administradores/test-admin.json'));
  });

  it('API incompleta devuelve error con CORS cuando el origen es conocido, sin acceder a Firebase', async () => {
    for (const changes of [{ PULSO_DB: undefined }, { PULSO_MEMORY: 'd1-local' },
      { PULSO_ADMIN_PROJECT_ID: undefined }, { RTDB_MODE: 'local-authenticated' }]) {
      const response = await worker.fetch(request(), env(changes));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), central);
      assert.deepEqual(await response.json(), { error: 'read-not-configured' });
    }
    const response = await worker.fetch(request(), env({ PULSO_CENTRAL_ORIGIN: '' }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.deepEqual(calls, []);
  });

  it('rechaza HTTP, orígenes ajenos, mutaciones, parámetros y cualquier /evaluate remoto', async () => {
    for (const [url, init, status] of [
      [endpoint.replace('https:', 'http:'), {}, 403], [endpoint, { headers: { Origin: 'https://other.invalid' } }, 403],
      [endpoint, { method: 'POST' }, 405], [`${endpoint}?bus=OTHER`, {}, 400],
      ['https://pulso.test.invalid/evaluate', { headers: { 'X-Pulso-Local': '1' } }, 403],
      ['http://localhost/evaluate', { headers: { 'X-Pulso-Local': '1' } }, 403],
    ] as const) {
      assert.equal((await worker.fetch(request(init, token, url), env())).status, status);
    }
    assert.deepEqual(calls, []);
  });
});
