import type { Classification, CloseReason, IncidentKind, PulsoData } from './services/pulso_service.ts';

export const stateLabels: Record<Classification, { label: string; tone: 'warning' | 'success' | 'neutral' | 'info' }> = {
  'source-unavailable': { label: 'Fuente inaccesible', tone: 'warning' },
  'insufficient-data': { label: 'Información insuficiente', tone: 'neutral' },
  'active-publishing': { label: 'Recorrido activo · Publicación reciente', tone: 'success' },
  'active-publication-stale': { label: 'Recorrido activo · Publicación interrumpida', tone: 'warning' },
  'inactive-finalized': { label: 'Recorrido finalizado con evidencia', tone: 'neutral' },
  'inactive-unconfirmed': { label: 'Recorrido inactivo · Finalización no confirmada', tone: 'neutral' },
  'recovering-pending': { label: 'Recuperación pendiente de confirmación', tone: 'warning' },
  'recovering-confirmed': { label: 'Recuperación confirmada', tone: 'success' },
};
export const incidentLabels: Record<IncidentKind, string> = {
  'tracking-interrupted': 'Seguimiento interrumpido', 'source-unavailable': 'Fuente inaccesible',
};
export const closeLabels: Record<CloseReason, string> = {
  'publications-recovered': 'Publicaciones recuperadas', 'tracking-inactive': 'Recorrido declarado inactivo',
  'source-accessible': 'Fuente accesible de nuevo',
};

export const tripLabels: Record<Classification, { label: string; description: string }> = {
  'active-publishing': { label: 'Seguimiento funcionando', description: 'El bus está publicando ubicaciones recientes.' },
  'active-publication-stale': { label: 'Seguimiento interrumpido', description: 'El recorrido sigue declarado activo, pero no llegan ubicaciones recientes.' },
  'recovering-pending': { label: 'Seguimiento en recuperación', description: 'Volvieron las publicaciones. PULSO espera confirmar la recuperación.' },
  'recovering-confirmed': { label: 'Recuperación confirmada', description: 'El bus volvió a publicar ubicaciones recientes y el recorrido continúa activo.' },
  'inactive-unconfirmed': { label: 'Bus fuera de recorrido', description: 'No se esperan nuevas ubicaciones.' },
  'inactive-finalized': { label: 'Bus fuera de recorrido', description: 'No se esperan nuevas ubicaciones.' },
  'source-unavailable': { label: 'Estado del recorrido sin confirmar', description: 'PULSO no pudo consultar Firebase en la última revisión.' },
  'insufficient-data': { label: 'Información del recorrido incompleta', description: 'Los datos recibidos no permiten confirmar el estado del seguimiento.' },
};

export function monitorPresentation(check: NonNullable<PulsoData['lastCheck']>, old: boolean, queryFailed: boolean) {
  const connection = { ok: 'Consulta completada', missing: 'Consulta completada, sin datos del bus', unavailable: 'No se pudo consultar' }[check.sourceStatus];
  if (old) return { label: 'Sin revisión reciente', tone: 'warning' as const, connection };
  if (queryFailed) return { label: 'Última revisión guardada', tone: 'warning' as const, connection };
  if (check.sourceStatus === 'unavailable') return { label: 'Revisión con fallo de conexión', tone: 'warning' as const, connection };
  if (check.sourceStatus === 'missing') return { label: 'Revisión sin datos del bus', tone: 'warning' as const, connection };
  return { label: 'Revisión reciente', tone: 'success' as const, connection };
}
export function formatMoment(at: number | null): string {
  if (at === null) return 'Sin información';
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Lima' }).format(at);
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
// Solo envejece la comprobación recibida; nunca reclasifica el seguimiento.
export function checkAge(check: NonNullable<PulsoData['lastCheck']>, receivedAt: number, now: number) {
  const ageMs = check.ageMs + Math.max(0, now - receivedAt);
  return { ageMs, old: check.freshness === 'old' || ageMs > check.staleAfterMs };
}

export function observedTripDetails(data: PulsoData, receivedAt: number, now: number, queryFailed: boolean) {
  const state = data.observedState;
  const check = data.lastCheck;
  if (!state || !check) return null;
  if (!state.monitoringActive) return { start: 'No aplica', elapsed: 'No aplica' };
  const start = state.observedTripStartedAt;
  if (start == null) return { start: 'Sin información disponible', elapsed: 'No calculable' };
  const age = checkAge(check, receivedAt, now);
  const savedOnly = queryFailed || age.old || check.sourceStatus !== 'ok' || state.declaredActive !== true;
  // El reloj del servidor ancla la estimación; un dato incierto se limita a la comprobación guardada.
  const until = check.evaluatedAt + (savedOnly ? 0 : age.ageMs);
  const minutes = Math.floor(Math.max(0, until - start) / 60_000);
  const elapsed = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return { start: formatMoment(start), elapsed: `${elapsed}${savedOnly ? ' (hasta la última comprobación guardada)' : ''}` };
}
