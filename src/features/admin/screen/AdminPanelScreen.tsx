import { signOut } from 'firebase/auth';
import { firebaseAuth } from '../../../shared/config/firebase';

export const AdminPanelScreen = () => {
  const handleCerrarSesion = async () => {
    await signOut(firebaseAuth);
  };

  return (
    <div className="screen">
      <div className="panel">
        <h1 className="panel-title">Panel de Control</h1>
        <p className="panel-subtitle">
          Gestión de choferes, buses y asignaciones.
        </p>
        <button className="form-button" onClick={handleCerrarSesion}>
          Cerrar Sesión
        </button>
      </div>
    </div>
  );
};