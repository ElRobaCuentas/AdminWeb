export const classifications = ['source-unavailable', 'insufficient-data', 'active-publishing',
  'active-publication-stale', 'inactive-finalized', 'inactive-unconfirmed',
  'recovering-pending', 'recovering-confirmed'] as const;
export type Classification = typeof classifications[number];
export type IncidentKind = 'tracking-interrupted' | 'source-unavailable';
export type CloseReason = 'publications-recovered' | 'tracking-inactive' | 'source-accessible';
export interface Incident {
  id: string;
  kind: IncidentKind;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: CloseReason | null;
  durationMs: number | null;
}
export interface PulsoData {
  status: 'no-data' | 'observed';
  busId: string;
  observedState: null | {
    classification: Classification;
    monitoringActive: boolean;
    declaredActive: boolean | null;
    publicationTimestamp: number | null;
  };
  lastCheck: null | {
    evaluatedAt: number;
    sourceStatus: 'ok' | 'missing' | 'unavailable';
    ageMs: number;
    freshness: 'recent' | 'old';
    staleAfterMs: number;
  };
  activeIncidents: Incident[];
  recentIncidents: Incident[];
}
export class PulsoQueryError extends Error {
  readonly denied: boolean;
  constructor(denied = false) {
    super(denied ? 'La sesión no tiene acceso a PULSO. Verifica tu sesión y el permiso de administrador.' :
      'No se pudo consultar PULSO. Verifica la conexión y la configuración del Worker e intenta actualizar.');
    this.denied = denied;
  }
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const duration = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function validIncident(v: unknown): v is Incident {
  return record(v) && typeof v.id === 'string' && v.id.length > 0 &&
    ['tracking-interrupted', 'source-unavailable'].includes(String(v.kind)) &&
    time(v.openedAt) && time(v.updatedAt) && v.updatedAt >= v.openedAt &&
    (v.closedAt === null ? v.closeReason === null && v.durationMs === null :
      time(v.closedAt) && v.closedAt >= v.openedAt && v.durationMs === v.closedAt - v.openedAt &&
      ['publications-recovered', 'tracking-inactive', 'source-accessible'].includes(String(v.closeReason)));
}

// Una respuesta HTML del proxy o un contrato incompleto nunca significan D1 vacía.
export function parsePulsoData(value: unknown): PulsoData {
  if (!record(value) || typeof value.busId !== 'string' || !value.busId ||
    !Array.isArray(value.activeIncidents) || !value.activeIncidents.every(validIncident) ||
    value.activeIncidents.some(v => v.closedAt !== null) ||
    !Array.isArray(value.recentIncidents) || value.recentIncidents.length > 20 ||
    !value.recentIncidents.every(validIncident)) throw new PulsoQueryError();
  if (value.status === 'no-data') {
    if (value.observedState !== null || value.lastCheck !== null || value.activeIncidents.length ||
      value.recentIncidents.length) throw new PulsoQueryError();
  } else {
    const state = value.observedState;
    const check = value.lastCheck;
    if (value.status !== 'observed' || !record(state) || !record(check) ||
      !classifications.includes(state.classification as Classification) || typeof state.monitoringActive !== 'boolean' ||
      !(state.declaredActive === null || typeof state.declaredActive === 'boolean') ||
      !(state.publicationTimestamp === null || time(state.publicationTimestamp)) ||
      !time(check.evaluatedAt) || !duration(check.ageMs) || !time(check.staleAfterMs) ||
      !['recent', 'old'].includes(String(check.freshness)) ||
      !['ok', 'missing', 'unavailable'].includes(String(check.sourceStatus))) throw new PulsoQueryError();
  }
  return value as unknown as PulsoData;
}

export async function getPulso(
  getToken: () => Promise<string | null>, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<PulsoData> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let onAbort: () => void = () => {};
  try {
    bounded.throwIfAborted();
    return await Promise.race([
      (async () => {
        const token = await getToken();
        bounded.throwIfAborted();
        if (!token) throw new PulsoQueryError(true);
        const response = await fetchImpl('/api/pulso', {
          method: 'GET', headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store', redirect: 'error', signal: bounded,
        });
        if (response.status === 401 || response.status === 403) throw new PulsoQueryError(true);
        if (!response.ok) throw new PulsoQueryError();
        return parsePulsoData(await response.json());
      })(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new PulsoQueryError());
        bounded.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    throw error instanceof PulsoQueryError ? error : new PulsoQueryError();
  } finally { bounded.removeEventListener('abort', onAbort); }
}
