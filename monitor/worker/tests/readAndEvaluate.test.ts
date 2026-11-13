import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTracking, validateTarget } from '../src/firebaseRtdb.ts';
import { toTrackingObservation } from '../src/toTrackingObservation.ts';
import worker, { readAndEvaluate } from '../src/index.ts';

const now = 1_800_000_000_000;
const target = { origin: 'http://127.0.0.1:9000', namespace: 'demo-el-burrito-i03i04', busId: 'BUS-001' };
const auth = { getIdToken: async () => 'temporary-test-token' };
const env = {
  PULSO_LOCAL_ONLY: 'true', RTDB_ORIGIN: target.origin, RTDB_NAMESPACE: target.namespace, BUS_ID: target.busId,
  PUBLICATION_STALE_AFTER_MS: '180000', RECOVERY_CONFIRMATIONS_REQUIRED: '2', MAX_FUTURE_SKEW_MS: '5000',
  READ_TIMEOUT_MS: '1000',
};
const payload = { isActive: true, timestamp: now - 10_000, latitude: -12.05, longitude: -77.08, heading: 0, speed: 0 };
const jsonFetch = (value: unknown) => async () => new Response(JSON.stringify(value));

describe('destino y cliente REST de solo lectura', () => {
  it('construye exclusivamente la lectura del bus y no sigue redirects', async () => {
    const result = await readTracking(target, auth, 1000, async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, target.origin);
      assert.equal(parsed.pathname, '/ubicacion_buses/BUS-001.json');
      assert.equal(parsed.searchParams.get('ns'), target.namespace);
      assert.equal(parsed.searchParams.get('auth'), 'temporary-test-token');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.body, undefined);
      return new Response(JSON.stringify(payload));
    });
    assert.equal(result.status, 'ok');
    assert.ok(!JSON.stringify(result).includes('temporary-test-token'));
  });

  for (const origin of ['https://example.firebaseio.com', 'http://192.168.1.2:9000', 'http://127.0.0.1:9000/path', 'http://a:b@localhost:9000', 'http://localhost:9000/?auth=secret']) {
    it(`rechaza un destino no autorizado (${origin.split('?')[0]})`, () => {
      assert.throws(() => validateTarget({ ...target, origin }), /Invalid local RTDB configuration/);
    });
  }
  for (const busId of ['', '../other', 'A/B', 'A.json?auth=x', 'A%2fB', '.', 'A B']) {
    it(`rechaza identificador de bus inválido ${JSON.stringify(busId)}`, () => {
      assert.throws(() => validateTarget({ ...target, busId }));
    });
  }
  it('rechaza namespaces que no son de laboratorio', () => {
    assert.throws(() => validateTarget({ ...target, namespace: 'production' }));
  });
  for (const status of [401, 403, 302, 500]) {
    it(`maneja HTTP ${status} sin exponer cuerpo o credenciales`, async () => {
      const result = await readTracking(target, auth, 1000, async () => new Response('PRIVATE ERROR', { status }));
      assert.equal(result.status, 'unavailable');
      assert.equal(result.error, status === 401 || status === 403 ? 'access-denied' : status === 302 ? 'redirect-blocked' : 'http-error');
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    });
  }
  it('no consulta sin token ni acepta el bypass owner del emulador', async () => {
    for (const token of [null, '', 'owner']) {
      const result = await readTracking(target, { getIdToken: async () => token }, 1000, async () => { throw new Error('Must not fetch'); });
      assert.equal(result.error, 'authentication-unavailable');
    }
  });
  it('oculta errores del proveedor de credenciales y de red', async () => {
    const failedAuth = await readTracking(target, { getIdToken: async () => { throw new Error('SECRET'); } }, 1000, jsonFetch(payload));
    const failedNetwork = await readTracking(target, auth, 1000, async () => { throw new Error('SECRET URL'); });
    assert.equal(failedAuth.error, 'authentication-unavailable');
    assert.equal(failedNetwork.error, 'network-error');
    assert.ok(!JSON.stringify([failedAuth, failedNetwork]).includes('SECRET'));
  });
  it('limita el tiempo también si fetch o el proveedor no atienden abort', async () => {
    const never = () => new Promise<never>(() => {});
    assert.equal((await readTracking(target, auth, 10, never)).error, 'timeout');
    assert.equal((await readTracking(target, { getIdToken: never }, 10, jsonFetch(payload))).error, 'timeout');
  });
  for (const body of ['', '<html>invalid</html>', '[]', 'true', '"text"', '{"x":']) {
    it(`rechaza respuesta inválida ${JSON.stringify(body)}`, async () => {
      assert.equal((await readTracking(target, auth, 1000, async () => new Response(body))).error, 'invalid-response');
    });
  }
  it('limita el tamaño del cuerpo antes de parsearlo', async () => {
    const result = await readTracking(target, auth, 1000, async () => new Response('x'.repeat(20_000)));
    assert.equal(result.error, 'response-too-large');
  });
  it('maneja un cuerpo interrumpido sin afirmar datos disponibles', async () => {
    const result = await readTracking(target, auth, 1000, async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('PRIVATE transport failure')); },
    })));
    assert.equal(result.error, 'invalid-response');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  });
  it('aplica el timeout mientras espera el cuerpo, no solo las cabeceras', async () => {
    const result = await readTracking(target, auth, 10, async () => new Response(new ReadableStream({ start() {} })));
    assert.equal(result.error, 'timeout');
  });
});

describe('adaptación del contrato actual y evaluación', () => {
  it('solo acepta campos publicados y nunca inventa telemetría futura', () => {
    const adapted = toTrackingObservation({ ...payload, tripSessionId: 'unexpected', gpsFixTimestamp: now, stopEvidence: { stoppedAt: now } }, now);
    assert.deepEqual(adapted.observation.current, payload);
    assert.equal(adapted.observation.planned, undefined);
    assert.equal(adapted.observation.evaluatedAt, now);
  });
  it('conserva tipos incorrectos como desconocidos sin convertir strings a números', () => {
    const adapted = toTrackingObservation({ isActive: 'false', timestamp: '123', speed: null }, now);
    assert.deepEqual(adapted.observation.current, {});
    assert.deepEqual(adapted.invalidFields, ['isActive', 'timestamp', 'speed']);
  });
  it('distingue nodo ausente de fuente inaccesible y de recorrido inactivo', async () => {
    const missing = await readAndEvaluate(env, { auth, fetchImpl: jsonFetch(null), now: () => now });
    assert.equal(missing.source.status, 'missing');
    assert.equal(missing.evaluation.classification, 'insufficient-data');
    const denied = await readAndEvaluate(env, { auth, fetchImpl: async () => new Response('', { status: 403 }), now: () => now });
    assert.equal(denied.evaluation.classification, 'source-unavailable');
    assert.equal(denied.evaluation.publication.ageMs, null);
    const inactive = await readAndEvaluate(env, { auth, fetchImpl: jsonFetch({ isActive: false }), now: () => now });
    assert.equal(inactive.evaluation.classification, 'inactive-unconfirmed');
  });
  it('publicación reciente no implica una medición GPS nueva', async () => {
    const result = await readAndEvaluate(env, { auth, fetchImpl: jsonFetch(payload), now: () => now });
    assert.equal(result.evaluation.classification, 'active-publishing');
    assert.equal(result.evaluation.publication.ageMs, 10_000);
    assert.equal(result.evaluation.gpsMeasurement.state, 'unknown');
    assert.equal(result.evaluation.gpsMeasurement.fixAgeMs, null);
    assert.equal(result.continuity, 'not-persisted');
    assert.ok(!JSON.stringify(result).includes('-12.05'));
  });
  it('obtiene la interrupción del dominio, sin conservar estado entre ejecuciones', async () => {
    const stale = await readAndEvaluate(env, { auth, fetchImpl: jsonFetch({ ...payload, timestamp: now - 240_000 }), now: () => now });
    assert.equal(stale.evaluation.classification, 'active-publication-stale');
    const fresh = await readAndEvaluate(env, { auth, fetchImpl: jsonFetch(payload), now: () => now });
    assert.equal(fresh.evaluation.classification, 'active-publishing');
    assert.equal(fresh.evaluation.recoveryState, 'none');
  });
  it('rechaza configuración antes de consultar y no revela valores', async () => {
    for (const override of [{ RTDB_ORIGIN: 'https://production.example' }, { BUS_ID: '../secret' }, { RECOVERY_CONFIRMATIONS_REQUIRED: '0' }, { READ_TIMEOUT_MS: '0' }]) {
      await assert.rejects(readAndEvaluate({ ...env, ...override }, { auth, fetchImpl: async () => { assert.fail('Must not fetch'); } }), /Invalid local/);
    }
  });
  it('expone solo la entrada HTTP local y exige cabecera explícita', async () => {
    for (const request of [new Request('https://worker.example/evaluate'), new Request('http://127.0.0.1:8787/evaluate'), new Request('http://127.0.0.1:8787/evaluate', { headers: { 'X-Pulso-Local': '1', Origin: 'https://other.example' } })]) {
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 403);
    }
    const headers = { 'X-Pulso-Local': '1' };
    assert.equal((await worker.fetch(new Request('http://127.0.0.1:8787/other', { headers }), env)).status, 404);
    assert.equal((await worker.fetch(new Request('http://127.0.0.1:8787/evaluate', { method: 'POST', headers }), env)).status, 405);
    assert.equal((await worker.fetch(new Request('http://127.0.0.1:8787/evaluate?url=x', { headers }), env)).status, 400);
    const response = await worker.fetch(new Request('http://127.0.0.1:8787/evaluate', { headers }), { ...env, BUS_ID: '/' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
  it('la entrada programada no imprime configuración ni credenciales inválidas', async () => {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => { messages.push(args); };
    try {
      await assert.rejects(worker.scheduled({} as ScheduledController, {
        ...env, PULSO_MEMORY: 'd1-local', BUS_ID: '/', FIREBASE_ID_TOKEN: 'PRIVATE TOKEN',
      }), { message: 'invalid-local-configuration' });
      assert.deepEqual(messages, [['{"error":"invalid-local-configuration"}']]);
    } finally {
      console.error = original;
    }
  });
});

describe('fronteras de seguridad e instalación aislada', () => {
  it('valida destino antes de autenticar y comprueba el límite exacto del cuerpo', async () => {
    for (const override of [
      { origin: 'http://127.0.0.1.evil.invalid' }, { origin: 'http://[::ffff:127.0.0.1]:9000' },
      { origin: 'https://localhost:9000' }, { namespace: 'demo-' }, { busId: 'B'.repeat(65) },
    ]) {
      let authenticated = false;
      await assert.rejects(readTracking({ ...target, ...override }, {
        getIdToken: async () => { authenticated = true; return 'sentinel'; },
      }, 100, async () => assert.fail('No fetch allowed')), { message: 'Invalid local RTDB configuration' });
      assert.equal(authenticated, false);
    }
    for (const timeout of [0, -1, 30001, 1.5]) {
      await assert.rejects(readTracking(target, auth, timeout), { message: 'Invalid local read timeout' });
    }
    for (const size of [16384, 16385]) {
      const body = JSON.stringify({ pad: 'x'.repeat(size - 10) });
      assert.equal(Buffer.byteLength(body), size);
      const result = await readTracking(target, auth, 100, async () => new Response(body));
      assert.equal(result.status, size === 16384 ? 'ok' : 'unavailable');
      if (size === 16385) assert.equal(result.error, 'response-too-large');
    }
  });
  it('rechaza Origin nulo y solicitudes cross-site sin permitir lecturas', async () => {
    const headers: Record<string, string>[] = [{ Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const extra of headers) {
      const response = await worker.fetch(new Request('http://localhost/evaluate', {
        headers: { 'X-Pulso-Local': '1', ...extra },
      }), env);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'local-only' });
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  });
  it('mantiene dependencias de desarrollo y cron solo en el entorno local con memoria', async () => {
    const { readFile } = await import('node:fs/promises');
    const { URL: NodeURL } = await import('node:url');
    const load = async (path: string) => JSON.parse(await readFile(new NodeURL(path, import.meta.url), 'utf8'));
    const pkg = await load('../package.json');
    const lock = await load('../package-lock.json');
    const config = await load('../wrangler.jsonc');
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@cloudflare/workers-types', '@types/node', 'typescript', 'wrangler']);
    assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path) assert.equal((entry as { dev?: boolean }).dev, true);
    }
    assert.equal(pkg.scripts.dev, 'wrangler dev --local --ip 127.0.0.1 --port 8787 --test-scheduled');
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.send_metrics, false);
    assert.equal(config.routes, undefined);
    assert.equal(config.triggers, undefined);
    assert.deepEqual(config.env['memory-local'].triggers.crons, ['* * * * *']);
    assert.equal(config.env['memory-local'].vars.PULSO_MEMORY, 'd1-local');
    assert.equal(config.env['memory-local'].vars.RTDB_MODE, 'local-authenticated');
    assert.equal(config.env['memory-local'].d1_databases[0].remote, false);
    assert.equal(config.dev.ip, '127.0.0.1');
  });
});

describe('lectura operativa pública explícita, sin red real', () => {
  const operative = {
    ...target, mode: 'operative-public' as const,
    origin: 'https://burritounmsm-default-rtdb.firebaseio.com/',
    namespace: 'burritounmsm-default-rtdb',
  };
  const operativeEnv = {
    ...env, RTDB_MODE: operative.mode, RTDB_ORIGIN: operative.origin, RTDB_NAMESPACE: operative.namespace,
    FIREBASE_ID_TOKEN: 'PRIVATE UNUSED TOKEN',
  };
  const noAuthentication = { getIdToken: async () => { assert.fail('Public mode must not obtain a token'); } };

  it('preserva el esquema exacto del diagnóstico local anterior', async () => {
    const result = await readAndEvaluate(env, { auth, now: () => now, fetchImpl: jsonFetch(null) });
    assert.deepEqual(Object.keys(result).sort(), [
      'authentication', 'busId', 'continuity', 'evaluatedAt', 'evaluation', 'input', 'source',
    ]);
  });

  it('comprueba los límites de bus operativo antes de consultar autenticación o transporte', async () => {
    for (const busId of ['', 'A'.repeat(65), 'A#B', 'A?B', 'A%2fB']) {
      await assert.rejects(readTracking({ ...operative, busId }, noAuthentication, 100,
        async () => assert.fail('Invalid bus must not fetch')), { message: 'Invalid local RTDB configuration' });
    }
    for (const busId of ['0', 'A'.repeat(64)]) {
      let calls = 0;
      const result = await readTracking({ ...operative, busId }, noAuthentication, 100, async (url, init) => {
        calls++;
        assert.equal(url, `${operative.origin}ubicacion_buses/${busId}.json`);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.deepEqual(init.headers, { Accept: 'application/json' });
        assert.equal(init.body, undefined);
        assert.equal(Object.hasOwn(init, 'credentials'), false);
        return new Response('null');
      });
      assert.deepEqual(result, { status: 'missing', data: null });
      assert.equal(calls, 1);
    }
  });

  it('solo realiza GET al bus configurado, sin query, cabeceras de autenticación ni proveedor de token', async () => {
    let calls = 0;
    const result = await readTracking(operative, noAuthentication, 1000, async (url, init) => {
      calls++;
      assert.equal(url, 'https://burritounmsm-default-rtdb.firebaseio.com/ubicacion_buses/BUS-001.json');
      assert.equal(new URL(url).search, '');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.body, undefined);
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      return new Response(JSON.stringify(payload));
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'ok');
  });

  for (const override of [
    { mode: undefined }, { mode: 'unknown' }, { origin: 'http://burritounmsm-default-rtdb.firebaseio.com' },
    { origin: 'https://elburrito-staging-default-rtdb.firebaseio.com' },
    { origin: 'https://burritounmsm-default-rtdb.firebaseio.com.evil.invalid' },
    { origin: 'https://burritounmsm-default-rtdb.firebaseio.com:444' },
    { origin: 'https://burritounmsm-default-rtdb.firebaseio.com/other' },
    { origin: 'https://user:secret@burritounmsm-default-rtdb.firebaseio.com' },
    { origin: 'https://burritounmsm-default-rtdb.firebaseio.com/?ns=other' },
    { namespace: target.namespace }, { busId: '' }, { busId: '../other' },
  ]) {
    it(`rechaza configuración operativa alterada: ${JSON.stringify(override)}`, async () => {
      await assert.rejects(readTracking({ ...operative, ...override } as typeof operative, noAuthentication, 1000,
        async () => assert.fail('No network allowed')), /Invalid local RTDB configuration/);
    });
  }

  it('no sigue redirects ni reintenta con otra identidad o destino ante errores', async () => {
    for (const status of [302, 401, 403, 500]) {
      let calls = 0;
      const result = await readTracking(operative, noAuthentication, 1000, async () => {
        calls++;
        return new Response('PRIVATE ERROR', { status });
      });
      assert.equal(result.status, 'unavailable');
      assert.equal(calls, 1);
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    }
  });

  it('conserva timeout, límite de respuesta y ausencia de datos en modo público', async () => {
    const timeout = await readTracking(operative, noAuthentication, 10, () => new Promise<never>(() => {}));
    assert.equal(timeout.error, 'timeout');
    const oversized = await readTracking(operative, noAuthentication, 1000, async () => new Response('x'.repeat(20_000)));
    assert.equal(oversized.error, 'response-too-large');
    const missing = await readAndEvaluate(operativeEnv, { auth: noAuthentication, fetchImpl: jsonFetch(null), now: () => now });
    assert.equal(missing.source.status, 'missing');
    assert.equal(missing.evaluation.classification, 'insufficient-data');
  });

  it('identifica el modo público en el diagnóstico y no convierte publicación en GPS nuevo', async () => {
    const result = await readAndEvaluate(operativeEnv, { auth: noAuthentication, fetchImpl: jsonFetch(payload), now: () => now });
    assert.equal(result.mode, 'operative-public');
    assert.equal(result.authentication, 'public-no-token');
    assert.equal(result.evaluation.classification, 'active-publishing');
    assert.equal(result.evaluation.gpsMeasurement.state, 'unknown');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  });

  it('no elige bus por defecto ni modo desconocido y no permite cron operativo', async () => {
    for (const override of [{ BUS_ID: '' }, { BUS_ID: undefined }, { RTDB_MODE: 'unknown' }]) {
      await assert.rejects(readAndEvaluate({ ...operativeEnv, ...override }, {
        auth: noAuthentication, fetchImpl: async () => assert.fail('No network allowed'),
      }), /Invalid local/);
    }
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => { messages.push(args); };
    globalThis.fetch = async () => assert.fail('Scheduled operative reads are not authorized');
    try {
      await assert.rejects(worker.scheduled({} as ScheduledController, operativeEnv), { message: 'operative-manual-only' });
      assert.deepEqual(messages, [['{"error":"operative-manual-only"}']]);
    } finally {
      console.error = originalError;
      globalThis.fetch = originalFetch;
    }
  });

  it('la configuración operativa queda incompleta sin bus y no activa rutas públicas', async () => {
    const { readFile } = await import('node:fs/promises');
    const { URL: NodeURL } = await import('node:url');
    const config = JSON.parse(await readFile(new NodeURL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.env.operative.vars.RTDB_MODE, 'operative-public');
    assert.equal(config.env.operative.vars.BUS_ID, '');
    assert.equal(config.env.operative.workers_dev, false);
    assert.equal(config.env.operative.preview_urls, false);
    assert.equal(config.env.operative.routes, undefined);
    assert.equal(config.env.operative.triggers, undefined);
  });
});
