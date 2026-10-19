import { deleteApp, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword, getAuth, initializeAuth, inMemoryPersistence,
  signOut,
} from 'firebase/auth';
import {
  get, onValue, push, ref, remove, set, update,
} from 'firebase/database';
import {
  firebaseConfig, firebaseDatabase,
} from '../../../shared/config/firebase';
import { isValidDni, normalizeDni } from '../../../shared/utils/dni';

export interface Chofer {
  dni: string;
  nombre: string;
  apellidos: string;
  activo: boolean;
  uid?: string;
  creadoEn?: number;
  creadoPor?: string | null;
}

export interface Bus {
  placa: string;
  activo: boolean;
  creadoEn?: number;
  creadoPor?: string | null;
}

export interface Asignacion {
  id: string;
  choferId: string;
  busId: string;
  fecha: string;
  activo: boolean;
  horaInicio?: number;
  horaFin?: number;
  createdAt?: number;
  createdBy?: string;
}

export interface Administrador {
  uid: string;
  dni?: string;
  nombres?: string;
  apellidos?: string;
  correo?: string;
  creadoEn?: number;
  creadoPor?: string | null;
}

const CHOFERES_PATH = '/choferes';
const BUSES_PATH = '/buses';
const ASIGNACIONES_PATH = '/asignaciones';
const CHOFERES_UIDS_PATH = '/choferes_uids';
const ADMINISTRADORES_PATH = '/administradores';

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
    const dni = normalizeDni(chofer.dni);
    if (!isValidDni(dni)) {
      throw new Error('El DNI debe tener exactamente 8 dígitos numéricos.');
    }

    const choferRef = ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`);

    const snapshot = await get(choferRef);
    if (snapshot.exists()) {
      throw new Error('Ya existe un conductor registrado con este DNI.');
    }

    const email = `${dni}@conductor.com`;
    const password = dni;

    // App temporal con auth en memoria (no toca localStorage del admin)
    const tempApp = initializeApp(firebaseConfig, `reg_${Date.now()}`);
    const tempAuth = initializeAuth(tempApp, { persistence: inMemoryPersistence });

    try {
      let credential;
      try {
        credential = await createUserWithEmailAndPassword(tempAuth, email, password);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'auth/email-already-in-use') {
          throw new Error(
            `Ya existe una cuenta de autenticación con el correo ${email} sin su nodo en la base de datos. ` +
              'Bórrala desde la consola de Firebase (Authentication) e inténtalo de nuevo.',
          );
        }
        throw new Error(
          `Error al crear la cuenta de autenticación: ${(error as Error).message}`,
        );
      }
      await signOut(tempAuth);
      await deleteApp(tempApp);

      await set(choferRef, {
        nombre: chofer.nombre.trim(),
        apellidos: chofer.apellidos.trim(),
        activo: true,
        uid: credential.user.uid,
        creadoEn: Date.now(),
        creadoPor: getAuth().currentUser?.uid ?? null,
      });
      // Vinculo uid -> dni para la autorizacion RTDB de /ubicacion_buses (ADR-023)
      await set(
        ref(firebaseDatabase, `${CHOFERES_UIDS_PATH}/${credential.user.uid}`),
        dni,
      );
      return true;
    } catch (error) {
      throw new Error(`Error de autenticación: ${(error as Error).message}`);
    }
  },

  // 3. Toggle Activo / Inactivo
  toggleChoferStatus: async (dni: string, newStatus: boolean) => {
    try {
      await update(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`), {
        activo: newStatus,
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
      creadoEn: Date.now(),
      creadoPor: getAuth().currentUser?.uid ?? null,
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
  createAsignacion: async (
    choferId: string,
    busId: string,
    horaInicio?: number,
    horaFin?: number,
  ) => {
    const today = AdminService.getTodayDateString();
    const dbRef = ref(firebaseDatabase, ASIGNACIONES_PATH);

    const snapshot = await get(dbRef);
    if (snapshot.exists()) {
      const data = snapshot.val() as Record<string, Asignacion>;
      const yaAsignadoChofer = Object.values(data).some(
        a => a.choferId === choferId && a.fecha === today && a.activo === true,
      );
      if (yaAsignadoChofer) throw new Error('El conductor ya tiene un bus asignado hoy.');
    }

    const adminUid = getAuth().currentUser?.uid;
    if (!adminUid) throw new Error('No hay administrador autenticado.');

    const newRef = push(dbRef);
    await set(newRef, {
      choferId,
      busId,
      fecha: today,
      activo: true,
      horaInicio,
      horaFin,
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

  // 5. Verificar si un bus tiene asignación activa HOY
  hasActiveBusAssignment: async (placa: string): Promise<boolean> => {
    const today = AdminService.getTodayDateString();
    const snapshot = await get(ref(firebaseDatabase, ASIGNACIONES_PATH));
    if (!snapshot.exists()) return false;
    const data = snapshot.val() as Record<string, Asignacion>;
    return Object.values(data).some(
      (a: Asignacion) => a.busId === placa && a.fecha === today && a.activo === true,
    );
  },

  // 6. Editar conductor (nombre y apellidos)
  updateChofer: async (dni: string, data: { nombre: string; apellidos: string }) => {
    await update(ref(firebaseDatabase, `${CHOFERES_PATH}/${dni}`), {
      nombre: data.nombre.trim(),
      apellidos: data.apellidos.trim(),
    });
    return true;
  },

  // 7. Eliminar bus (RTDB + ubicacion_buses)
  deleteBus: async (placa: string) => {
    await remove(ref(firebaseDatabase, `${BUSES_PATH}/${placa}`));
    await remove(ref(firebaseDatabase, `/ubicacion_buses/${placa}`));
    return true;
  },

  // ============================
  // GESTIÓN DE ADMINS
  // ============================

  // 8. Crear Admin (Auth + RTDB)
  createAdmin: async (dni: string, nombres: string, apellidos: string, password: string) => {
    const dniNormalizado = normalizeDni(dni);
    if (!isValidDni(dniNormalizado)) {
      throw new Error('El DNI debe tener exactamente 8 dígitos numéricos.');
    }

    const adminRef = ref(firebaseDatabase, `${ADMINISTRADORES_PATH}`);

    // Verificar que no exista otro admin con el mismo DNI
    const snapshot = await get(adminRef);
    if (snapshot.exists()) {
      const data = snapshot.val() as Record<string, Administrador>;
      const yaExiste = Object.values(data).some(
        (a: Administrador) => a.dni === dniNormalizado,
      );
      if (yaExiste) throw new Error('Ya existe un administrador registrado con este DNI.');
    }

    const email = `${dniNormalizado}@admin.com`;

    // App temporal con auth en memoria (no toca localStorage del admin actual)
    const tempApp = initializeApp(firebaseConfig, `admin_${Date.now()}`);
    const tempAuth = initializeAuth(tempApp, { persistence: inMemoryPersistence });

    // Bloque 1: crear la cuenta Auth (app temporal)
    let credential;
    try {
      credential = await createUserWithEmailAndPassword(tempAuth, email, password);
      await signOut(tempAuth);
      await deleteApp(tempApp);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'auth/email-already-in-use') {
        throw new Error(
          `Ya existe una cuenta de autenticación con el correo ${email} sin su nodo en la base de datos. ` +
            'Bórrala desde la consola de Firebase (Authentication) e inténtalo de nuevo.',
        );
      }
      throw new Error(
        `Error al crear la cuenta de autenticación: ${(error as Error).message}`,
      );
    }

    // Bloque 2: escribir el nodo en /administradores (RTDB, app principal)
    try {
      await set(
        ref(firebaseDatabase, `${ADMINISTRADORES_PATH}/${credential.user.uid}`),
        {
          dni: dniNormalizado,
          nombres: nombres.trim(),
          apellidos: apellidos.trim(),
          correo: email,
          creadoEn: Date.now(),
          creadoPor: getAuth().currentUser?.uid ?? null,
        },
      );
      return true;
    } catch (error) {
      throw new Error(
        `Error al guardar los datos del administrador: ${(error as Error).message}`,
      );
    }
  },

  // 9. Suscripción en tiempo real a administradores
  subscribeToAdministradores: (onUpdate: (admins: Administrador[]) => void) => {
    const dbRef = ref(firebaseDatabase, ADMINISTRADORES_PATH);
    const unsubscribe = onValue(
      dbRef,
      snapshot => {
        const data = snapshot.val();
        if (!data) {
          onUpdate([]);
          return;
        }
        const parsed = Object.keys(data).map(key => ({
          uid: key,
          ...data[key],
        }));
        onUpdate(parsed);
      },
      error => {
        console.error('[Firebase Error - Administradores]:', error);
        onUpdate([]);
      },
    );
    return unsubscribe;
  },

  // 10. Editar admin (nombre/apellidos)
  updateAdmin: async (uid: string, data: { nombres: string; apellidos: string }) => {
    await update(ref(firebaseDatabase, `${ADMINISTRADORES_PATH}/${uid}`), {
      nombres: data.nombres.trim(),
      apellidos: data.apellidos.trim(),
    });
    return true;
  },

  // 11. Eliminar admin (RTDB; la cuenta Auth se borra manualmente en consola)
  deleteAdmin: async (uid: string) => {
    await remove(ref(firebaseDatabase, `${ADMINISTRADORES_PATH}/${uid}`));
    return true;
  },

  // 12. Obtener datos de un admin (para mostrar identidad en sesión)
  getAdministrador: async (uid: string): Promise<Administrador | null> => {
    const snapshot = await get(ref(firebaseDatabase, `${ADMINISTRADORES_PATH}/${uid}`));
    if (!snapshot.exists()) return null;
    const val = snapshot.val();
    if (val === true) return { uid };
    return { uid, ...val };
  },
};