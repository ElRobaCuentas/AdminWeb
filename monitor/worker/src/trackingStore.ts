import type { PriorTrackingState, TrackingEvaluation, TrackingEvaluationConfig } from '../../src/domain/evaluateTracking.ts';
import type { ReadResult, RtdbTarget } from './firebaseRtdb.ts';

type MemoryErrorCode = 'memory-unavailable' | 'memory-read-failed' | 'memory-write-failed' |
  'memory-state-invalid' | 'memory-state-incompatible' | 'memory-conflict';
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode) { super(code); this.name = 'MemoryError'; this.code = code; }
}

interface TrackingKey { sourceKey: string; busId: string }
export interface TrackingSnapshot {
  revision: number;
  lastCheckId: string;
  evaluatedAt: number;
  lastFreshSeenAt: number | null;
  prior: PriorTrackingState;
}
export interface CheckSummary {
  source: Pick<ReadResult, 'status' | 'error' | 'httpStatus'>;
  input: {
    isActive: boolean | null; publicationTimestamp: number | null;
    presentFields: readonly string[]; missingFields: readonly string[]; invalidFields: readonly string[];
  };
  evaluation: Pick<TrackingEvaluation, 'classification' | 'publication' | 'gpsMeasurement' | 'coordinates' |
    'finalization' | 'reasons' | 'recoveryState' | 'recoveryValidObservations'>;
}

const STATE_VERSION = 1;
const RETENTION_MS = 7 * 86_400_000;
const priorKeys = [
  'tripSessionId', 'publicationInterrupted', 'interruptionFirstObservedAt', 'recoveryState',
  'recoveryValidObservations', 'lastRecoveryPublicationTimestamp', 'lastGpsFixId',
  'lastGpsFixTimestamp', 'lastLatitude', 'lastLongitude',
] as const;

export function keyForTarget(target: RtdbTarget): TrackingKey {
  return { sourceKey: JSON.stringify([target.mode ?? 'local-authenticated', new URL(target.origin).origin, target.namespace]), busId: target.busId };
}
function configJson(config: TrackingEvaluationConfig): string {
  return JSON.stringify({
    publicationStaleAfterMs: config.publicationStaleAfterMs,
    recoveryConfirmationsRequired: config.recoveryConfirmationsRequired,
    maxFutureSkewMs: config.maxFutureSkewMs,
  });
}
function priorProjection(evaluation: TrackingEvaluation): PriorTrackingState {
  return {
    tripSessionId: evaluation.tripSessionId, publicationInterrupted: evaluation.publicationInterrupted,
    interruptionFirstObservedAt: evaluation.interruptionFirstObservedAt, recoveryState: evaluation.recoveryState,
    recoveryValidObservations: evaluation.recoveryValidObservations,
    lastRecoveryPublicationTimestamp: evaluation.lastRecoveryPublicationTimestamp,
    lastGpsFixId: evaluation.lastGpsFixId, lastGpsFixTimestamp: evaluation.lastGpsFixTimestamp,
    lastLatitude: evaluation.lastLatitude, lastLongitude: evaluation.lastLongitude,
  };
}
const nullableNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
const nullableTimestamp = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
const nullableId = (value: unknown) => value === null || (typeof value === 'string' && value.trim().length > 0);

function decodePrior(text: unknown): PriorTrackingState {
  if (typeof text !== 'string') throw new MemoryError('memory-state-invalid');
  const state = JSON.parse(text) as Record<string, unknown> | null;
  if (!state || Array.isArray(state) || Object.keys(state).length !== priorKeys.length ||
    !priorKeys.every(key => Object.hasOwn(state, key)) ||
    !nullableId(state.tripSessionId) || typeof state.publicationInterrupted !== 'boolean' ||
    !nullableTimestamp(state.interruptionFirstObservedAt) ||
    typeof state.recoveryState !== 'string' || !['none', 'pending', 'confirmed'].includes(state.recoveryState) ||
    !Number.isSafeInteger(state.recoveryValidObservations) || Number(state.recoveryValidObservations) < 0 ||
    !nullableTimestamp(state.lastRecoveryPublicationTimestamp) || !nullableId(state.lastGpsFixId) ||
    !nullableTimestamp(state.lastGpsFixTimestamp) || !nullableNumber(state.lastLatitude) || !nullableNumber(state.lastLongitude)) {
    throw new MemoryError('memory-state-invalid');
  }
  return state as unknown as PriorTrackingState;
}

export async function loadTrackingState(db: D1Database, key: TrackingKey, config: TrackingEvaluationConfig): Promise<TrackingSnapshot | null> {
  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare('SELECT * FROM tracking_state WHERE source_key = ? AND bus_id = ?').bind(key.sourceKey, key.busId).first();
  } catch { throw new MemoryError('memory-read-failed'); }
  if (row === null) return null;
  try {
    if (row.state_version !== STATE_VERSION || row.config_json !== configJson(config)) throw new MemoryError('memory-state-incompatible');
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 ||
      !Number.isSafeInteger(row.evaluated_at) || Number(row.evaluated_at) <= 0 ||
      !nullableTimestamp(row.last_fresh_seen_at) || typeof row.last_check_id !== 'string' || !row.last_check_id) {
      throw new MemoryError('memory-state-invalid');
    }
    return {
      revision: Number(row.revision), lastCheckId: row.last_check_id, evaluatedAt: Number(row.evaluated_at),
      lastFreshSeenAt: row.last_fresh_seen_at as number | null, prior: decodePrior(row.prior_state_json),
    };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('memory-state-invalid');
  }
}

export async function saveTrackingCheck(
  db: D1Database, key: TrackingKey, previous: TrackingSnapshot | null,
  evaluatedAt: number, config: TrackingEvaluationConfig, evaluation: TrackingEvaluation, summary: CheckSummary,
): Promise<{ revision: number; checkId: string; reusedPrevious: boolean }> {
  const revision = (previous?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(evaluatedAt) || evaluatedAt <= 0) throw new MemoryError('memory-state-invalid');
  const checkId = crypto.randomUUID();
  const effectiveConfig = configJson(config);
  const lastFresh = evaluation.publication.state === 'fresh' ? evaluatedAt : previous?.lastFreshSeenAt ?? null;
  const values = [key.sourceKey, key.busId, revision, checkId, evaluatedAt, lastFresh,
    STATE_VERSION, effectiveConfig, evaluation.classification, JSON.stringify(priorProjection(evaluation))];
  try {
    const stateWrite = previous === null
      ? db.prepare(`INSERT INTO tracking_state
          (source_key, bus_id, revision, last_check_id, evaluated_at, last_fresh_seen_at, state_version, config_json, last_classification, prior_state_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_key, bus_id) DO NOTHING`).bind(...values)
      : db.prepare(`UPDATE tracking_state SET revision = ?, last_check_id = ?, evaluated_at = ?, last_fresh_seen_at = ?,
          state_version = ?, config_json = ?, last_classification = ?, prior_state_json = ?
          WHERE source_key = ? AND bus_id = ? AND revision = ? AND last_check_id = ?
          AND state_version = ? AND config_json = ? AND evaluated_at <= ?`).bind(
          ...values.slice(2), key.sourceKey, key.busId, previous.revision, previous.lastCheckId,
          STATE_VERSION, effectiveConfig, evaluatedAt);
    // changes() corresponde a la sentencia anterior dentro de este batch transaccional.
    // Un CAS perdedor no puede insertar historial ni ejecutar la retención.
    const historyWrite = db.prepare(`INSERT INTO tracking_observations
        (check_id, source_key, bus_id, revision, evaluated_at, source_status, source_error, declared_active, publication_timestamp, summary_json, config_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 AND EXISTS (
          SELECT 1 FROM tracking_state WHERE source_key = ? AND bus_id = ? AND last_check_id = ? AND revision = ?)`)
      .bind(checkId, key.sourceKey, key.busId, revision, evaluatedAt, summary.source.status, summary.source.error ?? null,
        summary.input.isActive === null ? null : Number(summary.input.isActive), summary.input.publicationTimestamp,
        JSON.stringify(summary), effectiveConfig, key.sourceKey, key.busId, checkId, revision);
    const prune = db.prepare(`DELETE FROM tracking_observations WHERE changes() = 1 AND source_key = ? AND bus_id = ?
        AND evaluated_at < ? AND check_id <> ? AND EXISTS (
          SELECT 1 FROM tracking_state WHERE source_key = ? AND bus_id = ? AND last_check_id = ? AND revision = ?)`)
      .bind(key.sourceKey, key.busId, evaluatedAt - RETENTION_MS, checkId, key.sourceKey, key.busId, checkId, revision);
    const results = await db.batch([stateWrite, historyWrite, prune]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new MemoryError('memory-conflict');
    return { revision, checkId, reusedPrevious: previous !== null };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    // No exponer SQL, parámetros ni mensajes originales del motor.
    throw new MemoryError('memory-write-failed');
  }
}
