import { get, ref } from 'firebase/database';
import { firebaseDatabase } from '../../../shared/config/firebase';
import { withTimeout } from '../../../shared/utils/timeout';

// C4.AUTH: el auth gate corre una sola vez al abrir la app. Sin red,
// `get` de firebase/database nunca resuelve ni rechaza (hang indefinido).
// Acotamos el read para que el `.catch` de App dispare la pantalla de
// error existente (REINTENTAR / CERRAR SESIÓN) en lugar de un spinner eterno.
const ROLE_TIMEOUT_MS = 10000;

export const existeAdministrador = async (uid: string): Promise<boolean> => {
  try {
    const snapshot = await withTimeout(
      get(ref(firebaseDatabase, `/administradores/${uid}`)),
      ROLE_TIMEOUT_MS,
    );
    return snapshot.exists();
  } catch (error) {
    // En esta ruta la regla RTDB exige que el usuario ya figure en
    // /administradores: PERMISSION_DENIED equivale a "no es administrador".
    if ((error as { code?: string }).code === 'PERMISSION_DENIED') {
      return false;
    }
    // Timeout o fallo de red: no se puede verificar. Se propaga para que el
    // gate muestre el error recuperable y no una denegación definitiva.
    throw error;
  }
};