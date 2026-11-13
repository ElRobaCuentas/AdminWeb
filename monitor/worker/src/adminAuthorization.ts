import { isLoopback, readBody } from './firebaseRtdb.ts';
import type { HttpFetch } from './firebaseRtdb.ts';

export interface AdminAuthorizationEnv {
  PULSO_ADMIN_PROJECT_ID?: string;
  PULSO_ADMIN_RTDB_ORIGIN?: string;
  PULSO_ADMIN_RTDB_NAMESPACE?: string;
}

export class PulsoApiError extends Error {
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}

function authorizationTarget(env: AdminAuthorizationEnv): { origin: string; namespace: string; project: string; local: boolean } {
  const project = env.PULSO_ADMIN_PROJECT_ID ?? '';
  const namespace = env.PULSO_ADMIN_RTDB_NAMESPACE ?? '';
  try {
    const url = new URL(env.PULSO_ADMIN_RTDB_ORIGIN ?? '');
    const local = url.protocol === 'http:' && isLoopback(url.hostname) &&
      /^demo-[a-z0-9-]{1,60}$/.test(project) && namespace === project;
    const operative = url.origin === 'https://burritounmsm-default-rtdb.firebaseio.com' &&
      project === 'burritounmsm' && namespace === 'burritounmsm-default-rtdb';
    if ((!local && !operative) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return { origin: url.origin, namespace, project, local };
  } catch { throw new PulsoApiError('authorization-not-configured', 503); }
}

// Estos campos NO prueban identidad: solo acotan la solicitud. Firebase verifica
// el token completo y sus reglas comprueban el rol antes de conceder acceso.
function candidateUid(token: string, project: string, local: boolean, now: number): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0] + parts[1]) ||
      !/^[A-Za-z0-9_-]*$/.test(parts[2])) throw new Error();
    const decode = (part: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)),
    )) as Record<string, unknown>;
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    const seconds = Math.floor(now / 1000);
    if (!header || !claims || (local ? header.alg !== 'none' || parts[2] !== '' : header.alg !== 'RS256') ||
      (!local && (typeof header.kid !== 'string' || !header.kid || !parts[2])) ||
      claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}` ||
      !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= seconds ||
      !Number.isSafeInteger(claims.iat) || Number(claims.iat) > seconds ||
      !Number.isSafeInteger(claims.auth_time) || Number(claims.auth_time) > seconds ||
      typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 128 ||
      Array.from(claims.sub).some(character => '.#$[]/'.includes(character) ||
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error();
    return claims.sub;
  } catch { throw new PulsoApiError('invalid-token', 401); }
}

export async function requireAdministrator(
  request: Request, env: AdminAuthorizationEnv, fetchImpl: HttpFetch = fetch, now = Date.now(),
): Promise<void> {
  const authorization = request.headers.get('Authorization');
  if (!authorization) throw new PulsoApiError('authentication-required', 401);
  const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/i.exec(authorization);
  if (!match) throw new PulsoApiError('invalid-token', 401);
  const target = authorizationTarget(env);
  const uid = candidateUid(match[1], target.project, target.local, now);
  const url = new URL(`/administradores/${encodeURIComponent(uid)}.json`, target.origin);
  url.searchParams.set('ns', target.namespace);
  url.searchParams.set('auth', match[1]);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        // Nunca registrar esta URL: contiene el ID token de la sesión de Central.
        const response = await fetchImpl(url.href, {
          method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' },
        });
        if (controller.signal.aborted) throw new Error();
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new PulsoApiError('access-denied', 403);
        }
        if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error(); }
        const text = await readBody(response);
        if (text === null) throw new Error();
        const admin: unknown = JSON.parse(text);
        if (admin === null) throw new PulsoApiError('access-denied', 403);
        // Igual que existeAdministrador en Central: importa la existencia del nodo,
        // no una contraseña, un campo de perfil ni una nueva definición de rol.
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 5000);
      }),
    ]);
  } catch (error) {
    if (error instanceof PulsoApiError) throw error;
    throw new PulsoApiError('authorization-unavailable', 503);
  } finally { clearTimeout(timer); controller.abort(); }
}
