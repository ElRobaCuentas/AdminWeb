import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CDP nativo: navegador instalado, sin dependencias ni descargas de navegadores.
export async function startBrowser() {
  let executable = process.env.PULSO_CHROME;
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    if (executable) break;
    try { await access(candidate); executable = candidate; } catch { /* Probar el siguiente instalado. */ }
  }
  assert.ok(executable, 'Indicar PULSO_CHROME con la ruta de Chrome/Chromium instalado.');
  const profile = await mkdtemp(path.join(tmpdir(), 'opencode/pulso-browser-'));
  const processHandle = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    let port = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { /* Esperar arranque. */ }
      if (port) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(port, 'Chrome no inició CDP.');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
    socket = new WebSocket(pages[0].webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Map<string, (p: any) => void>();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request?.timer);
        if (message.error) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      } else listeners.get(message.method)?.(message.params);
    });
    function send(method: string, params: object = {}): Promise<any> {
      const current = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(current, { resolve, reject, timer });
        socket!.send(JSON.stringify({ id: current, method, params }));
      });
    }
    async function evaluate(expression: string): Promise<any> {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function waitFor(expression: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.fail(`No se cumplió: ${expression}\n${await evaluate('document.body.innerText')}`);
    }
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    return { send, evaluate, waitFor, on: (event: string, callback: (p: any) => void) => listeners.set(event, callback),
      close: async () => {
        socket?.close();
        if (processHandle.exitCode === null && processHandle.signalCode === null) {
          processHandle.kill();
          await new Promise(r => processHandle.once('exit', r));
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } };
  } catch (error) {
    socket?.close(); processHandle.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}
