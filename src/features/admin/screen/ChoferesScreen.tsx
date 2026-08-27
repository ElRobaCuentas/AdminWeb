import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminService, type Chofer } from '../services/admin_service';

interface Mensaje {
  tipo: 'exito' | 'error';
  texto: string;
}

export const ChoferesScreen = () => {
  const navigate = useNavigate();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  const [dni, setDni] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellidos, setApellidos] = useState('');

  // Estado para edición
  const [editingDni, setEditingDni] = useState<string | null>(null);
  const [editNombre, setEditNombre] = useState('');
  const [editApellidos, setEditApellidos] = useState('');
  const [saving, setSaving] = useState(false);

  // 1. Cargar choferes en tiempo real
  useEffect(() => {
    const unsubscribe = AdminService.subscribeToChoferes(data => {
      setChoferes(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. Manejar Creación
  const handleCreate = async () => {
    setMensaje(null);
    if (!dni || !nombre || !apellidos) {
      setMensaje({ tipo: 'error', texto: 'Todos los campos son obligatorios' });
      return;
    }
    if (dni.length < 8) {
      setMensaje({ tipo: 'error', texto: 'El DNI debe tener 8 dígitos' });
      return;
    }

    setCreating(true);
    try {
      await AdminService.createChofer({ dni, nombre, apellidos });
      setMensaje({ tipo: 'exito', texto: 'Chofer registrado correctamente. Su clave es su DNI.' });
      setDni('');
      setNombre('');
      setApellidos('');
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setCreating(false);
    }
  };

  // 3. Manejar Edición
  const handleEdit = async () => {
    if (!editingDni || !editNombre || !editApellidos) return;
    setSaving(true);
    try {
      await AdminService.updateChofer(editingDni, { nombre: editNombre, apellidos: editApellidos });
      setEditingDni(null);
      setMensaje({ tipo: 'exito', texto: 'Conductor actualizado correctamente.' });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  // 4. Manejar Eliminación
  const handleDelete = async (chofer: Chofer) => {
    setMensaje(null);
    const tieneAsignacion = await AdminService.hasActiveAssignment(chofer.dni);
    if (tieneAsignacion) {
      setMensaje({ tipo: 'error', texto: 'Este conductor tiene una asignación activa. Cancele la asignación primero.' });
      return;
    }
    if (!window.confirm(`¿Eliminar a ${chofer.nombre} ${chofer.apellidos}? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await AdminService.deleteChofer(chofer.dni);
      setMensaje({ tipo: 'exito', texto: `Conductor ${chofer.nombre} eliminado correctamente.` });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    }
  };

  if (loading) {
    return <div className="screen">Cargando choferes…</div>;
  }

  return (
    <div className="screen screen-scroll">
      <div className="panel panel-wide">
        <button className="back-button" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1 className="panel-title">Gestión de choferes</h1>

        <div className="form-section">
          <h2 className="section-title">Registrar nuevo chofer</h2>
          <div className="form-group">
            <label className="form-label" htmlFor="chofer-dni">DNI</label>
            <input
              id="chofer-dni"
              className="form-input"
              maxLength={8}
              value={dni}
              onChange={e => setDni(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="chofer-nombre">Nombres</label>
            <input
              id="chofer-nombre"
              className="form-input"
              value={nombre}
              onChange={e => setNombre(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="chofer-apellidos">Apellidos</label>
            <input
              id="chofer-apellidos"
              className="form-input"  
              value={apellidos}
              onChange={e => setApellidos(e.target.value)}
            />
          </div>
          <button
            className="form-button"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Registrando…' : 'Registrar Chofer'}
          </button>
          {mensaje && <p className={`form-message ${mensaje.tipo}`}>{mensaje.texto}</p>}
        </div>

        <h2 className="section-title">Conductores registrados</h2>
        {choferes.length === 0 ? (
          <p className="empty-text">No hay conductores registrados aún.</p>
        ) : (
          <ul className="list">
            {choferes.map(item => (
              <li key={item.dni} className="card">
                {editingDni === item.dni ? (
                  <div className="card-edit-form">
                    <div className="form-group">
                      <label className="form-label">Nombres</label>
                      <input
                        className="form-input"
                        value={editNombre}
                        onChange={e => setEditNombre(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Apellidos</label>
                      <input
                        className="form-input"
                        value={editApellidos}
                        onChange={e => setEditApellidos(e.target.value)}
                      />
                    </div>
                    <div className="card-actions-row">
                      <button className="form-button-sm" onClick={handleEdit} disabled={saving}>
                        {saving ? 'Guardando…' : 'Guardar'}
                      </button>
                      <button className="form-button-sm form-button-cancel" onClick={() => setEditingDni(null)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="card-info">
                      <p className="card-title">{item.nombre} {item.apellidos}</p>
                      <p className="card-subtitle">DNI: {item.dni}</p>
                    </div>
                    <div className="card-actions">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Activo: ${item.nombre} ${item.apellidos}`}
                        checked={item.activo}
                        onChange={() => {
                          const accion = item.activo ? 'desactivar' : 'activar';
                          if (window.confirm(`¿Estás seguro que querés ${accion} a ${item.nombre} ${item.apellidos}?`)) {
                            AdminService.toggleChoferStatus(item.dni, item.activo);
                          }
                        }}
                      />
                      <button
                        className="icon-button"
                        title="Editar"
                        onClick={() => {
                          setEditingDni(item.dni);
                          setEditNombre(item.nombre);
                          setEditApellidos(item.apellidos);
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        className="icon-button icon-button-danger"
                        title="Eliminar"
                        onClick={() => handleDelete(item)}
                      >
                        🗑️
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
