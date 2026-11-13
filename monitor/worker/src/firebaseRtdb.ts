export type RtdbMode = 'local-authenticated' | 'operative-public';

export interface RtdbTarget {
  readonly mode?: RtdbMode;
  readonly origin: string;
  readonly namespace: string;
  readonly busId: string;
}

// Proveedor intercambiable. Un ID token temporal no resuelve vigilancia continua.
export interface AuthenticationProvider {
  getIdToken(signal: AbortSignal): Promise<string | null>;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ReadError = 'authentication-unavailable' | 'access-denied' | 'redirect-blocked' |
  'http-error' | 'network-error' | 'timeout' | 'invalid-response' | 'response-too-large';
export interface ReadResult {
  readonly status: 'ok' | 'missing' | 'unavailable';
  readonly data?: unknown;
  readonly error?: ReadError;
  readonly httpStatus?: number;
}

export function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

export function getRtdbMode(value: string | undefined): RtdbMode {
  if (value === undefined || value === 'local-authenticated') return 'local-authenticated';
  if (value === 'operative-public') return 'operative-public';
  throw new Error('Invalid local RTDB configuration');
}

const OPERATIVE_ORIGIN = 'https://burritounmsm-default-rtdb.firebaseio.com';
const OPERATIVE_NAMESPACE = 'burritounmsm-default-rtdb';

export function validateTarget(target: RtdbTarget): void {
  try {
    const url = new URL(target.origin);
    const mode = getRtdbMode(target.mode);
    const destinationAllowed = mode === 'operative-public'
      ? url.origin === OPERATIVE_ORIGIN && target.namespace === OPERATIVE_NAMESPACE
      : url.protocol === 'http:' && isLoopback(url.hostname) && /^demo-[a-z0-9-]{1,60}$/.test(target.namespace);
    if (!destinationAllowed || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.busId)) throw new Error();
  } catch {
    throw new Error('Invalid local RTDB configuration');
  }
}

const MAX_RESPONSE_BYTES = 16_384;

export async function readBody(response: Response): Promise<string | null> {
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readTracking(
  target: RtdbTarget, authentication: AuthenticationProvider, timeoutMs: number,
  fetchImpl: HttpFetch = fetch,
): Promise<ReadResult> {
  validateTarget(target);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Invalid local read timeout');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (error: ReadError, httpStatus?: number): ReadResult => ({ status: 'unavailable', error, ...(httpStatus === undefined ? {} : { httpStatus }) });
  const operation = async (): Promise<ReadResult> => {
    const url = new URL(`/ubicacion_buses/${target.busId}.json`, target.origin);
    if (getRtdbMode(target.mode) === 'local-authenticated') {
      let token: string | null;
      try {
        token = await authentication.getIdToken(controller.signal);
      } catch {
        return unavailable('authentication-unavailable');
      }
      if (!token || token === 'owner' || /\s/.test(token)) return unavailable('authentication-unavailable');
      url.searchParams.set('ns', target.namespace);
      url.searchParams.set('auth', token);
    }
    controller.signal.throwIfAborted();
    // Modo operativo: sin token, query ni fallback. No registrar URLs autenticadas del emulador.
    const response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) return unavailable('access-denied', response.status);
      if (response.redirected || (response.status >= 300 && response.status < 400)) return unavailable('redirect-blocked', response.status);
      return unavailable('http-error', response.status);
    }
    try {
      const text = await readBody(response);
      if (text === null) return unavailable('response-too-large');
      const data: unknown = JSON.parse(text);
      if (data === null) return { status: 'missing', data: null };
      if (typeof data !== 'object' || Array.isArray(data)) return unavailable('invalid-response');
      return { status: 'ok', data };
    } catch {
      return unavailable('invalid-response');
    }
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<ReadResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(unavailable('timeout')); }, timeoutMs);
      }),
    ]);
  } catch {
    return unavailable(controller.signal.aborted ? 'timeout' : 'network-error');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
