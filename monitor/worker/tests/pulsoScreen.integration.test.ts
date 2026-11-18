import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createServer } from 'vite';
import { createTestHarness } from 'wrangler';
import { startBrowser } from '../../../tests/pulsoBrowser.ts';
import type { Env } from '../src/index.ts';

// Fixtures solo en Auth/RTDB emulados y D1 aislada. La pantalla recibe la API real.
const project = 'demo-pulso-api';
const root = fileURLToPath(new NodeURL('../', import.meta.url));
const frontend = path.resolve(root, '../..');
const database = 'http://127.0.0.1:19000';
let harness: ReturnType<typeof createTestHarness>;
let worker: ReturnType<typeof harness.getWorker<Env>>;
let db: D1Database;
let vite: Awaited<ReturnType<typeof createServer>>;
let browser: Awaited<ReturnType<typeof startBrowser>>;
let origin: string;
let administrator: { localId: string; idToken: string };
let pauseApi = false;
const paused: string[] = [];
const requests: { method: string; pathname: string }[] = [];
const exceptions: string[] = [];
const includes = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
async function seed(node: string, value: unknown) {
  const response = await fetch(`${database}/${node}.json?ns=${project}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
}
async function signUp(dni: string) {
  const response = await fetch('http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-emulator', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${dni}@admin.com`, password: 'Local-testing-only-42', returnSecureToken: true }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ localId: string; idToken: string }>;
}
async function login(dni: string) {
  await browser.waitFor('!!document.querySelector("#dni")');
  await browser.evaluate(`(() => {
    for (const [id, value] of [['dni', '${dni}'], ['password', 'Local-testing-only-42']]) {
      const input = document.getElementById(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await click('Entrar');
}
async function click(text: string) {
  await browser.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`);
  await browser.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Botón no disponible');
    button.click();
  })()`);
}
async function evaluate(data: unknown) {
  await seed('ubicacion_buses/SCREEN-INTEGRATION', data);
  const response = await worker.fetch('http://127.0.0.1/evaluate', { headers: { 'X-Pulso-Local': '1' } });
  assert.equal(response.status, 200);
  await response.body?.cancel();
}
async function snapshot() {
  return JSON.stringify(await Promise.all(['tracking_state', 'tracking_observations', 'tracking_incidents']
    .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results)));
}
before(async () => {
  administrator = await signUp('12345678');
  await signUp('87654321');
  await seed(`administradores/${administrator.localId}`, { nombres: 'Prueba local', apellidos: 'Central', correo: '12345678@admin.com' });
  harness = createTestHarness({ workers: [{ config: {
    name: 'pulso-screen-integration', main: path.join(root, 'src/index.ts'), compatibility_date: '2026-11-12',
    workers_dev: false, preview_urls: false, send_metrics: false,
    vars: {
      PULSO_LOCAL_ONLY: 'true', PULSO_MEMORY: 'd1-local', RTDB_MODE: 'local-authenticated',
      RTDB_ORIGIN: database, RTDB_NAMESPACE: project, BUS_ID: 'SCREEN-INTEGRATION',
      FIREBASE_ID_TOKEN: administrator.idToken, PUBLICATION_STALE_AFTER_MS: '180000',
      RECOVERY_CONFIRMATIONS_REQUIRED: '2', MAX_FUTURE_SKEW_MS: '5000', READ_TIMEOUT_MS: '5000',
      PULSO_ADMIN_PROJECT_ID: project, PULSO_ADMIN_RTDB_ORIGIN: database, PULSO_ADMIN_RTDB_NAMESPACE: project,
    },
    d1_databases: [{ binding: 'PULSO_DB', database_name: 'pulso-screen-test',
      database_id: '00000000-0000-0000-0000-000000000004', remote: false, migrations_dir: path.join(root, 'migrations') }],
  } }] });
  const running = await harness.listen();
  worker = harness.getWorker<Env>();
  await worker.applyD1Migrations('PULSO_DB');
  db = (await worker.getEnv()).PULSO_DB as D1Database;
  process.env.PULSO_WORKER_ORIGIN = running.url.origin;
  vite = await createServer({ root: frontend, mode: 'pulso-local',
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await startBrowser();
  browser.on('Runtime.exceptionThrown', p => exceptions.push(p.exceptionDetails.text));
  browser.on('Network.requestWillBeSent', p => {
    const url = new URL(p.request.url);
    if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname === '/evaluate')) {
      requests.push({ method: p.request.method, pathname: url.pathname });
    }
  });
  // Impedir que el navegador acceda a Internet, incluso para fuentes tipográficas.
  browser.on('Fetch.requestPaused', p => {
    const url = new URL(p.request.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      void browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    } else if (url.pathname === '/api/pulso' && pauseApi) paused.push(p.requestId);
    else void browser.send('Fetch.continueRequest', { requestId: p.requestId });
  });
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  await browser?.close();
  await vite?.close();
  await harness?.close();
  delete process.env.PULSO_WORKER_ORIGIN;
});

describe('Central → proxy Vite → Worker real → misma D1 local', { timeout: 120000 }, () => {
  it('entra con el login existente, navega desde el menú y muestra carga y D1 vacía', async () => {
    await browser.send('Page.navigate', { url: `${origin}/` });
    await login('12345678');
    await browser.waitFor('!!document.querySelector("a[href=\'/pulso\']")');
    pauseApi = true;
    await browser.evaluate('document.querySelector("a[href=\'/pulso\']").click()');
    await browser.waitFor(includes('Cargando PULSO…'));
    assert.equal(await browser.evaluate('location.pathname'), '/pulso');
    assert.equal(await browser.evaluate('document.querySelector("a[href=\'/pulso\']").getAttribute("aria-current")'), 'page');
    pauseApi = false;
    for (const requestId of paused.splice(0)) await browser.send('Fetch.continueRequest', { requestId });
    await browser.waitFor(includes('Sin registros de PULSO'));
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM tracking_observations').first<{ total: number }>())?.total, 0);
  });
  it('muestra comprobaciones sin incidentes y conserva la clasificación observada', async () => {
    await evaluate({ isActive: true, timestamp: Date.now() });
    const before = await snapshot();
    await click('Actualizar');
    await browser.waitFor(includes('Sin incidentes registrados'));
    await browser.waitFor(includes('Sin incidentes activos'));
    assert.ok(await browser.evaluate(includes('Seguimiento funcionando')));
    assert.ok(await browser.evaluate(includes('Inicio observado')));
    assert.ok(await browser.evaluate(includes('Tiempo de recorrido')));
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".pulso-screen h2")].map(h => h.textContent)'),
      ['Estado del recorrido', 'Estado de PULSO', 'Incidentes']);
    const start = (await db.prepare('SELECT observed_trip_started_at FROM tracking_state').first())?.observed_trip_started_at;
    assert.ok(typeof start === 'number');
    assert.equal(await browser.evaluate(`document.querySelector('.pulso-summary .card').innerText.includes(new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Lima' }).format(${start}))`), true);
    assert.equal(await snapshot(), before);
  });
  it('muestra abiertos y cerrados; mantiene los últimos 20 y no escribe ni evalúa al actualizar', async () => {
    for (let i = 0; i < 21; i++) {
      await evaluate({ isActive: true, timestamp: Date.now() - 240000 });
      if (i < 20) await evaluate({ isActive: false });
    }
    const before = await snapshot();
    await click('Actualizar');
    await browser.waitFor(includes('Seguimiento interrumpido'));
    const sizes = await browser.evaluate(`[...document.querySelectorAll('.pulso-incident-panel section')]
      .map(c => c.querySelectorAll('li').length)`);
    assert.deepEqual(sizes, [1, 20]);
    assert.ok(await browser.evaluate(includes('Abierto')));
    assert.ok(await browser.evaluate(includes('Cerrado')));
    assert.ok(await browser.evaluate(includes('Recorrido declarado inactivo')));
    assert.ok(await browser.evaluate(includes('Duración registrada')));
    assert.equal(await snapshot(), before);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(r => r.method === 'GET' && r.pathname === '/api/pulso'));
  });
  it('distingue datos antiguos sin convertirlos en un nuevo estado del seguimiento', async () => {
    // Envejecer la comprobación aislada conservando el enlace estado/observación.
    const at = Date.now() - 240000;
    await db.batch([db.prepare('UPDATE tracking_state SET evaluated_at = ?, observed_trip_started_at = ?').bind(at, at - 2_700_000),
      db.prepare('UPDATE tracking_observations SET evaluated_at = ? WHERE check_id IN (SELECT last_check_id FROM tracking_state)').bind(at)]);
    const before = await snapshot();
    await click('Actualizar');
    await browser.waitFor(includes('Datos antiguos:'));
    assert.ok(await browser.evaluate(includes('Último estado: Seguimiento interrumpido')));
    assert.ok(await browser.evaluate(includes('45 min (hasta la última comprobación guardada)')));
    assert.equal(await snapshot(), before);
  });
  it('es adaptable en escritorio y móvil; el menú móvil navega y se cierra', async t => {
    const evidence = await mkdtemp(path.join(tmpdir(), 'opencode/pulso-screen-evidence-'));
    for (const [width, name] of [[1280, 'desktop'], [390, 'mobile']] as const) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.waitFor(`window.innerWidth === ${width}`);
      if (width === 390) await browser.waitFor('document.querySelector(".sidebar").getBoundingClientRect().right <= 0');
      assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".pulso-summary")).gridTemplateColumns.split(" ").length'), width === 390 ? 1 : 2);
      const image = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(path.join(evidence, `${name}.png`), Buffer.from(image.data, 'base64'));
    }
    await browser.evaluate('document.querySelector("button[aria-label=\'Abrir menú\']").click()');
    await browser.waitFor('!!document.querySelector(".sidebar.is-open")');
    await browser.evaluate('document.querySelector("a[href=\'/buses\']").click()');
    await browser.waitFor('location.pathname === "/buses" && !document.querySelector(".sidebar.is-open")');
    await browser.evaluate('document.querySelector("button[aria-label=\'Abrir menú\']").click()');
    await browser.evaluate('document.querySelector("a[href=\'/pulso\']").click()');
    await browser.waitFor(includes('Datos antiguos:'));
    assert.ok(await browser.evaluate(includes('45 min (hasta la última comprobación guardada)')));
    t.diagnostic(`Capturas locales: ${evidence}`);
  });
  it('muestra acceso denegado al retirar el rol aunque React conserve la sesión', async () => {
    await seed(`administradores/${administrator.localId}`, null);
    await click('Actualizar');
    await browser.waitFor(includes('Acceso denegado'));
    assert.equal(await browser.evaluate(includes('Últimos 20 incidentes')), false);
    await seed(`administradores/${administrator.localId}`, { nombres: 'Prueba local' });
    await click('Actualizar');
    await browser.waitFor(includes('Datos antiguos:'));
  });
  it('un fallo real de D1 produce error de consulta y permite reintentar, nunca estado vacío', async () => {
    await db.prepare('ALTER TABLE tracking_incidents RENAME TO unavailable_incidents').run();
    try {
      await click('Actualizar');
      await browser.waitFor(includes('Error de consulta'));
      assert.equal(await browser.evaluate(includes('Sin registros de PULSO')), false);
    } finally { await db.prepare('ALTER TABLE unavailable_incidents RENAME TO tracking_incidents').run(); }
    await click('Actualizar');
    await browser.waitFor(includes('Datos antiguos:'));
    assert.deepEqual(exceptions, []);
  });
  it('no inventa inicio anterior, oculta tiempos al detener y conserva el inicio al volver a Central', async () => {
    await db.prepare('UPDATE tracking_state SET observed_trip_started_at = NULL').run();
    await click('Actualizar');
    await browser.waitFor(includes('Inicio no determinado'));
    assert.equal(await browser.evaluate(includes('Tiempo de recorrido')), false);
    await evaluate({ isActive: false });
    await click('Actualizar');
    await browser.waitFor(includes('Bus fuera de recorrido'));
    assert.equal(await browser.evaluate(includes('Inicio observado')), false);
    assert.equal(await browser.evaluate(includes('Tiempo de recorrido')), false);
    assert.equal(await browser.evaluate(includes('No aplica')), false);
    assert.ok(await browser.evaluate(includes('Sin verificación independiente')));
    await evaluate({ isActive: true, timestamp: Date.now() });
    await click('Actualizar');
    await browser.waitFor(includes('0 min'));
    const start = (await db.prepare('SELECT observed_trip_started_at FROM tracking_state').first())?.observed_trip_started_at;
    const before = await snapshot();
    await browser.evaluate('document.querySelector("a[href=\'/buses\']").click()');
    await browser.waitFor('location.pathname === "/buses"');
    await browser.evaluate('document.querySelector("a[href=\'/pulso\']").click()');
    await browser.waitFor(includes('0 min'));
    assert.equal((await db.prepare('SELECT observed_trip_started_at FROM tracking_state').first())?.observed_trip_started_at, start);
    assert.equal(await snapshot(), before);
  });
  it('rechaza al usuario sin rol en el acceso habitual de Central', async () => {
    await browser.evaluate(`(async () => { const { firebaseAuth } = await import('/src/shared/config/firebase.ts'); await firebaseAuth.signOut(); })()`);
    await login('87654321');
    await browser.waitFor(includes('No autorizado'));
    assert.equal(await browser.evaluate('!!document.querySelector("a[href=\'/pulso\']")'), false);
  });
});
