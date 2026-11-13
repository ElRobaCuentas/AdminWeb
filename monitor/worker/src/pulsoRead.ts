import { PulsoApiError, requireAdministrator } from './adminAuthorization.ts';
import type { AdminAuthorizationEnv } from './adminAuthorization.ts';
import { getRtdbMode, isLoopback, validateTarget } from './firebaseRtdb.ts';
import type { HttpFetch } from './firebaseRtdb.ts';
import { keyForTarget } from './trackingStore.ts';

export interface PulsoReadEnv extends AdminAuthorizationEnv {
  PULSO_LOCAL_ONLY?: string;
  PULSO_MEMORY?: string;
  PULSO_DB?: D1Database;
  RTDB_MODE?: string;
  RTDB_ORIGIN?: string;
  RTDB_NAMESPACE?: string;
  BUS_ID?: string;
  PUBLICATION_STALE_AFTER_MS?: string;
}

const classifications = ['source-unavailable', 'insufficient-data', 'active-publishing', 'active-publication-stale',
  'inactive-finalized', 'inactive-unconfirmed', 'recovering-pending', 'recovering-confirmed'];
const kinds = ['tracking-interrupted', 'source-unavailable'];
const closeReasons = ['publications-recovered', 'tracking-inactive', 'source-accessible'];
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function incident(row: Record<string, unknown>) {
  if (typeof row.incident_id !== 'string' || !kinds.includes(String(row.kind)) ||
    !timestamp(row.opened_at) || !timestamp(row.updated_at) || row.updated_at < row.opened_at ||
    (row.closed_at === null ? row.close_reason !== null || row.duration_ms !== null :
      !timestamp(row.closed_at) || row.closed_at < row.opened_at || !closeReasons.includes(String(row.close_reason)) ||
      row.duration_ms !== row.closed_at - row.opened_at)) throw new Error();
  return {
    id: row.incident_id, kind: row.kind, openedAt: row.opened_at, updatedAt: row.updated_at,
    closedAt: row.closed_at, closeReason: row.close_reason, durationMs: row.duration_ms,
  };
}

async function readPersisted(env: PulsoReadEnv, now: number) {
  const target = { mode: getRtdbMode(env.RTDB_MODE), origin: env.RTDB_ORIGIN ?? '',
    namespace: env.RTDB_NAMESPACE ?? '', busId: env.BUS_ID ?? '' };
  try { validateTarget(target); } catch { throw new PulsoApiError('read-not-configured', 503); }
  const staleAfterMs = Number(env.PUBLICATION_STALE_AFTER_MS);
  if (env.PULSO_MEMORY !== 'd1-local' || !env.PULSO_DB || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new PulsoApiError('read-not-configured', 503);
  }
  const key = keyForTarget(target);
  const db = env.PULSO_DB;
  const columns = 'incident_id, kind, opened_at, updated_at, closed_at, close_reason, duration_ms';
  try {
    // Solo SELECT en un batch: estado, observación e incidentes de la misma lectura transaccional.
    const results = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT s.last_classification, s.evaluated_at, s.monitoring_active,
        o.check_id, o.evaluated_at AS observation_at, o.source_status, o.declared_active, o.publication_timestamp
        FROM tracking_state s LEFT JOIN tracking_observations o ON o.check_id = s.last_check_id
          AND o.source_key = s.source_key AND o.bus_id = s.bus_id
        WHERE s.source_key = ? AND s.bus_id = ?`).bind(key.sourceKey, key.busId),
      db.prepare(`SELECT ${columns} FROM tracking_incidents WHERE source_key = ? AND bus_id = ? AND closed_at IS NULL
        ORDER BY opened_at DESC, incident_id DESC`).bind(key.sourceKey, key.busId),
      db.prepare(`SELECT ${columns} FROM tracking_incidents WHERE source_key = ? AND bus_id = ?
        ORDER BY opened_at DESC, incident_id DESC LIMIT 20`).bind(key.sourceKey, key.busId),
    ]);
    if (results.some(result => !result.success)) throw new Error();
    const row = results[0].results[0];
    const activeIncidents = results[1].results.map(incident);
    const recentIncidents = results[2].results.map(incident);
    if (!row) {
      if (activeIncidents.length || recentIncidents.length) throw new Error();
      return { status: 'no-data', busId: target.busId, observedState: null, lastCheck: null, activeIncidents, recentIncidents };
    }
    if (!classifications.includes(String(row.last_classification)) || !timestamp(row.evaluated_at) ||
      row.observation_at !== row.evaluated_at || typeof row.check_id !== 'string' ||
      (row.monitoring_active !== 0 && row.monitoring_active !== 1) ||
      !['ok', 'missing', 'unavailable'].includes(String(row.source_status)) ||
      (row.declared_active !== null && row.declared_active !== 0 && row.declared_active !== 1) ||
      (row.publication_timestamp !== null && (typeof row.publication_timestamp !== 'number' || !Number.isFinite(row.publication_timestamp)))) throw new Error();
    const ageMs = Math.max(0, now - row.evaluated_at);
    return {
      status: 'observed', busId: target.busId,
      observedState: {
        classification: row.last_classification, monitoringActive: row.monitoring_active === 1,
        declaredActive: row.declared_active === null ? null : row.declared_active === 1,
        publicationTimestamp: timestamp(row.publication_timestamp) ? row.publication_timestamp : null,
      },
      // La antigüedad es de la comprobación guardada; no se vuelve a evaluar el tracking.
      lastCheck: { evaluatedAt: row.evaluated_at, sourceStatus: row.source_status, ageMs,
        freshness: ageMs > staleAfterMs ? 'old' : 'recent', staleAfterMs },
      activeIncidents, recentIncidents,
    };
  } catch { throw new PulsoApiError('read-failed', 503); }
}

export async function handlePulsoRead(
  request: Request, env: PulsoReadEnv, dependencies: { fetchImpl?: HttpFetch; now?: () => number } = {},
): Promise<{ body: unknown; status: number }> {
  const url = new URL(request.url);
  if (env.PULSO_LOCAL_ONLY !== 'true' || url.protocol !== 'http:' || !isLoopback(url.hostname) ||
    (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site') return { body: { error: 'local-only' }, status: 403 };
  if (request.method !== 'GET') return { body: { error: 'method-not-allowed' }, status: 405 };
  if (url.search) return { body: { error: 'query-not-allowed' }, status: 400 };
  try {
    await requireAdministrator(request, env, dependencies.fetchImpl, (dependencies.now ?? Date.now)());
    return { body: await readPersisted(env, (dependencies.now ?? Date.now)()), status: 200 };
  } catch (error) {
    return { body: { error: error instanceof PulsoApiError ? error.message : 'read-not-configured' },
      status: error instanceof PulsoApiError ? error.status : 503 };
  }
}
