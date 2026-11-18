import type { CurrentTrackingFields, TrackingObservation } from '../../src/domain/evaluateTracking.ts';

const fields = ['isActive', 'timestamp', 'latitude', 'longitude', 'heading', 'speed'] as const;
type CurrentField = typeof fields[number];

export function toTrackingObservation(data: unknown, evaluatedAt: number) {
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('Invalid RTDB payload');
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const current: { -readonly [K in keyof CurrentTrackingFields]: CurrentTrackingFields[K] } = {};
  const presentFields: CurrentField[] = [];
  const missingFields: CurrentField[] = [];
  const invalidFields: CurrentField[] = [];
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) { missingFields.push(field); continue; }
    presentFields.push(field);
    if (field === 'isActive') {
      if (typeof value === 'boolean') current.isActive = value;
      else invalidFields.push(field);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      current[field] = value;
    } else {
      invalidFields.push(field);
    }
  }
  // No derivar planned: ni el timestamp de publicación ni las coordenadas identifican el fix GPS.
  const observation: TrackingObservation = { evaluatedAt, sourceAccess: 'available', current };
  return { observation, presentFields, missingFields, invalidFields };
}
