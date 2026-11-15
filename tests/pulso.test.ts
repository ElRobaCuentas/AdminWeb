import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPulso, parsePulsoData, PulsoQueryError } from '../src/features/pulso/services/pulso_service.ts';
import { checkAge, formatDuration, stateLabels } from '../src/features/pulso/pulsoPresentation.ts';
import { readPulsoApiUrl } from '../src/shared/config/env.ts';

const empty = { status: 'no-data', busId: 'TEST', observedState: null, lastCheck: null, activeIncidents: [], recentIncidents: [] };
const observed = {
  ...empty, status: 'observed',
  observedState: { classification: 'active-publishing', monitoringActive: true, declaredActive: true, publicationTimestamp: 1000 },
  lastCheck: { evaluatedAt: 1000, ageMs: 50, staleAfterMs: 180000, freshness: 'recent', sourceStatus: 'ok' },
};
const fetchOf = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;
const signal = () => new AbortController().signal;
describe('cliente PULSO: contrato, sesión y consulta exclusiva de lectura', () => {
  it('consulta el origen HTTPS configurado con el mismo Bearer, sin cookies ni redirects', async () => {
    await getPulso(async () => 'session-token', signal(), (async (url, options) => {
      assert.equal(url, 'https://pulso.test.invalid/api/pulso');
      assert.deepEqual(options?.headers, { Authorization: 'Bearer session-token' });
      assert.equal(options?.method, 'GET');
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.redirect, 'error');
      return Response.json(empty);
    }) as typeof fetch, 'https://pulso.test.invalid/');
  });
  it('mantiene el proxy local y exige origen real en producción sin bloquear otras funciones del panel', () => {
    assert.equal(readPulsoApiUrl(undefined, false), '/api/pulso');
    assert.throws(() => readPulsoApiUrl(undefined, true), /VITE_PULSO_API_ORIGIN/);
    assert.throws(() => readPulsoApiUrl('', true), /VITE_PULSO_API_ORIGIN/);
  });
  it('rechaza orígenes inseguros antes de obtener tokens o hacer HTTP', async () => {
    let calls = 0;
    for (const origin of ['http://pulso.test.invalid', 'https://localhost', 'https://127.0.0.1',
      'https://user:secret@pulso.test.invalid', 'https://pulso.test.invalid/path', 'https://pulso.test.invalid/?token=x',
      'https://pulso.test.invalid/#token', 'invalid']) {
      await assert.rejects(getPulso(async () => { calls++; return 'token'; }, signal(),
        (async () => { calls++; return Response.json(empty); }) as typeof fetch, origin), PulsoQueryError);
    }
    assert.equal(calls, 0);
  });
  it('reutiliza el token, solo hace GET /api/pulso y no permite caché ni redirecciones', async () => {
    let calls = 0;
    const result = await getPulso(async () => 'session-token', signal(), (async (url, options) => {
      calls++;
      assert.equal(url, '/api/pulso');
      assert.equal(options?.method, 'GET');
      assert.deepEqual(options?.headers, { Authorization: 'Bearer session-token' });
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.body, undefined);
      return Response.json(empty);
    }) as typeof fetch);
    assert.equal(calls, 1);
    assert.deepEqual(result, empty);
  });
  it('sin sesión no llama al Worker', async () => {
    await assert.rejects(getPulso(async () => null, signal(), (() => { throw new Error('No debe llamar'); }) as typeof fetch),
      (e: unknown) => e instanceof PulsoQueryError && e.denied);
  });
  for (const status of [401, 403]) it(`distingue acceso denegado HTTP ${status}`, async () => {
    await assert.rejects(getPulso(async () => 'token', signal(), fetchOf(status, { error: 'private' })),
      (e: unknown) => e instanceof PulsoQueryError && e.denied && !e.message.includes('private'));
  });
  for (const status of [404, 500, 503]) it(`HTTP ${status} no se transforma en datos vacíos`, async () => {
    await assert.rejects(getPulso(async () => 'token', signal(), fetchOf(status, empty)),
      (e: unknown) => e instanceof PulsoQueryError && !e.denied);
  });
  it('rechaza HTML, respuestas incompletas e inconsistencias de D1 vacía', async () => {
    await assert.rejects(getPulso(async () => 'token', signal(), (async () => new Response('<html>SPA</html>')) as typeof fetch));
    for (const value of [null, {}, { ...empty, lastCheck: observed.lastCheck },
      { ...observed, observedState: { ...observed.observedState, classification: 'new-state' } }]) {
      assert.throws(() => parsePulsoData(value), PulsoQueryError);
    }
  });
  it('errores de red o del proveedor de token no son denegación ni exponen mensajes internos', async () => {
    for (const token of [async () => { throw new Error('sensitive'); }, async () => 'token']) {
      await assert.rejects(getPulso(token, signal(), (async () => { throw new Error('sensitive'); }) as typeof fetch),
        (e: unknown) => e instanceof PulsoQueryError && !e.denied && !e.message.includes('sensitive'));
    }
  });
  it('cancelar mientras se obtiene el token termina la consulta sin llamar a la API', async () => {
    const controller = new AbortController();
    let resolve: (token: string) => void = () => {};
    let calls = 0;
    const result = getPulso(() => new Promise(r => { resolve = r; }), controller.signal,
      (async () => { calls++; return Response.json(empty); }) as typeof fetch);
    controller.abort();
    await assert.rejects(result);
    resolve('token');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 0);
  });
  it('acepta incidentes abiertos y cerrados y conserva exactamente los últimos 20', () => {
    const open = { id: 'open', kind: 'tracking-interrupted', openedAt: 1000, updatedAt: 2000,
      closedAt: null, closeReason: null, durationMs: null };
    const closed = { ...open, id: 'closed', closedAt: 3000, closeReason: 'tracking-inactive', durationMs: 2000 };
    const history = Array.from({ length: 20 }, (_, i) => ({ ...closed, id: String(i) }));
    assert.deepEqual(parsePulsoData({ ...observed, activeIncidents: [open], recentIncidents: history }).recentIncidents, history);
    assert.throws(() => parsePulsoData({ ...observed, activeIncidents: [closed] }));
    assert.throws(() => parsePulsoData({ ...observed, recentIncidents: [...history, closed] }));
  });
});
describe('presentación sin reevaluar el seguimiento', () => {
  it('distingue ausencia de registros de comprobaciones sin incidentes', () => {
    assert.equal(parsePulsoData(empty).status, 'no-data');
    assert.equal(parsePulsoData(observed).status, 'observed');
  });
  it('envejece la comprobación aunque la pantalla permanezca abierta sin peticiones', () => {
    const data = parsePulsoData(observed);
    const check = data.lastCheck!;
    assert.deepEqual(checkAge(check, 5000, 5000 + 179950), { ageMs: 180000, old: false });
    assert.deepEqual(checkAge(check, 5000, 5000 + 179951), { ageMs: 180001, old: true });
    assert.equal(data.observedState?.classification, 'active-publishing');
    assert.equal(stateLabels['inactive-unconfirmed'].label, 'Recorrido inactivo · Finalización no confirmada');
  });
  it('no rejuvenece un dato marcado antiguo por el servidor ni por reloj local regresivo', () => {
    assert.equal(checkAge({ ...parsePulsoData(observed).lastCheck!, freshness: 'old' }, 5000, 4000).old, true);
  });
  it('formatea duración sin confundir milisegundos, segundos y minutos', () => {
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(180001), '3 min 0 s');
    assert.equal(formatDuration(3661000), '1 h 1 min');
  });
});
