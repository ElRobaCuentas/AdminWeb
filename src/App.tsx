import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { firebaseAuth } from './shared/config/firebase';
import { existeAdministrador } from './features/admin/services/admin_check';
import { LoginScreen } from './screen/LoginScreen';
import { AdminNavigator } from './navigation/AdminNavigator';

const App = () => {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [roleError, setRoleError] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, async currentUser => {
      setUser(currentUser);
      if (currentUser) {
        try {
          setIsAdmin(await existeAdministrador(currentUser.uid));
        } catch {
          setRoleError(true);
        }
      } else {
        setIsAdmin(null);
        setRoleError(false);
      }
      setInitializing(false);
    });
    return unsubscribe;
  }, []);

  const handleReintentar = async () => {
    if (!user) return;
    setRoleError(false);
    try {
      setIsAdmin(await existeAdministrador(user.uid));
    } catch {
      setRoleError(true);
    }
  };

  const handleCerrarSesion = async () => {
    await signOut(firebaseAuth);
  };

  if (initializing) {
    return <div className="screen">Verificando sesión…</div>;
  }

  if (roleError) {
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

  if (!isAdmin) {
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