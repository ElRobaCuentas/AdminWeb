import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminService } from '../services/admin_service';
import { useSession } from '../../../shared/layout/SessionContext';
import { Icon, type IconName } from '../../../shared/ui/Icon';
import { StatCard } from '../../../shared/ui/StatCard';

interface ModuleLink {
  to: string;
  icon: IconName;
  title: string;
  description: string;
}

const MODULES: ModuleLink[] = [
  {
    to: '/choferes',
    icon: 'drivers',
    title: 'Gestión de conductores',
    description: 'Registrar, activar y desactivar conductores.',
  },
  {
    to: '/buses',
    icon: 'bus',
    title: 'Gestión de buses',
    description: 'Registrar placas y estado de los vehículos.',
  },
  {
    to: '/asignaciones',
    icon: 'assignment',
    title: 'Asignaciones diarias',
    description: 'Vincular conductores con vehículos para el turno de hoy.',
  },
  {
    to: '/admins',
    icon: 'admins',
    title: 'Administradores',
    description: 'Registrar, editar y eliminar cuentas de administrador.',
  },
];

export const AdminPanelScreen = () => {
  const navigate = useNavigate();
  const admin = useSession();

  const [choferesActivos, setChoferesActivos] = useState(0);
  const [busesActivos, setBusesActivos] = useState(0);
  const [asignacionesHoy, setAsignacionesHoy] = useState(0);

  useEffect(() => {
    const unsubChoferes = AdminService.subscribeToChoferes(data => {
      setChoferesActivos(data.filter(c => c.activo).length);
    });
    const unsubBuses = AdminService.subscribeToBuses(data => {
      setBusesActivos(data.filter(b => b.activo).length);
    });
    const unsubAsignaciones = AdminService.subscribeToAsignacionesHoy(data => {
      setAsignacionesHoy(data.length);
    });
    return () => {
      unsubChoferes();
      unsubBuses();
      unsubAsignaciones();
    };
  }, []);

  const nombre = admin?.nombres?.trim();

  return (
    <div className="stack">
      <div className="welcome-banner">
        <div>
          <h2>{nombre ? `Hola, ${nombre}` : 'Bienvenido al panel'}</h2>
          <p>Este es el resumen de la operación de hoy.</p>
        </div>
        <div className="avatar">
          <Icon name="dashboard" size={20} />
        </div>
      </div>

      <section>
        <h2 className="section-title">Resumen de hoy</h2>
        <div className="grid">
          <StatCard
            icon={<Icon name="drivers" size={24} />}
            value={choferesActivos}
            label="Conductores activos"
          />
          <StatCard
            icon={<Icon name="bus" size={24} />}
            value={busesActivos}
            label="Buses activos"
            tone="accent"
          />
          <StatCard
            icon={<Icon name="assignment" size={24} />}
            value={asignacionesHoy}
            label="Asignaciones de hoy"
            tone="success"
          />
        </div>
      </section>

      <section>
        <h2 className="section-title">Módulos</h2>
        <div className="grid">
          {MODULES.map(module => (
            <button
              key={module.to}
              type="button"
              className="module-card"
              onClick={() => navigate(module.to)}
            >
              <span className="module-icon">
                <Icon name={module.icon} size={22} />
              </span>
              <span className="module-title">{module.title}</span>
              <span className="module-desc">{module.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
