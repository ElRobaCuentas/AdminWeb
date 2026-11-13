import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import { readFirebaseEnv } from './env';

// Modo explícito de desarrollo: proyecto sin recursos reales, sin leer .env.
const local = import.meta.env.DEV && import.meta.env.MODE === 'pulso-local';
const firebaseConfig = local ? {
  apiKey: 'local-emulator', authDomain: 'demo-pulso-api.firebaseapp.com',
  databaseURL: 'https://demo-pulso-api.firebaseio.com', projectId: 'demo-pulso-api',
  appId: 'local-pulso-central',
} : readFirebaseEnv();

export { firebaseConfig };

const app = initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firebaseDatabase = getDatabase(app);

if (local) {
  connectAuthEmulator(firebaseAuth, 'http://127.0.0.1:19099');
  connectDatabaseEmulator(firebaseDatabase, '127.0.0.1', 19000);
}
