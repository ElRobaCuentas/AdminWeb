export interface RtdbTarget {
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

export function validateTarget(target: RtdbTarget): void {
  try {
    const url = new URL(target.origin);
    if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^demo-[a-z0-9-]{1,60}$/.test(target.namespace) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.busId)) throw new Error();
  } catch {
    throw new Error('Invalid local RTDB configuration');
  }
}

const MAX_RESPONSE_BYTES = 16_384;

async function readBody(response: Response): Promise<string | null> {
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
    let token: string | null;
    try {
      token = await authentication.getIdToken(controller.signal);
    } catch {
      return unavailable('authentication-unavailable');
    }
    if (!token || token === 'owner' || /\s/.test(token)) return unavailable('authentication-unavailable');
    controller.signal.throwIfAborted();
    const url = new URL(`/ubicacion_buses/${target.busId}.json`, target.origin);
    url.searchParams.set('ns', target.namespace);
    url.searchParams.set('auth', token);
    // Nunca registrar esta URL: Firebase REST transporta el ID token en el query.
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
