// Reglas de DNI: exactamente ocho dígitos numéricos.
// Centraliza la normalización y validación para pantallas y servicios.

export const normalizeDni = (value: string): string => value.trim();

// Deja solo dígitos (descarta letras, espacios y símbolos) para los inputs.
export const sanitizeDniInput = (value: string): string => value.replace(/\D/g, '');

export const isValidDni = (value: string): boolean => /^\d{8}$/.test(value);
