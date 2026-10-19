import { createContext, useContext } from 'react';
import type { Administrador } from '../../features/admin/services/admin_service';

export const SessionContext = createContext<Administrador | null>(null);

export const useSession = (): Administrador | null => useContext(SessionContext);
