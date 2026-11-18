import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createTestHarness } from 'wrangler';
import type { Env } from '../src/index.ts';

// Ejecutar con Auth y RTDB locales: proyecto demo-pulso-api, puertos aislados.
// Las reglas cargadas deben ser FirebaseLab/rules/i03-i04.rules.json, sin cambios.
const project = 'demo-pulso-api';
const databaseOrigin = 'http://127.0.0.1:19000';
const authOrigin = 'http://127.0.0.1:19099';
const root = fileURLToPath(new NodeURL('../', import.meta.url));
let harness: ReturnType<typeof createTestHarness>;
let runtime: ReturnType<typeof harness.getWorker<Env>>;
let db: D1Database;
let administrator: { idToken: string; localId: string };
let other: { idToken: string; localId: string };

async function signUp() {
  const response = await fetch(`${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-emulator`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.status, 200, 'Auth emulator must be running on loopback:19099');
  const credentials = await response.json() as { idToken: string; localId: string };
  assert.ok(credentials.idToken && credentials.localId);
  return credentials;
}
async function seed(node: string, value: unknown) {
  const response = await fetch(`${databaseOrigin}/${node}.json?ns=${project}`, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5000),
    // Bypass exclusivo para preparar el emulador; el Worker nunca lo utiliza.
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal(response.status, 200, 'Local fixture setup failed');
  await response.body?.cancel();
}
async function api(idToken = administrator.idToken, headers: Record<string, string> = {}) {
  return runtime.fetch('http://127.0.0.1/api/pulso', { headers: { Authorization: `Bearer ${idToken}`, ...headers } });
}
async function evaluate(data: unknown) {
  await seed('ubicacion_buses/API-INTEGRATION', data);
  const response = await runtime.fetch('http://127.0.0.1/evaluate', { headers: { 'X-Pulso-Local': '1' } });
  assert.equal(response.status, 200);
  return response.json();
}
async function snapshot() {
  return JSON.stringify(await Promise.all(['tracking_state', 'tracking_observations', 'tracking_incidents']
    .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results)));
}

before(async () => {
  // No se reutilizan ni modifican las reglas del laboratorio que pudiera estar abierto.
  const rulesResponse = await fetch(`${databaseOrigin}/.settings/rules.json?ns=${project}`, {
    headers: { Authorization: 'Bearer owner' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  assert.equal(rulesResponse.status, 200, 'RTDB emulator must be running on loopback:19000');
  const policy = await rulesResponse.json() as { rules: { administradores?: { '.read'?: string } } };
  assert.equal(policy.rules.administradores?.['.read'], "auth != null && root.child('administradores').child(auth.uid).exists()");
  administrator = await signUp();
  other = await signUp();
  await seed(`administradores/${administrator.localId}`, { nombres: 'PRIVATE local administrator' });
  harness = createTestHarness({ workers: [{ config: {
    name: 'pulso-read-integration', main: path.join(root, 'src/index.ts'), compatibility_date: '2026-11-12',
    workers_dev: false, preview_urls: false, send_metrics: false,
    vars: {
      PULSO_LOCAL_ONLY: 'true', PULSO_MEMORY: 'd1-local',
      RTDB_MODE: 'local-authenticated', RTDB_ORIGIN: databaseOrigin, RTDB_NAMESPACE: project, BUS_ID: 'API-INTEGRATION',
      FIREBASE_ID_TOKEN: administrator.idToken, PUBLICATION_STALE_AFTER_MS: '180000',
      RECOVERY_CONFIRMATIONS_REQUIRED: '2', MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '5000',
      PULSO_ADMIN_PROJECT_ID: project, PULSO_ADMIN_RTDB_ORIGIN: databaseOrigin, PULSO_ADMIN_RTDB_NAMESPACE: project,
    },
    d1_databases: [{ binding: 'PULSO_DB', database_name: 'pulso-api-test',
      database_id: '00000000-0000-0000-0000-000000000003', remote: false, migrations_dir: path.join(root, 'migrations') }],
  } }] });
  await harness.listen();
  runtime = harness.getWorker<Env>();
  await runtime.applyD1Migrations('PULSO_DB');
  db = (await runtime.getEnv()).PULSO_DB as D1Database;
});
beforeEach(async () => {
  await db.batch(['tracking_incidents', 'tracking_observations', 'tracking_state'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
after(async () => { await harness?.close(); });

describe('API real en workerd, D1 local y reglas administrativas versionadas en emuladores Firebase', () => {
  it('autoriza al administrador y muestra D1 vacía sin solicitar cabecera local', async () => {
    const response = await api();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'no-data', busId: 'API-INTEGRATION', observedState: null,
      lastCheck: null, activeIncidents: [], recentIncidents: [] });
  });
  it('las reglas deniegan al usuario sin rol aunque envíe el UID de otro administrador', async () => {
    const response = await api(other.idToken, { 'X-User-Uid': administrator.localId, 'X-Pulso-Local': '1' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'access-denied' });
  });
  it('rechaza token inválido, vencido o firmado fuera del modo explícito de emulador', async () => {
    assert.equal((await api('invalid')).status, 401);
    const parts = administrator.idToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
    const expired = `${parts[0]}.${Buffer.from(JSON.stringify({ ...claims, exp: 1 })).toString('base64url')}.${parts[2]}`;
    assert.equal((await api(expired)).status, 401);
    // Se manipula un token emitido para NO administrador, no el UID de la petición.
    const otherParts = other.idToken.split('.');
    const otherClaims = JSON.parse(Buffer.from(otherParts[1], 'base64url').toString()) as Record<string, unknown>;
    // El emulador NO valida firmas: nunca mezclar tokens RS256 con este destino local.
    const forged = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fake' })).toString('base64url')}.${
      Buffer.from(JSON.stringify({ ...otherClaims, sub: administrator.localId })).toString('base64url')}.fake-signature`;
    assert.notEqual((await api(forged)).status, 200);
  });
  it('lee las comprobaciones e incidentes persistidos por /evaluate y no modifica ninguna tabla', async () => {
    const at = Date.now();
    await evaluate({ isActive: true, timestamp: at - 240_000, latitude: -12.123456, longitude: -77.123456 });
    const previous = await snapshot();
    const response = await api();
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.observedState.classification, 'active-publication-stale');
    assert.equal(body.activeIncidents.length, 1);
    assert.equal(body.recentIncidents[0].id, body.activeIncidents[0].id);
    assert.equal(body.activeIncidents[0].closedAt, null);
    assert.ok(body.lastCheck.evaluatedAt >= at);
    assert.equal(await snapshot(), previous);
    const text = JSON.stringify(body);
    for (const secret of [administrator.idToken, administrator.localId, 'PRIVATE', '-12.123456', '-77.123456', 'prior_state_json']) {
      assert.ok(!text.includes(secret));
    }
    await evaluate({ isActive: false });
    const stopped = await (await api()).json() as any;
    assert.equal(stopped.observedState.declaredActive, false);
    assert.deepEqual(stopped.activeIncidents, []);
    assert.equal(stopped.recentIncidents[0].closeReason, 'tracking-inactive');
  });
  it('la autorización se vuelve a comprobar al retirar el rol del administrador', async () => {
    await seed(`administradores/${administrator.localId}`, null);
    try { assert.equal((await api()).status, 403); }
    finally { await seed(`administradores/${administrator.localId}`, { nombres: 'PRIVATE local administrator' }); }
  });
  it('un error D1 responde como fallo de lectura, nunca como estado vacío', async () => {
    await db.prepare('ALTER TABLE tracking_incidents RENAME TO unavailable_incidents').run();
    try {
      const response = await api();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'read-failed' });
    } finally { await db.prepare('ALTER TABLE unavailable_incidents RENAME TO tracking_incidents').run(); }
  });
});
