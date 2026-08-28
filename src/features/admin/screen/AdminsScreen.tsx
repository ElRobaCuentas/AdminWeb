import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { AdminService, type Administrador } from '../services/admin_service';

interface Mensaje {
  tipo: 'exito' | 'error';
  texto: string;
}

export const AdminsScreen = () => {
  const navigate = useNavigate();
  const [admins, setAdmins] = useState<Administrador[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  const [dni, setDni] = useState('');
  const [nombres, setNombres] = useState('');
  const [apellidos, setApellidos] = useState('');
  const [password, setPassword] = useState('');

  // Estados para edición
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editNombres, setEditNombres] = useState('');
  const [editApellidos, setEditApellidos] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToAdministradores(data => {
      setAdmins(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleCrear = async () => {
    setMensaje(null);

    if (dni.trim().length < 8) {
      setMensaje({ tipo: 'error', texto: 'DNI inválido (mínimo 8 dígitos).' });
      return;
    }
    if (!nombres.trim()) {
      setMensaje({ tipo: 'error', texto: 'Ingresa los nombres del administrador.' });
      return;
    }
    if (!apellidos.trim()) {
      setMensaje({ tipo: 'error', texto: 'Ingresa los apellidos del administrador.' });
      return;
    }
    if (password.trim().length < 6) {
      setMensaje({ tipo: 'error', texto: 'La contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    setCreating(true);
    try {
      await AdminService.createAdmin(dni.trim(), nombres.trim(), apellidos.trim(), password.trim());
      setMensaje({ tipo: 'exito', texto: 'Administrador creado correctamente.' });
      setDni('');
      setNombres('');
      setApellidos('');
      setPassword('');
    } catch (err: any) {
      setMensaje({ tipo: 'error', texto: err.message || 'Error al crear administrador.' });
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editingUid || !editNombres || !editApellidos) return;
    setSaving(true);
    try {
      await AdminService.updateAdmin(editingUid, { nombres: editNombres, apellidos: editApellidos });
      setEditingUid(null);
      setMensaje({ tipo: 'exito', texto: 'Administrador actualizado correctamente.' });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (admin: Administrador) => {
    setMensaje(null);
    if (!window.confirm(`¿Eliminar al administrador ${nombreCompleto(admin)}? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await AdminService.deleteAdmin(admin.uid);
      setMensaje({ tipo: 'exito', texto: `Administrador ${nombreCompleto(admin)} eliminado correctamente.` });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: (error as Error).message });
    }
  };

  if (loading) {
    return <div className="screen">Cargando administradores…</div>;
  }

  const nombreCreador = (uid: string): string => {
    const creador = admins.find(a => a.uid === uid);
    if (!creador) return 'Admin eliminado';
    return `${creador.nombres || ''} ${creador.apellidos || ''}`.trim() || 'Admin eliminado';
  };

  return (
    <div className="screen screen-scroll">
      <div className="panel panel-wide">
        <button className="back-button" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1 className="panel-title">Gestión de administradores</h1>

        <div className="form-section">
          <h2 className="section-title">Registrar nuevo administrador</h2>
          <div className="form-group">
            <label className="form-label" htmlFor="admin-dni">DNI</label>
            <input
              id="admin-dni"
              className="form-input"
              maxLength={12}
              value={dni}
              onChange={e => setDni(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="admin-nombre">Nombres</label>
            <input
              id="admin-nombre"
              className="form-input"
              value={nombres}
              onChange={e => setNombres(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="admin-apellidos">Apellidos</label>
            <input
              id="admin-apellidos"
              className="form-input"
              value={apellidos}
              onChange={e => setApellidos(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="admin-password">Contraseña</label>
            <input
              id="admin-password"
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          <button
            className="form-button"
            onClick={handleCrear}
            disabled={creating}
          >
            {creating ? 'Creando…' : 'Crear administrador'}
          </button>
          {mensaje && <p className={`form-message ${mensaje.tipo}`}>{mensaje.texto}</p>}
        </div>

        <h2 className="section-title">Administradores registrados</h2>
        {admins.length === 0 ? (
          <p className="empty-text">No hay administradores registrados aún.</p>
        ) : (
          <ul className="list">
            {admins.map(item => (
              <li key={item.uid} className="card">
                {editingUid === item.uid ? (
                  <div className="card-edit-form">
                    <div className="form-group">
                      <label className="form-label">Nombres</label>
                      <input
                        className="form-input"
                        value={editNombres}
                        onChange={e => setEditNombres(e.target.value)}
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
                      <button className="form-button-sm form-button-cancel" onClick={() => setEditingUid(null)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="card-info">
                      <p className="card-title">{nombreCompleto(item)}</p>
                      {item.dni && <p className="card-subtitle">DNI: {item.dni}</p>}
                      {item.correo && <p className="card-subtitle">Correo: {item.correo}</p>}
                      {item.creadoPor && (
                        <p className="card-subtitle">Creado por: {nombreCreador(item.creadoPor)}</p>
                      )}
                      {item.creadoEn && (
                        <p className="card-subtitle">
                          Creado el: {new Date(item.creadoEn).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="card-actions">
                      <button
                        className="icon-button"
                        title="Editar"
                        onClick={() => {
                          setEditingUid(item.uid);
                          setEditNombres(item.nombres || '');
                          setEditApellidos(item.apellidos || '');
                        }}
                      >
                        ✏️
                      </button>
                      {item.uid !== getAuth().currentUser?.uid && (
                        <button
                          className="icon-button icon-button-danger"
                          title="Eliminar"
                          onClick={() => handleDelete(item)}
                        >
                          🗑️
                        </button>
                      )}
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

const nombreCompleto = (admin: Administrador): string =>
  `${admin.nombres || ''} ${admin.apellidos || ''}`.trim();
