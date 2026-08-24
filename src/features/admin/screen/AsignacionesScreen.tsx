import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AdminService, type Asignacion, type Bus, type Chofer,
} from '../services/admin_service';

interface Mensaje {
  tipo: 'exito' | 'error';
  texto: string;
}

const formatCreatedAt = (ts: number) =>
  new Date(ts).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });

export const AsignacionesScreen = () => {
  const navigate = useNavigate();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  const [selectedChofer, setSelectedChofer] = useState<string | null>(null);
  const [selectedBus, setSelectedBus] = useState<string | null>(null);

  useEffect(() => {
    // 1. Cargar datos en paralelo
    const unsubChoferes = AdminService.subscribeToChoferes(data => {
      setChoferes(data.filter(c => c.activo)); // Solo aptos
    });
    const unsubBuses = AdminService.subscribeToBuses(data => {
      setBuses(data.filter(b => b.activo)); // Solo aptos
    });
    const unsubAsignaciones = AdminService.subscribeToAsignacionesHoy(data => {
      setAsignaciones(data);
      setLoading(false);
    });

    return () => {
      unsubChoferes();
      unsubBuses();
      unsubAsignaciones();
    };
  }, []);

  const handleCreate = async () => {
    setMensaje(null);
    if (!selectedChofer || !selectedBus) {
      setMensaje({ tipo: 'error', texto: 'Seleccione un conductor y un bus.' });
      return;
    }

    setCreating(true);
    try {
      await AdminService.createAsignacion(selectedChofer, selectedBus);
      setMensaje({ tipo: 'exito', texto: 'Asignación creada para el turno de hoy.' });
      setSelectedChofer(null);
      setSelectedBus(null);
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = (id: string) => {
    if (window.confirm('¿El conductor dejará de manejar este bus hoy?')) {
      AdminService.cancelarAsignacion(id);
    }
  };

  if (loading) {
    return <div className="screen">Cargando asignaciones…</div>;
  }

  return (
    <div className="screen screen-scroll">
      <div className="panel panel-wide">
        <button className="back-button" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1 className="panel-title">Asignaciones diarias</h1>

        <div className="form-section">
          <h2 className="section-title">Turno de hoy: {AdminService.getTodayDateString()}</h2>

          <p className="label">1. Seleccione conductor</p>
          <div className="selector-grid">
            {choferes.map(c => (
              <button
                key={c.dni}
                className={`chip ${selectedChofer === c.dni ? 'chip-selected' : ''}`}
                onClick={() => setSelectedChofer(c.dni)}
              >
                {c.nombre} {c.apellidos}
              </button>
            ))}
            {choferes.length === 0 && (
              <p className="empty-text">No hay conductores activos.</p>
            )}
          </div>

          <p className="label">2. Seleccione vehículo</p>
          <div className="selector-grid">
            {buses.map(b => (
              <button
                key={b.placa}
                className={`chip ${selectedBus === b.placa ? 'chip-selected' : ''}`}
                onClick={() => setSelectedBus(b.placa)}
              >
                {b.placa}
              </button>
            ))}
            {buses.length === 0 && (
              <p className="empty-text">No hay buses activos.</p>
            )}
          </div>

          <button
            className="form-button"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Asignando…' : 'Crear Asignación'}
          </button>
          {mensaje && <p className={`form-message ${mensaje.tipo}`}>{mensaje.texto}</p>}
        </div>

        <h2 className="section-title">Asignaciones activas</h2>
        {asignaciones.length === 0 ? (
          <p className="empty-text">Nadie está manejando en este momento.</p>
        ) : (
          <ul className="list">
            {asignaciones.map(item => {
              const choferNombre =
                choferes.find(c => c.dni === item.choferId)?.nombre || item.choferId;
              return (
                <li key={item.id} className="card">
                  <div className="card-info">
                    <p className="card-title">{choferNombre}</p>
                    <p className="card-subtitle">Bus asignado: {item.busId}</p>
                    {!!item.createdAt && (
                      <p className="card-subtitle">Creada: {formatCreatedAt(item.createdAt)}</p>
                    )}
                  </div>
                  <button
                    className="cancel-button"
                    onClick={() => handleCancel(item.id)}
                  >
                    Cancelar
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};