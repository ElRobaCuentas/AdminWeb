export interface Turno {
  inicio: number;
  fin: number;
}

interface AsignacionHorario {
  turnos?: unknown;
  horaInicio?: unknown;
  horaFin?: unknown;
}

export const formatCreatedAt = (ts: number) =>
  new Date(ts).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });

export const timeToMinutos = (hora: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hora.trim());
  if (!match) return null;
  const horas = Number(match[1]);
  const minutos = Number(match[2]);
  if (horas > 23 || minutos > 59) return null;
  return horas * 60 + minutos;
};

export const formatHora = (minutos?: number): string => {
  if (minutos === undefined || minutos === null || minutos < 0 || minutos > 1439) return '';
  const horas = Math.floor(minutos / 60);
  const mins = minutos % 60;
  return `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const esMinutoValido = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439;

const esTurnoValido = (value: unknown): value is Turno => {
  if (!value || typeof value !== 'object') return false;
  const turno = value as { inicio?: unknown; fin?: unknown };
  return esMinutoValido(turno.inicio)
    && esMinutoValido(turno.fin)
    && turno.inicio < turno.fin;
};

export const sortTurnos = (turnos: Turno[]): Turno[] =>
  [...turnos].sort((a, b) => a.inicio - b.inicio || a.fin - b.fin);

export const getTurnos = (asignacion: AsignacionHorario): Turno[] => {
  let rawTurnos: unknown[] = [];
  if (Array.isArray(asignacion.turnos)) {
    rawTurnos = asignacion.turnos;
  } else if (asignacion.turnos && typeof asignacion.turnos === 'object') {
    rawTurnos = Object.values(asignacion.turnos);
  }

  const turnos = rawTurnos.filter(esTurnoValido);
  if (turnos.length > 0) return sortTurnos(turnos);

  if (esMinutoValido(asignacion.horaInicio)
    && esMinutoValido(asignacion.horaFin)
    && asignacion.horaInicio < asignacion.horaFin) {
    return [{ inicio: asignacion.horaInicio, fin: asignacion.horaFin }];
  }

  return [];
};

export const validateTurnos = (turnos: Turno[]): string | null => {
  if (turnos.length === 0) return 'Agrega al menos un turno.';

  for (const turno of turnos) {
    if (!esMinutoValido(turno.inicio) || !esMinutoValido(turno.fin)) {
      return 'Ingresa un horario válido para cada turno.';
    }
    if (turno.inicio >= turno.fin) {
      return 'Cada turno debe tener inicio anterior a fin; no se permiten turnos que crucen medianoche.';
    }
  }

  const ordenados = sortTurnos(turnos);
  for (let i = 1; i < ordenados.length; i += 1) {
    if (ordenados[i].inicio < ordenados[i - 1].fin) {
      return 'Los turnos del mismo conductor no pueden superponerse.';
    }
  }

  return null;
};

export interface TurnoInput {
  inicio: string;
  fin: string;
}

export const parseTurnos = (
  drafts: TurnoInput[],
): { turnos: Turno[]; error: string | null } => {
  const turnos: Turno[] = [];
  for (const draft of drafts) {
    const inicio = timeToMinutos(draft.inicio);
    const fin = timeToMinutos(draft.fin);
    if (inicio === null || fin === null) {
      return { turnos: [], error: 'Ingresa un horario válido para cada turno.' };
    }
    turnos.push({ inicio, fin });
  }

  const error = validateTurnos(turnos);
  if (error) return { turnos: [], error };

  return { turnos: sortTurnos(turnos), error: null };
};
