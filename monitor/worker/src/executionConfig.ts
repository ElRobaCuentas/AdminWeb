import { authorizationTarget } from './adminAuthorization.ts';
import type { AdminAuthorizationEnv } from './adminAuthorization.ts';
import { isLoopback, validateTarget } from './firebaseRtdb.ts';

export interface ExecutionEnv extends AdminAuthorizationEnv {
  PULSO_EXECUTION?: string;
  PULSO_LOCAL_ONLY?: string;
  PULSO_SCHEDULE_ENABLED?: string;
  PULSO_CENTRAL_ORIGIN?: string;
  PULSO_MEMORY?: string;
  PULSO_DB?: D1Database;
  RTDB_MODE?: string;
  RTDB_ORIGIN?: string;
  RTDB_NAMESPACE?: string;
  BUS_ID?: string;
  PUBLICATION_STALE_AFTER_MS?: string;
  RECOVERY_CONFIRMATIONS_REQUIRED?: string;
  MAX_FUTURE_SKEW_MS?: string;
  READ_TIMEOUT_MS?: string;
}

export class ExecutionError extends Error {
  constructor(code: 'invalid-execution-configuration' | 'schedule-disabled') { super(code); }
}

export function executionMode(env: ExecutionEnv): 'local' | 'cloudflare' {
  if (env.PULSO_EXECUTION === undefined || env.PULSO_EXECUTION === 'local') return 'local';
  if (env.PULSO_EXECUTION === 'cloudflare') return 'cloudflare';
  throw new ExecutionError('invalid-execution-configuration');
}

export function centralOrigin(env: ExecutionEnv): string {
  try {
    const url = new URL(env.PULSO_CENTRAL_ORIGIN ?? '');
    if (url.protocol !== 'https:' || isLoopback(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new ExecutionError('invalid-execution-configuration'); }
}

// La configuración remota debe ser completa antes de acceder a Firebase o D1.
// Los modos locales existentes no cambian ni adquieren permisos remotos.
export function validateRemoteConfiguration(env: ExecutionEnv): void {
  try {
    if (executionMode(env) !== 'cloudflare' || env.PULSO_LOCAL_ONLY !== 'false' ||
      env.RTDB_MODE !== 'operative-public' || env.PULSO_MEMORY !== 'd1' || !env.PULSO_DB ||
      !['true', 'false'].includes(env.PULSO_SCHEDULE_ENABLED ?? '') ||
      env.PUBLICATION_STALE_AFTER_MS !== '180000' || env.RECOVERY_CONFIRMATIONS_REQUIRED !== '2' ||
      env.MAX_FUTURE_SKEW_MS !== '5000' || !/^\d+$/.test(env.READ_TIMEOUT_MS ?? '') ||
      Number(env.READ_TIMEOUT_MS) < 1 || Number(env.READ_TIMEOUT_MS) > 30_000) throw new Error();
    validateTarget({ mode: 'operative-public', origin: env.RTDB_ORIGIN ?? '',
      namespace: env.RTDB_NAMESPACE ?? '', busId: env.BUS_ID ?? '' });
    if (authorizationTarget(env).local) throw new Error();
    centralOrigin(env);
  } catch { throw new ExecutionError('invalid-execution-configuration'); }
}
