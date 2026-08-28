import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth } from '../../../shared/config/firebase';
import { AdminService, type Administrador } from '../services/admin_service';

export const AdminPanelScreen = () => {
  const navigate = useNavigate();
  const [adminData, setAdminData] = useState<Administrador | null>(null);

  useEffect(() => {
    const uid = firebaseAuth.currentUser?.uid;
    if (!uid) return;
    let active = true;
    AdminService.getAdministrador(uid).then(data => {
      if (active) setAdminData(data);
    });
    return () => {
      active = false;
    };
  }, []);

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

        {adminData && (adminData.nombres || adminData.dni) && (
          <div className="session-info">
            <p className="session-name">
              Bienvenido, {adminData.nombres || ''} {adminData.apellidos || ''} — DNI:{' '}
              {adminData.dni || '—'}
            </p>
            {adminData.correo && <p className="session-email">Correo: {adminData.correo}</p>}
          </div>
        )}

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

          <button className="menu-button" onClick={() => navigate('/admins')}>
            Gestión de administradores
            <span>Registrar, editar y eliminar cuentas de administrador</span>
          </button>

          <button className="logout-button" onClick={handleLogout}>
            Cerrar Sesión
          </button>
        </div>
      </div>
    </div>
  );
};