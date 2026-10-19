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
  return `${horas}:${String(mins).padStart(2, '0')}`;
};
