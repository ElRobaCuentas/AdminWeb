import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { readFirebaseEnv } from './env';

const firebaseConfig = readFirebaseEnv();

export { firebaseConfig };

const app = initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firebaseDatabase = getDatabase(app);