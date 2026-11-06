import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { firebaseAuth } from '../config/firebase';
import { AdminService, type Administrador } from '../../features/admin/services/admin_service';
import { Icon, type IconName } from '../ui/Icon';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Modal';
import { initialsOf } from '../utils/format';
import { SessionContext } from './SessionContext';

const NAV_ITEMS: { to: string; label: string; icon?: IconName }[] = [
  { to: '/', label: 'Asignaciones', icon: 'assignment' },
  { to: '/choferes', label: 'Conductores', icon: 'drivers' },
  { to: '/buses', label: 'Buses', icon: 'bus' },
  { to: '/admins', label: 'Administradores', icon: 'admins' },
];

const TITLES: Record<string, string> = {
  '/': 'Asignaciones',
  '/choferes': 'Conductores',
  '/buses': 'Buses',
  '/asignaciones': 'Asignaciones',
  '/admins': 'Administradores',
};

export const AppShell = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Administrador | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(firebaseAuth, user => {
      if (!active) return;
      if (!user) {
        setAdmin(null);
        return;
      }
      AdminService.getAdministrador(user.uid).then(data => {
        if (active) setAdmin(data);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const pageTitle = TITLES[location.pathname] ?? TITLES['/'];
  const fullName = admin
    ? `${admin.nombres ?? ''} ${admin.apellidos ?? ''}`.trim()
    : '';
  const initials = initialsOf(admin?.nombres ?? '', admin?.apellidos);
  const todayLabel = new Intl.DateTimeFormat('es-PE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Lima',
  }).format(new Date());
  const dateLabel = todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1);

  const handleLogout = async () => {
    setConfirmLogout(false);
    await signOut(firebaseAuth);
    navigate('/');
  };

  return (
    <div className="app-shell">
      <aside className={['sidebar', drawerOpen ? 'is-open' : ''].filter(Boolean).join(' ')}>
        <div className="sidebar-brand">
          <div>
            El Burrito
            <small>ADMINISTRACION</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                ['nav-item', isActive ? 'is-active' : ''].filter(Boolean).join(' ')
              }
            >
              <span className="nav-icon">
                {item.icon ? <Icon name={item.icon} size={19} /> : null}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-name">{fullName || 'Administrador'}</div>
            {admin?.correo ? <div className="sidebar-user-email">{admin.correo}</div> : null}
          </div>
          <Button
            variant="secondary"
            size="sm"
            block
            icon={<Icon name="logout" size={16} />}
            onClick={() => setConfirmLogout(true)}
          >
            Cerrar sesión
          </Button>
        </div>
      </aside>

      <div
        className={['sidebar-backdrop', drawerOpen ? 'is-open' : ''].filter(Boolean).join(' ')}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <div className="app-main">
        <header className="topbar">
          <button
            className="hamburger"
            type="button"
            aria-label="Abrir menú"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="topbar-titles" />
          <div className="topbar-date">{dateLabel}</div>
          <div className="topbar-user">
            <span className="avatar">{initials}</span>
          </div>
        </header>

        <main className="app-content">
          <h1 className="page-heading">{pageTitle}</h1>
          <SessionContext.Provider value={admin}>{children}</SessionContext.Provider>
        </main>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        title="Cerrar sesión"
        message="¿Estás seguro de que deseas salir del panel?"
        confirmLabel="Cerrar sesión"
        danger
        onConfirm={handleLogout}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
};
