import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readAndEvaluate } from '../src/index.ts';

// Prueba HTTP real de emuladores locales; nunca se habilita un destino remoto.
it('FirebaseLab: token de Auth y lectura RTDB denegada por las reglas actuales', {
  skip: process.env.PULSO_RUN_EMULATOR_TESTS !== '1',
}, async () => {
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-emulator', {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'Auth emulator must be running');
  const credentials = await response.json() as { idToken?: string; localId?: string };
  assert.ok(credentials.idToken && credentials.localId, 'Auth emulator did not issue a local identity');
  const ownNode = new URL(`/privado/${encodeURIComponent(credentials.localId)}.json`, 'http://127.0.0.1:9000');
  ownNode.searchParams.set('ns', 'demo-el-burrito-i03i04');
  const unauthenticated = await fetch(ownNode, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.ok([401, 403].includes(unauthenticated.status), 'Private node must deny anonymous HTTP requests');
  ownNode.searchParams.set('auth', credentials.idToken);
  const authenticated = await fetch(ownNode, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(authenticated.status, 200, 'Rules must recognize the temporary identity on its own private node');
  assert.equal(await authenticated.json(), null, 'The temporary identity must have no seeded data');
  const result = await readAndEvaluate({
    PULSO_LOCAL_ONLY: 'true', RTDB_ORIGIN: 'http://127.0.0.1:9000',
    RTDB_NAMESPACE: 'demo-el-burrito-i03i04', BUS_ID: 'PULSO-TEST',
    PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2',
    MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '5000',
  }, { auth: { getIdToken: async () => credentials.idToken! } });
  assert.equal(result.source.error, 'access-denied');
  assert.equal(result.evaluation.classification, 'source-unavailable');
  assert.ok(!JSON.stringify(result).includes(credentials.idToken));
});
