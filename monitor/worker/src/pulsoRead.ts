import { PulsoApiError, requireAdministrator } from './adminAuthorization.ts';
import { getRtdbMode, isLoopback, validateTarget } from './firebaseRtdb.ts';
import type { HttpFetch } from './firebaseRtdb.ts';
import { keyForTarget } from './trackingStore.ts';
import { centralOrigin, executionMode, validateRemoteConfiguration } from './executionConfig.ts';
import type { ExecutionEnv } from './executionConfig.ts';

export type PulsoReadEnv = ExecutionEnv;

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
  const memoryMode = executionMode(env) === 'cloudflare' ? 'd1' : 'd1-local';
  if (env.PULSO_MEMORY !== memoryMode || !env.PULSO_DB || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new PulsoApiError('read-not-configured', 503);
  }
  const key = keyForTarget(target);
  const db = env.PULSO_DB;
  const columns = 'incident_id, kind, opened_at, updated_at, closed_at, close_reason, duration_ms';
  try {
    // Solo SELECT en un batch: estado, observación e incidentes de la misma lectura transaccional.
    const results = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT s.last_classification, s.evaluated_at, s.monitoring_active, s.observed_trip_started_at,
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
      !(row.observed_trip_started_at === null || (timestamp(row.observed_trip_started_at) && row.observed_trip_started_at <= row.evaluated_at)) ||
      (row.monitoring_active === 0 && row.observed_trip_started_at !== null) ||
      !['ok', 'missing', 'unavailable'].includes(String(row.source_status)) ||
      (row.declared_active !== null && row.declared_active !== 0 && row.declared_active !== 1) ||
      (row.publication_timestamp !== null && (typeof row.publication_timestamp !== 'number' || !Number.isFinite(row.publication_timestamp)))) throw new Error();
    const ageMs = Math.max(0, now - row.evaluated_at);
    return {
      status: 'observed', busId: target.busId,
      observedState: {
        classification: row.last_classification, monitoringActive: row.monitoring_active === 1,
        observedTripStartedAt: row.observed_trip_started_at,
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
): Promise<{ body: unknown; status: number; headers?: Record<string, string> }> {
  const url = new URL(request.url);
  let headers: Record<string, string> | undefined;
  const result = (body: unknown, status: number) => ({ body, status, ...(headers ? { headers } : {}) });
  try {
    if (executionMode(env) === 'cloudflare') {
      const allowed = centralOrigin(env);
      const origin = request.headers.get('Origin');
      if (url.protocol !== 'https:' || isLoopback(url.hostname)) return result({ error: 'remote-only' }, 403);
      if (origin !== null && origin !== allowed) return result({ error: 'access-denied' }, 403);
      if (origin === allowed) headers = { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' };
      validateRemoteConfiguration(env);
      if (url.search) return result({ error: 'query-not-allowed' }, 400);
      if (request.method === 'OPTIONS') {
        if (origin !== allowed || request.headers.get('Access-Control-Request-Method') !== 'GET' ||
          request.headers.get('Access-Control-Request-Headers')?.trim().toLowerCase() !== 'authorization') {
          return result({ error: 'access-denied' }, 403);
        }
        return { body: null, status: 204, headers: { ...headers,
          'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization' } };
      }
    } else if (env.PULSO_LOCAL_ONLY !== 'true' || url.protocol !== 'http:' || !isLoopback(url.hostname) ||
      (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site') return result({ error: 'local-only' }, 403);
    if (request.method !== 'GET') return result({ error: 'method-not-allowed' }, 405);
    if (url.search) return result({ error: 'query-not-allowed' }, 400);
    await requireAdministrator(request, env, dependencies.fetchImpl, (dependencies.now ?? Date.now)());
    return result(await readPersisted(env, (dependencies.now ?? Date.now)()), 200);
  } catch (error) {
    return result({ error: error instanceof PulsoApiError ? error.message : 'read-not-configured' },
      error instanceof PulsoApiError ? error.status : 503);
  }
}
