import { evaluateTracking } from '../../src/domain/evaluateTracking.ts';
import { getRtdbMode, isLoopback, readTracking, validateTarget } from './firebaseRtdb.ts';
import type { AuthenticationProvider, HttpFetch } from './firebaseRtdb.ts';
import { toTrackingObservation } from './toTrackingObservation.ts';
import { keyForTarget, loadTrackingState, MemoryError, saveTrackingCheck } from './trackingStore.ts';
import type { CheckSummary } from './trackingStore.ts';
import { handlePulsoRead } from './pulsoRead.ts';
import type { AdminAuthorizationEnv } from './adminAuthorization.ts';

export interface Env extends AdminAuthorizationEnv {
  PULSO_LOCAL_ONLY?: string;
  PULSO_MEMORY?: string;
  PULSO_DB?: D1Database;
  RTDB_MODE?: string;
  RTDB_ORIGIN?: string;
  RTDB_NAMESPACE?: string;
  BUS_ID?: string;
  FIREBASE_ID_TOKEN?: string;
  PUBLICATION_STALE_AFTER_MS?: string;
  RECOVERY_CONFIRMATIONS_REQUIRED?: string;
  MAX_FUTURE_SKEW_MS?: string;
  READ_TIMEOUT_MS?: string;
}

interface Dependencies {
  auth?: AuthenticationProvider;
  fetchImpl?: HttpFetch;
  now?: () => number;
}

interface TrackingDiagnostic extends CheckSummary {
  evaluatedAt: number;
  mode?: 'operative-public';
  busId: string;
  continuity: 'not-persisted' | 'persisted';
  authentication: 'public-no-token' | 'temporary-id-token';
  memory?: Awaited<ReturnType<typeof saveTrackingCheck>>;
}

function integer(value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('Invalid local numeric configuration');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('Invalid local numeric configuration');
  return parsed;
}

export async function readAndEvaluate(env: Env, dependencies: Dependencies = {}): Promise<TrackingDiagnostic> {
  if (env.PULSO_LOCAL_ONLY !== 'true') throw new Error('Invalid local execution mode');
  const mode = getRtdbMode(env.RTDB_MODE);
  const target = { mode, origin: env.RTDB_ORIGIN ?? '', namespace: env.RTDB_NAMESPACE ?? '', busId: env.BUS_ID ?? '' };
  validateTarget(target);
  const config = {
    publicationStaleAfterMs: integer(env.PUBLICATION_STALE_AFTER_MS, 0),
    recoveryConfirmationsRequired: integer(env.RECOVERY_CONFIRMATIONS_REQUIRED, 1),
    maxFutureSkewMs: integer(env.MAX_FUTURE_SKEW_MS, 0),
  };
  const timeout = integer(env.READ_TIMEOUT_MS, 1, 30_000);
  const memoryMode = env.PULSO_MEMORY ?? 'off';
  if (memoryMode !== 'off' && memoryMode !== 'd1-local') throw new Error('Invalid local memory mode');
  const database = memoryMode === 'd1-local' ? env.PULSO_DB : undefined;
  if (memoryMode === 'd1-local' && !database) throw new MemoryError('memory-unavailable');
  const key = keyForTarget(target);
  // Tomar la revisión ANTES del HTTP: una comprobación lenta no debe pisar otra aceptada.
  const previous = database ? await loadTrackingState(database, key, config) : null;
  const auth = dependencies.auth ?? { getIdToken: async () => env.FIREBASE_ID_TOKEN ?? null };
  const source = await readTracking(target, auth, timeout, dependencies.fetchImpl);
  const evaluatedAt = (dependencies.now ?? Date.now)();
  const adapted = toTrackingObservation(source.status === 'unavailable' ? null : source.data, evaluatedAt);
  const observation = source.status === 'unavailable'
    ? { ...adapted.observation, sourceAccess: 'unavailable' as const }
    : adapted.observation;
  const evaluation = evaluateTracking({ observation, previous: previous?.prior ?? null, config });
  // Proyección deliberada: no devolver payloads, coordenadas precisas, tokens ni errores sin filtrar.
  const diagnostic = {
    evaluatedAt, ...(mode === 'operative-public' ? { mode } : {}),
    busId: target.busId, continuity: 'not-persisted' as const,
    authentication: mode === 'operative-public' ? 'public-no-token' as const : 'temporary-id-token' as const,
    source: { status: source.status, ...(source.error ? { error: source.error } : {}), ...(source.httpStatus === undefined ? {} : { httpStatus: source.httpStatus }) },
    input: {
      isActive: observation.current.isActive ?? null,
      publicationTimestamp: observation.current.timestamp ?? null,
      presentFields: adapted.presentFields, missingFields: adapted.missingFields, invalidFields: adapted.invalidFields,
    },
    evaluation: {
      classification: evaluation.classification, publication: evaluation.publication,
      gpsMeasurement: evaluation.gpsMeasurement, coordinates: evaluation.coordinates,
      finalization: evaluation.finalization, reasons: evaluation.reasons,
      recoveryState: evaluation.recoveryState, recoveryValidObservations: evaluation.recoveryValidObservations,
    },
  };
  if (!database) return diagnostic;
  const memory = await saveTrackingCheck(database, key, previous, evaluatedAt, config, evaluation, {
    source: diagnostic.source, input: diagnostic.input, evaluation: diagnostic.evaluation,
  });
  return { ...diagnostic, continuity: 'persisted' as const, memory };
}

export async function runScheduledCheck(env: Env, dependencies: Dependencies = {}): Promise<TrackingDiagnostic> {
  // Esta etapa programa únicamente el simulador local; el destino operativo sigue siendo manual.
  if (getRtdbMode(env.RTDB_MODE) === 'operative-public') throw new Error('operative-manual-only');
  // Sin memoria no se pueden conservar vigilancia, recuperación ni incidentes entre minutos.
  if (env.PULSO_MEMORY !== 'd1-local') throw new MemoryError('memory-unavailable');
  return readAndEvaluate(env, dependencies);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/pulso') {
      const result = await handlePulsoRead(request, env);
      return json(result.body, result.status);
    }
    if (env.PULSO_LOCAL_ONLY !== 'true' || url.protocol !== 'http:' || !isLoopback(url.hostname) ||
      request.headers.get('X-Pulso-Local') !== '1' ||
      (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: 'local-only' }, 403);
    if (url.pathname !== '/evaluate') return json({ error: 'not-found' }, 404);
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
    if (url.search) return json({ error: 'query-not-allowed' }, 400);
    try {
      const result = await readAndEvaluate(env);
      return json(result, result.source.status === 'unavailable' ? 503 : 200);
    } catch (error) {
      if (error instanceof MemoryError) return json({ error: error.code }, error.code === 'memory-conflict' ? 409 : 503);
      return json({ error: 'invalid-local-configuration' }, 400);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      console.log(JSON.stringify(await runScheduledCheck(env)));
    } catch (error) {
      const code = error instanceof MemoryError ? error.code :
        error instanceof Error && error.message === 'operative-manual-only' ? 'operative-manual-only' : 'invalid-local-configuration';
      console.error(JSON.stringify({ error: code }));
      // Distinguir una ejecución fallida de una caída de fuente guardada correctamente.
      throw new Error(code);
    }
  },
};
