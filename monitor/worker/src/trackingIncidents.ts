import type { TrackingEvaluation } from '../../src/domain/evaluateTracking.ts';
import type { CheckSummary } from './trackingStore.ts';

// Se ejecuta en el mismo batch que el snapshot y el historial. El token del CAS
// evita que una comprobación perdedora toque incidentes, incluso después de la poda.
export function incidentStatements(
  db: D1Database, sourceKey: string, busId: string, checkId: string, evaluatedAt: number,
  monitoringActive: boolean, evaluation: TrackingEvaluation, summary: CheckSummary,
): D1PreparedStatement[] {
  const sourceAvailable = summary.source.status !== 'unavailable';
  const inactive = sourceAvailable && summary.input.isActive === false;
  const transitions = [
    {
      kind: 'tracking-interrupted',
      open: monitoringActive && evaluation.classification === 'active-publication-stale',
      close: inactive ? 'tracking-inactive' :
        sourceAvailable && evaluation.recoveryState === 'confirmed' ? 'publications-recovered' : null,
    },
    {
      kind: 'source-unavailable',
      open: monitoringActive && !sourceAvailable,
      close: sourceAvailable ? 'source-accessible' : null,
    },
  ];
  const accepted = `EXISTS (SELECT 1 FROM tracking_state
    WHERE source_key = ? AND bus_id = ? AND last_check_id = ?)`;
  return transitions.flatMap(({ kind, open, close }) => [
    db.prepare(`UPDATE tracking_incidents SET updated_at = ?, last_check_id = ?, check_count = check_count + 1,
        closed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE NULL END, close_reason = ?,
        duration_ms = CASE WHEN ? IS NOT NULL THEN ? - opened_at ELSE NULL END
      WHERE source_key = ? AND bus_id = ? AND kind = ? AND closed_at IS NULL AND ${accepted}`)
      .bind(evaluatedAt, checkId, close, evaluatedAt, close, close, evaluatedAt,
        sourceKey, busId, kind, sourceKey, busId, checkId),
    db.prepare(`INSERT INTO tracking_incidents
        (incident_id, source_key, bus_id, kind, opened_at, updated_at, check_count, last_check_id)
      SELECT ?, ?, ?, ?, ?, ?, 1, ? WHERE ? = 1 AND ${accepted}
        AND NOT EXISTS (SELECT 1 FROM tracking_incidents
          WHERE source_key = ? AND bus_id = ? AND kind = ? AND closed_at IS NULL)`)
      .bind(crypto.randomUUID(), sourceKey, busId, kind, evaluatedAt, evaluatedAt, checkId, Number(open),
        sourceKey, busId, checkId, sourceKey, busId, kind),
  ]);
}
