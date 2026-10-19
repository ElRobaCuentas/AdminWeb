export interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
}

// Valida las variables obligatorias de configuración de Firebase antes de
// inicializar la app. Si falta alguna, falla al iniciar con un mensaje claro
// en lugar de producir errores difíciles de diagnosticar más adelante.
// Las variables VITE_* son configuración cliente: no son secretos.
export const readFirebaseEnv = (): FirebaseEnv => {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;

  const missing: string[] = [];
  if (!apiKey || !apiKey.trim()) missing.push('VITE_FIREBASE_API_KEY');
  if (!authDomain || !authDomain.trim()) missing.push('VITE_FIREBASE_AUTH_DOMAIN');
  if (!databaseURL || !databaseURL.trim()) missing.push('VITE_FIREBASE_DATABASE_URL');
  if (!projectId || !projectId.trim()) missing.push('VITE_FIREBASE_PROJECT_ID');
  if (!appId || !appId.trim()) missing.push('VITE_FIREBASE_APP_ID');

  if (missing.length > 0) {
    throw new Error(
      `Configuración de Firebase incompleta. Faltan las variables: ${missing.join(', ')}. ` +
        'Revisá el archivo .env (ver .env.example).',
    );
  }

  return { apiKey, authDomain, databaseURL, projectId, appId };
};
