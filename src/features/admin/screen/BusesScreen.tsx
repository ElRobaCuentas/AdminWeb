import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminService, type Bus } from '../services/admin_service';

interface Mensaje {
  tipo: 'exito' | 'error';
  texto: string;
}

export const BusesScreen = () => {
  const navigate = useNavigate();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  const [placa, setPlaca] = useState('');
  const [marca, setMarca] = useState('');
  const [modelo, setModelo] = useState('');
  const [anio, setAnio] = useState('');

  // 1. Cargar buses en tiempo real
  useEffect(() => {
    const unsubscribe = AdminService.subscribeToBuses(data => {
      setBuses(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. Manejar Creación
  const handleCreate = async () => {
    setMensaje(null);
    if (!placa || !modelo || !marca || !anio) {
      setMensaje({ tipo: 'error', texto: 'Todos los campos son obligatorios' });
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
        modelo: modelo.trim(),
        marca: marca.trim(),
        anio: anio.trim(),
      });
      setMensaje({ tipo: 'exito', texto: 'Bus registrado correctamente en la flota.' });
      setPlaca('');
      setMarca('');
      setModelo('');
      setAnio('');
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setCreating(false);
    }
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
          <div className="form-group">
            <label className="form-label" htmlFor="bus-marca">Marca (Ej: Mercedes-Benz)</label>
            <input
              id="bus-marca"
              className="form-input"
              placeholder="Mercedes-Benz"
              value={marca}
              onChange={e => setMarca(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="bus-modelo">Modelo (Ej: Sprinter)</label>
            <input
              id="bus-modelo"
              className="form-input"
              placeholder="Sprinter"
              value={modelo}
              onChange={e => setModelo(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="bus-anio">Año (Ej: 2022)</label>
            <input
              id="bus-anio"
              className="form-input"
              placeholder="2022"
              inputMode="numeric"
              maxLength={4}
              value={anio}
              onChange={e => setAnio(e.target.value)}
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
                  <p className="card-subtitle">{item.marca} {item.modelo} - {item.anio}</p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Activo: ${item.placa}`}
                  checked={item.activo}
                  onChange={e => {
                    const accion = item.activo ? 'desactivar' : 'activar';
                    if (window.confirm(`¿Estás seguro que querés ${accion} el bus ${item.placa}?`)) {
                      AdminService.toggleBusStatus(item.placa, e.target.checked);
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};