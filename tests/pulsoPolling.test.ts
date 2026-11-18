import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'vite';
import { startBrowser } from './pulsoBrowser.ts';

// Pantalla y servicio reales; reloj y respuestas HTTP controlados, sin recursos remotos.
const entry = `
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PulsoScreen } from '/src/features/pulso/screen/PulsoScreen.tsx';
import { firebaseAuth } from '/src/shared/config/firebase.ts';
await firebaseAuth.authStateReady();
let tokenReads = 0;
Object.defineProperty(firebaseAuth, 'currentUser', { get: () => ({ getIdToken: async () => 'session-' + (++tokenReads) }) });
const base = Date.now();
let offset = 0;
Date.now = () => base + offset;
const intervals = new Map();
let nextId = 0;
const realSetInterval = window.setInterval.bind(window);
const realClearInterval = window.clearInterval.bind(window);
window.setInterval = (callback, ms, ...args) => {
  if (ms !== 1000 && ms !== 60000) return realSetInterval(callback, ms, ...args);
  const id = --nextId;
  intervals.set(id, { callback, ms, next: offset + ms });
  return id;
};
window.clearInterval = id => { if (!intervals.delete(id)) realClearInterval(id); };
const requests = [];
const realFetch = window.fetch.bind(window);
window.fetch = (url, init) => {
  if (url !== '/api/pulso') return realFetch(url, init);
  return new Promise((resolve, reject) => {
    const request = { url, method: init.method, authorization: init.headers.Authorization, signal: init.signal, resolve, aborted: false };
    requests.push(request);
    init.signal.addEventListener('abort', () => {
      request.aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
};
const root = createRoot(document.getElementById('root'));
window.polling = {
  requests,
  mount: () => root.render(createElement(StrictMode, null, createElement(PulsoScreen))),
  leave: () => root.render(null),
  intervalCount: () => intervals.size,
  advance: ms => {
    const end = offset + ms;
    while (true) {
      const next = Math.min(...[...intervals.values()].map(timer => timer.next));
      if (next > end) break;
      offset = next;
      for (const timer of intervals.values()) if (timer.next === next) { timer.next += timer.ms; timer.callback(); }
    }
    offset = end;
  },
  respond: (index, status = 200, fresh = false) => {
    const evaluatedAt = fresh ? Date.now() : base;
    const ageMs = Date.now() - evaluatedAt;
    requests[index].resolve(Response.json({
      status: 'observed', busId: 'POLLING-TEST',
      observedState: { classification: 'active-publishing', monitoringActive: true, declaredActive: true,
        publicationTimestamp: evaluatedAt, observedTripStartedAt: base - 2700000 },
      lastCheck: { evaluatedAt, ageMs, staleAfterMs: 180000, freshness: ageMs > 180000 ? 'old' : 'recent', sourceStatus: 'ok' },
      activeIncidents: [], recentIncidents: [],
    }, { status }));
  },
};
window.polling.mount();
`;
let vite: Awaited<ReturnType<typeof createServer>>;
let browser: Awaited<ReturnType<typeof startBrowser>>;
const exceptions: string[] = [];
const includes = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
async function count() { return browser.evaluate('window.polling.requests.length'); }
async function respond(index: number, status = 200, fresh = false) {
  await browser.evaluate(`window.polling.respond(${index}, ${status}, ${fresh})`);
  await browser.waitFor('!![...document.querySelectorAll("button")].find(b => b.textContent === "Actualizar" && !b.disabled)');
}
async function refresh() {
  await browser.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Actualizar").click()');
}
before(async () => {
  vite = await createServer({ mode: 'pulso-local', appType: 'custom', server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error', plugins: [{ name: 'pulso-polling-test',
      resolveId(id) { if (id === '/pulso-polling-entry.ts') return '\0pulso-polling-entry'; },
      load(id) { if (id === '\0pulso-polling-entry') return entry; },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/polling-test') return next();
          void server.transformIndexHtml('/polling-test', '<div id="root"></div><script type="module" src="/pulso-polling-entry.ts"></script>')
            .then(html => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
        });
      },
    }] });
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  browser = await startBrowser();
  browser.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
  browser.on('Fetch.requestPaused', event => {
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(event.request.url).hostname);
    void browser.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId: event.requestId, ...(!local ? { errorReason: 'BlockedByClient' } : {}),
    });
  });
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/polling-test` });
  await browser.waitFor('window.polling?.requests.length === 1');
});
after(async () => { await browser?.close(); await vite?.close(); });

describe('PULSO: refresco en navegador con reloj controlado y StrictMode', () => {
  it('consulta al entrar y a los 60 segundos sin desmontar datos ni solapar consultas', async () => {
    assert.ok(await browser.evaluate(includes('Cargando PULSO…')));
    await respond(0);
    assert.ok(await browser.evaluate(includes('45 min')));
    await browser.evaluate('window.summaryCard = document.querySelector(".pulso-summary .card"); window.polling.advance(59999)');
    assert.equal(await count(), 1);
    await browser.evaluate('window.polling.advance(1)');
    await browser.waitFor('window.polling.requests.length === 2');
    await browser.waitFor(includes('46 min'));
    assert.equal(await browser.evaluate('window.summaryCard === document.querySelector(".pulso-summary .card")'), true);
    assert.equal(await browser.evaluate(includes('Cargando PULSO…')), false);
    assert.ok(await browser.evaluate(includes('Consultando…')));
    await browser.evaluate('window.polling.advance(120000); document.querySelector("button").click()');
    assert.equal(await count(), 2);
    await respond(1);
    assert.ok(await browser.evaluate(includes('48 min')));
  });
  it('el botón comparte la consulta, conserva datos antiguos y no reinicia su antigüedad', async () => {
    await browser.evaluate('window.polling.advance(60000)');
    await browser.waitFor('window.polling.requests.length === 3');
    await respond(2);
    assert.ok(await browser.evaluate(includes('45 min (hasta la última comprobación guardada)')));
    assert.ok(await browser.evaluate(includes('Datos antiguos:')));
    assert.equal(await browser.evaluate(includes('Comprobación reciente')), false);
    await refresh();
    await browser.waitFor('window.polling.requests.length === 4');
    assert.ok(await browser.evaluate(includes('Datos antiguos:')));
    assert.equal(await browser.evaluate('window.summaryCard === document.querySelector(".pulso-summary .card")'), true);
    await respond(3);
    assert.ok(await browser.evaluate(includes('Datos antiguos:')));
  });
  it('un error conserva la edad y advierte que los datos no se actualizaron; luego se recupera', async () => {
    await refresh();
    await browser.waitFor('window.polling.requests.length === 5');
    await respond(4, 503);
    assert.ok(await browser.evaluate(includes('Error de consulta')));
    assert.ok(await browser.evaluate(includes('no se pudo confirmar si hay comprobaciones nuevas')));
    assert.ok(await browser.evaluate(includes('Datos antiguos:')));
    await browser.evaluate('window.polling.advance(60000)');
    await browser.waitFor('window.polling.requests.length === 6');
    await respond(5, 200, true);
    assert.equal(await browser.evaluate(includes('Error de consulta')), false);
    assert.equal(await browser.evaluate(includes('Datos antiguos:')), false);
    assert.ok(await browser.evaluate(includes('Comprobación reciente')));
    await refresh();
    await browser.waitFor('window.polling.requests.length === 7');
    await respond(6, 503);
    assert.ok(await browser.evaluate(includes('hasta la última comprobación guardada')));
    assert.equal(await browser.evaluate(includes('Comprobación reciente')), false);
    assert.ok(await browser.evaluate(includes('Última comprobación guardada')));
  });
  it('una denegación retira los datos y una consulta posterior reutiliza la sesión', async () => {
    await refresh();
    await browser.waitFor('window.polling.requests.length === 8');
    await respond(7, 403);
    assert.ok(await browser.evaluate(includes('Acceso denegado')));
    assert.equal(await browser.evaluate('!!document.querySelector(".pulso-summary")'), false);
    await refresh();
    await browser.waitFor('window.polling.requests.length === 9');
    await respond(8);
    assert.ok(await browser.evaluate(includes('Datos antiguos:')));
    const requests = await browser.evaluate('window.polling.requests.map(({url, method, authorization}) => ({url, method, authorization}))');
    assert.ok(requests.every((r: { url: string; method: string; authorization: string }) =>
      r.url === '/api/pulso' && r.method === 'GET' && /^Bearer session-\d+$/.test(r.authorization)));
    assert.equal(new Set(requests.map((r: { authorization: string }) => r.authorization)).size, requests.length);
  });
  it('salir aborta la consulta, limpia temporizadores e ignora respuestas tardías; volver consulta una sola vez', async () => {
    await refresh();
    await browser.waitFor('window.polling.requests.length === 10');
    await browser.evaluate('window.polling.leave()');
    await browser.waitFor('window.polling.intervalCount() === 0');
    assert.equal(await browser.evaluate('window.polling.requests[9].aborted'), true);
    await browser.evaluate('window.polling.respond(9); window.polling.advance(180000)');
    assert.equal(await count(), 10);
    assert.equal(await browser.evaluate('document.getElementById("root").textContent'), '');
    await browser.evaluate('window.polling.mount()');
    await browser.waitFor('window.polling.requests.length === 11');
    assert.equal(await browser.evaluate('window.polling.intervalCount()'), 2);
    await respond(10);
    assert.deepEqual(exceptions, []);
  });
  it('la advertencia de antigüedad aparece aunque fallen consultas y la siguiente siga pendiente', async () => {
    await refresh();
    await browser.waitFor('window.polling.requests.length === 12');
    await respond(11, 200, true);
    assert.ok(await browser.evaluate(includes('Comprobación reciente')));
    await refresh();
    await browser.waitFor('window.polling.requests.length === 13');
    await respond(12, 503);
    await browser.evaluate('window.polling.advance(181000)');
    await browser.waitFor(includes('Datos antiguos:'));
    assert.ok(await browser.evaluate(includes('Error de consulta')));
    assert.equal(await count(), 14);
    assert.equal(await browser.evaluate(includes('Comprobación reciente')), false);
    await browser.evaluate('window.polling.leave()');
    await browser.waitFor('window.polling.intervalCount() === 0');
    assert.deepEqual(exceptions, []);
  });
});
