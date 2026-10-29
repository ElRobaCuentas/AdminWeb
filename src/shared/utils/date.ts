const LIMA_TIME_ZONE = 'America/Lima';

const limaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LIMA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const getLimaDateString = (date: Date = new Date()): string => {
  const parts = limaDateFormatter.formatToParts(date);
  const getPart = (type: string) =>
    parts.find(part => part.type === type)?.value ?? '';

  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
};

export const isValidDateString = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

export const isDateOnOrAfter = (value: string, reference: string): boolean =>
  isValidDateString(value) && isValidDateString(reference) && value >= reference;

export const formatCalendarDate = (value: string): string => {
  if (!isValidDateString(value)) return value;

  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
};
