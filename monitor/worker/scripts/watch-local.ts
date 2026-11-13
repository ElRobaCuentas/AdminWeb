import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const CHECK_INTERVAL_MS = 60_000;
const scheduledUrl = 'http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*';

interface Dependencies {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  report?: (message: string) => void;
}

// Wrangler expone eventos de prueba, pero no activa un reloj cron en desarrollo.
// Este ejecutor solo dispara esa entrada fija de loopback, nunca consulta Firebase.
export async function watchLocal({ signal, fetchImpl = fetch, now = Date.now,
  sleep = async (ms, abort) => { await setTimeout(ms, undefined, { signal: abort }); },
  report = console.log,
}: Dependencies): Promise<void> {
  while (!signal.aborted) {
    const startedAt = now();
    try {
      const response = await fetchImpl(scheduledUrl, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      await response.body?.cancel();
      report(JSON.stringify({ event: 'local-scheduled-check', status: response.ok ? 'ok' : 'failed', httpStatus: response.status }));
    } catch {
      if (signal.aborted) return;
      report(JSON.stringify({ event: 'local-scheduled-check', status: 'request-failed' }));
    }
    try {
      await sleep(Math.max(0, CHECK_INTERVAL_MS - (now() - startedAt)), signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await watchLocal({ signal: controller.signal });
}
