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
