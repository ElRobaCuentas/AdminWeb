import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth } from '../../../shared/config/firebase';

export const AdminPanelScreen = () => {
  const navigate = useNavigate();

  const handleLogout = () => {
    if (window.confirm('¿Estás seguro de que deseas salir?')) {
      signOut(firebaseAuth);
    }
  };

  return (
    <div className="screen">
      <div className="panel">
        <h1 className="panel-title">Panel de Control</h1>
        <p className="panel-subtitle">Selecciona el módulo que deseas gestionar:</p>

        <div className="menu-list">
          <button className="menu-button" onClick={() => navigate('/choferes')}>
            Gestión de choferes
            <span>Registrar, activar y desactivar conductores</span>
          </button>

          <button className="menu-button" onClick={() => navigate('/buses')}>
            Gestión de buses
            <span>Registrar placas, modelos y estado de los vehículos</span>
          </button>

          <button className="menu-button" onClick={() => navigate('/asignaciones')}>
            Asignaciones diarias
            <span>Vincular conductores con vehículos para el turno de hoy</span>
          </button>

          <button className="logout-button" onClick={handleLogout}>
            Cerrar Sesión
          </button>
        </div>
      </div>
    </div>
  );
};