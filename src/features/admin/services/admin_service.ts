import { deleteApp, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword, getAuth, initializeAuth, inMemoryPersistence,
  signInWithEmailAndPassword, signOut, deleteUser,
} from 'firebase/auth';
import {
  get, onValue, push, ref, remove, set, update,
} from 'firebase/database';
import {
  firebaseConfig, firebaseDatabase,
} from '../../../shared/config/firebase';

export interface Chofer {
  dni: string;
  nombre: string;
  apellidos: string;
  activo: boolean;
}

export interface Bus {
  placa: string;
  activo: boolean;
}

export interface Asignacion {
  id: string;
  choferId: string;
  busId: string;
  fecha: string;
  activo: boolean;
  createdAt?: number;
  createdBy?: string;
}

const CHOFERES_PATH = '/choferes';
const BUSES_PATH = '/buses';
const ASIGNACIONES_PATH = '/asignaciones';
const CHOFERES_UIDS_PATH = '/choferes_uids';

export const AdminService = {
  // ============================
  // GESTIÓN DE CHOFERES
  // ============================

  // 1. Escuchar lista de choferes en tiempo real
  subscribeToChoferes: (onUpdate: (choferes: Chofer[]) => void) => {
    const dbRef = ref(firebaseDatabase, CHOFERES_PATH);
    const unsubscribe = onValue(
      dbRef,
      snapshot => {
        const data = snapshot.val();
        if (!data) {
          onUpdate([]);
          return;
        }
        const parsed = Object.keys(data).map(key => ({
          dni: key,
          ...data[key],
        }));
        onUpdate(parsed);
      },
      error => {
        console.error('[Firebase Error - Choferes]:', error);
        onUpdate([]);
      },
    );
    return unsubscribe;
  },

  // 2. Crear Chofer (Auth + Realtime Database)
  createChofer: async (chofer: Omit<Chofer, 'activo'>) => {
    const choferRef = ref(firebaseDatabase, `${CHOFERES_PATH}/${chofer.dni}`);

    const snapshot = await get(choferRef);
    if (snapshot.exists()) {
      throw new Error('Ya existe un conductor registrado con este DNI.');
    }

    const email = `${chofer.dni}@burritodriver.com`;
    const password = chofer.dni;

    // App temporal con auth en memoria (no toca localStorage del admin)
    const tempApp = initializeApp(firebaseConfig, `reg_${Date.now()}`);
    const tempAuth = initializeAuth(tempApp, { persistence: inMemoryPersistence });

    try {
      const credential = await createUserWithEmailAndPassword(tempAuth, email, password);
      await signOut(tempAuth);
      await deleteApp(tempApp);

      await set(choferRef, {
        nombre: chofer.nombre.trim(),
        apellidos: chofer.apellidos.trim(),
        activo: true,
        uid: credential.user.uid,
      });
      // Vinculo uid -> dni para la autorizacion RTDB de /ubicacion_buses (ADR-023)
      await set(
        ref(firebaseDatabase, `${CHOFERES_UIDS_PATH}/${credential.user.uid}`),
        chofer.dni,
      );
      return true;
    } catch (error) {
      throw new Error(`Error de autenticación: ${(error as Error).message}`);
    }
  },

  // 3. Toggle Activo / Inactivo
  toggleChoferStatus: async (dni: string, currentStatus: boolean) => {
    try {
      await update(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`), {
        activo: !currentStatus,
      });
      return true;
    } catch (error) {
      console.error('Error actualizando estado del chofer:', error);
      return false;
    }
  },

  // ============================
  // GESTIÓN DE BUSES
  // ============================

  // 1. Escuchar lista de buses en tiempo real
  subscribeToBuses: (onUpdate: (buses: Bus[]) => void) => {
    const dbRef = ref(firebaseDatabase, BUSES_PATH);
    const unsubscribe = onValue(
      dbRef,
      snapshot => {
        const data = snapshot.val();
        if (!data) {
          onUpdate([]);
          return;
        }
        const parsed = Object.keys(data).map(key => ({
          placa: key,
          ...data[key],
        }));
        onUpdate(parsed);
      },
      error => {
        console.error('[Firebase Error - Buses]:', error);
        onUpdate([]);
      },
    );
    return unsubscribe;
  },

  // 2. Crear Bus
  createBus: async (busData: Omit<Bus, 'activo'>) => {
    const placaKey = busData.placa.toUpperCase().trim();
    const busRef = ref(firebaseDatabase, `${BUSES_PATH}/${placaKey}`);
    const ubicacionRef = ref(firebaseDatabase, `/ubicacion_buses/${placaKey}`);

    const snapshot = await get(busRef);
    if (snapshot.exists()) {
      throw new Error('Ya existe un bus registrado con esta placa.');
    }

    await set(busRef, {
      activo: true,
    });

    await set(ubicacionRef, {
      isActive: false,
    });

    return true;
  },

  // 3. Toggle Activo / Inactivo Bus
  toggleBusStatus: async (placa: string, newStatus: boolean) => {
    try {
      await update(ref(firebaseDatabase, `${BUSES_PATH}/${placa}`), {
        activo: newStatus,
      });
      return true;
    } catch (error) {
      console.error('Error actualizando estado del bus:', error);
      return false;
    }
  },

  // ============================
  // GESTIÓN DE ASIGNACIONES
  // ============================

  // 1. Obtener fecha de hoy en formato local (YYYY-MM-DD)
  getTodayDateString: () => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  },

  // 2. Escuchar asignaciones de HOY en tiempo real
  subscribeToAsignacionesHoy: (onUpdate: (asignaciones: Asignacion[]) => void) => {
    const today = AdminService.getTodayDateString();
    const dbRef = ref(firebaseDatabase, ASIGNACIONES_PATH);

    const unsubscribe = onValue(
      dbRef,
      snapshot => {
        const data = snapshot.val();
        if (!data) {
          onUpdate([]);
          return;
        }

        const parsed: Asignacion[] = [];
        Object.keys(data).forEach(key => {
          const item = data[key];
          if (item.fecha === today && item.activo === true) {
            parsed.push({ id: key, ...item });
          }
        });
        onUpdate(parsed);
      },
      error => {
        console.error('[Firebase Error - Asignaciones]:', error);
        onUpdate([]);
      },
    );
    return unsubscribe;
  },

  // 3. Crear Asignación
  createAsignacion: async (choferId: string, busId: string) => {
    const today = AdminService.getTodayDateString();
    const dbRef = ref(firebaseDatabase, ASIGNACIONES_PATH);

    const snapshot = await get(dbRef);
    if (snapshot.exists()) {
      const data = snapshot.val() as Record<string, Asignacion>;
      const yaAsignadoChofer = Object.values(data).some(
        a => a.choferId === choferId && a.fecha === today && a.activo === true,
      );
      if (yaAsignadoChofer) throw new Error('El conductor ya tiene un bus asignado hoy.');

      const yaAsignadoBus = Object.values(data).some(
        a => a.busId === busId && a.fecha === today && a.activo === true,
      );
      if (yaAsignadoBus) throw new Error('Este bus ya fue asignado a otro conductor hoy.');
    }

    const adminUid = getAuth().currentUser?.uid;
    if (!adminUid) throw new Error('No hay administrador autenticado.');

    const newRef = push(dbRef);
    await set(newRef, {
      choferId,
      busId,
      fecha: today,
      activo: true,
      createdAt: Date.now(),
      createdBy: adminUid,
    });
    return true;
  },

  // 4. Cancelar Asignación (Desactivarla)
  cancelarAsignacion: async (asignacionId: string) => {
    try {
      await update(ref(firebaseDatabase, `${ASIGNACIONES_PATH}/${asignacionId}`), {
        activo: false,
      });
      return true;
    } catch (error) {
      console.error('Error cancelando asignación:', error);
      return false;
    }
  },

  // ============================
  // EDICIÓN Y ELIMINACIÓN
  // ============================

  // 5. Verificar si un conductor tiene asignación activa HOY
  hasActiveAssignment: async (dni: string): Promise<boolean> => {
    const today = AdminService.getTodayDateString();
    const snapshot = await get(ref(firebaseDatabase, ASIGNACIONES_PATH));
    if (!snapshot.exists()) return false;
    const data = snapshot.val();
    return Object.values(data).some(
      (a: any) => a.choferId === dni && a.fecha === today && a.activo === true,
    );
  },

  // 6. Verificar si un bus tiene asignación activa HOY
  hasActiveBusAssignment: async (placa: string): Promise<boolean> => {
    const today = AdminService.getTodayDateString();
    const snapshot = await get(ref(firebaseDatabase, ASIGNACIONES_PATH));
    if (!snapshot.exists()) return false;
    const data = snapshot.val();
    return Object.values(data).some(
      (a: any) => a.busId === placa && a.fecha === today && a.activo === true,
    );
  },

  // 7. Editar conductor (nombre y apellidos)
  updateChofer: async (dni: string, data: { nombre: string; apellidos: string }) => {
    await update(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`), {
      nombre: data.nombre.trim(),
      apellidos: data.apellidos.trim(),
    });
    return true;
  },

  // 8. Eliminar conductor (RTDB primero con auth admin, luego Auth del conductor)
  deleteChofer: async (dni: string) => {
    // Leer uid desde /choferes/{dni} (no de /choferes_uids, que tiene .read: false)
    const choferSnapshot = await get(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`));
    const uid = choferSnapshot.exists() ? (choferSnapshot.val().uid as string | undefined) : null;

    // Eliminar registros de RTDB (con auth de admin activa)
    await remove(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`));
    if (uid) {
      await remove(ref(firebaseDatabase, `${CHOFERES_UIDS_PATH}/${uid}`));
    }

    // Eliminar cuenta de Auth del conductor (app temporal con auth en memoria)
    const email = `${dni}@burritodriver.com`;
    const tempApp = initializeApp(firebaseConfig, `del_${Date.now()}`);
    const tempAuth = initializeAuth(tempApp, { persistence: inMemoryPersistence });

    try {
      await signInWithEmailAndPassword(tempAuth, email, dni);
      await deleteUser(tempAuth.currentUser!);
    } catch {
      // Auth ya no existe o falló — la eliminación RTDB ya se hizo
    } finally {
      try { await signOut(tempAuth); } catch { /* ignore */ }
      try { await deleteApp(tempApp); } catch { /* ignore */ }
    }

    return true;
  },

  // 9. Eliminar bus (RTDB + ubicacion_buses)
  deleteBus: async (placa: string) => {
    await remove(ref(firebaseDatabase, `${BUSES_PATH}/${placa}`));
    await remove(ref(firebaseDatabase, `/ubicacion_buses/${placa}`));
    return true;
  },
};