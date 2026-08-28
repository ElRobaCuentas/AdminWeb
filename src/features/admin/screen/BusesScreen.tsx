import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminService, type Bus, type Administrador } from '../services/admin_service';

interface Mensaje {
  tipo: 'exito' | 'error';
  texto: string;
}

export const BusesScreen = () => {
  const navigate = useNavigate();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [admins, setAdmins] = useState<Administrador[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  const [placa, setPlaca] = useState('');

  // 1. Cargar buses en tiempo real
  useEffect(() => {
    const unsubscribe = AdminService.subscribeToBuses(data => {
      setBuses(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 1b. Cargar admins para resolver "Creado por"
  useEffect(() => {
    const unsubscribe = AdminService.subscribeToAdministradores(setAdmins);
    return () => unsubscribe();
  }, []);

  // 2. Manejar Creación
  const handleCreate = async () => {
    setMensaje(null);
    if (!placa) {
      setMensaje({ tipo: 'error', texto: 'La placa es obligatoria' });
      return;
    }

    if (placa.trim().length < 6) {
      setMensaje({ tipo: 'error', texto: 'Ingrese una placa válida' });
      return;
    }

    setCreating(true);
    try {
      await AdminService.createBus({
        placa: placa.toUpperCase().trim(),
      });
      setMensaje({ tipo: 'exito', texto: 'Bus registrado correctamente en la flota.' });
      setPlaca('');
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setCreating(false);
    }
  };

  // 3. Manejar Eliminación
  const handleDelete = async (bus: Bus) => {
    setMensaje(null);
    const tieneAsignacion = await AdminService.hasActiveBusAssignment(bus.placa);
    if (tieneAsignacion) {
      setMensaje({ tipo: 'error', texto: 'Este bus tiene una asignación activa. Cancele la asignación primero.' });
      return;
    }
    if (!window.confirm(`¿Eliminar el bus ${bus.placa}? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await AdminService.deleteBus(bus.placa);
      setMensaje({ tipo: 'exito', texto: `Bus ${bus.placa} eliminado correctamente.` });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    }
  };

  const resolveAdminName = (uid?: string | null): string => {
    if (!uid) return 'Admin eliminado';
    const admin = admins.find(a => a.uid === uid);
    if (admin?.nombres) return `${admin.nombres} ${admin.apellidos ?? ''}`.trim();
    return 'Admin eliminado';
  };

  const formatDate = (ts?: number): string => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('es-PE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  if (loading) {
    return <div className="screen">Cargando buses…</div>;
  }

  return (
    <div className="screen screen-scroll">
      <div className="panel panel-wide">
        <button className="back-button" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1 className="panel-title">Gestión de buses</h1>

        <div className="form-section">
          <h2 className="section-title">Registrar nuevo bus</h2>
          <div className="form-group">
            <label className="form-label" htmlFor="bus-placa">Placa (Ej: AHK-452)</label>
            <input
              id="bus-placa"
              className="form-input"
              placeholder="AHK-452"
              style={{ textTransform: 'uppercase' }}
              value={placa}
              onChange={e => setPlaca(e.target.value)}
            />
          </div>
          <button
            className="form-button"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Registrando…' : 'Registrar Bus'}
          </button>
          {mensaje && <p className={`form-message ${mensaje.tipo}`}>{mensaje.texto}</p>}
        </div>

        <h2 className="section-title">Flota registrada</h2>
        {buses.length === 0 ? (
          <p className="empty-text">No hay buses registrados aún.</p>
        ) : (
          <ul className="list">
            {buses.map(item => (
              <li key={item.placa} className="card">
                <div className="card-info">
                  <p className="card-title">{item.placa}</p>
                  {item.creadoEn && (
                    <p className="card-meta">Creado el: {formatDate(item.creadoEn)}</p>
                  )}
                  {item.creadoPor && (
                    <p className="card-meta">Creado por: {resolveAdminName(item.creadoPor)}</p>
                  )}
                </div>
                <div className="card-actions">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Activo: ${item.placa}`}
                    checked={item.activo}
                    onChange={e => {
                      const accion = item.activo ? 'desactivar' : 'activar';
                      if (window.confirm(`¿Estás seguro que querés ${accion} el bus ${item.placa}?`)) {
                        AdminService.toggleBusStatus(item.placa, e.target.checked).then(ok => {
                          if (!ok) {
                            setMensaje({ tipo: 'error', texto: `No se pudo ${accion} el bus. Inténtalo de nuevo.` });
                          }
                        });
                      }
                    }}
                  />
                  <button
                    className="icon-button icon-button-danger"
                    title="Eliminar"
                    onClick={() => handleDelete(item)}
                  >
                    🗑️
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
