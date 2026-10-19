import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { firebaseAuth } from './shared/config/firebase';
import { existeAdministrador } from './features/admin/services/admin_check';
import { LoginScreen } from './screen/LoginScreen';
import { AdminNavigator } from './navigation/AdminNavigator';

type RoleStatus = 'checking' | 'admin' | 'denied' | 'error';

const App = () => {
  const [authResolved, setAuthResolved] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<RoleStatus>('checking');

  const verificarRol = useCallback(async (currentUser: User) => {
    setRole('checking');
    try {
      const esAdmin = await existeAdministrador(currentUser.uid);
      setRole(esAdmin ? 'admin' : 'denied');
    } catch {
      setRole('error');
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, currentUser => {
      setUser(currentUser);
      setAuthResolved(true);
      if (currentUser) {
        void verificarRol(currentUser);
      } else {
        setRole('checking');
      }
    });
    return unsubscribe;
  }, [verificarRol]);

  const handleReintentar = () => {
    if (user) void verificarRol(user);
  };

  const handleCerrarSesion = async () => {
    await signOut(firebaseAuth);
  };

  // Mientras se comprueba el rol (sin usuario todavía, o con la verificación en
  // curso) no se debe mostrar "No autorizado": es un estado pendiente, no una
  // denegación.
  if (!authResolved || (user && role === 'checking')) {
    return <div className="screen">Verificando sesión…</div>;
  }

  if (role === 'error') {
    return (
      <div className="screen">
        <div className="panel">
          <h1 className="panel-title">No se pudo verificar tu cuenta</h1>
          <p className="panel-subtitle">
            Verifica tu conexión e intenta de nuevo.
          </p>
          <button className="form-button" onClick={handleReintentar}>
            Reintentar
          </button>
          <button className="form-button" onClick={handleCerrarSesion}>
            Cerrar Sesión
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (role === 'denied') {
    return (
      <div className="screen">
        <div className="panel">
          <h1 className="panel-title">No autorizado</h1>
          <p className="panel-subtitle">
            Esta cuenta no tiene permisos de administración. El panel web es
            exclusivo para administradores.
          </p>
          <button className="form-button" onClick={handleCerrarSesion}>
            Cerrar Sesión
          </button>
        </div>
      </div>
    );
  }

  return <AdminNavigator />;
};

export default App;
