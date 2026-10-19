import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';
import { AdminService, type Administrador } from '../services/admin_service';
import { isValidDni, normalizeDni, sanitizeDniInput } from '../../../shared/utils/dni';
import { adminFullName } from '../../../shared/utils/format';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
import { Icon } from '../../../shared/ui/Icon';
import { EmptyState } from '../../../shared/ui/Feedback';
import { Modal, ConfirmDialog } from '../../../shared/ui/Modal';
import { useToast } from '../../../shared/ui/toastContext';

export const AdminsScreen = () => {
  const toast = useToast();
  const [admins, setAdmins] = useState<Administrador[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [dni, setDni] = useState('');
  const [nombres, setNombres] = useState('');
  const [apellidos, setApellidos] = useState('');
  const [password, setPassword] = useState('');

  const [editing, setEditing] = useState<Administrador | null>(null);
  const [editNombres, setEditNombres] = useState('');
  const [editApellidos, setEditApellidos] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Administrador | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToAdministradores(data => {
      setAdmins(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleCrear = async () => {
    const dniNormalizado = normalizeDni(dni);
    if (!isValidDni(dniNormalizado)) {
      toast.error('El DNI debe tener 8 dígitos numéricos.');
      return;
    }
    if (!nombres.trim() || !apellidos.trim()) {
      toast.error('Ingresa nombres y apellidos del administrador.');
      return;
    }
    if (password.trim().length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres.');
      return;
    }

    setCreating(true);
    try {
      await AdminService.createAdmin(dniNormalizado, nombres.trim(), apellidos.trim(), password.trim());
      toast.success('Administrador creado correctamente.');
      setDni('');
      setNombres('');
      setApellidos('');
      setPassword('');
    } catch (error) {
      toast.error((error as Error).message || 'Error al crear administrador.');
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (admin: Administrador) => {
    setEditing(admin);
    setEditNombres(admin.nombres || '');
    setEditApellidos(admin.apellidos || '');
  };

  const handleEdit = async () => {
    if (!editing || !editNombres || !editApellidos) return;
    setSaving(true);
    try {
      await AdminService.updateAdmin(editing.uid, { nombres: editNombres, apellidos: editApellidos });
      setEditing(null);
      toast.success('Administrador actualizado correctamente.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await AdminService.deleteAdmin(deleteTarget.uid);
      toast.success(`Administrador ${adminFullName(deleteTarget)} eliminado.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const nombreCreador = (uid: string): string => {
    const creador = admins.find(a => a.uid === uid);
    if (!creador) return 'Admin eliminado';
    return adminFullName(creador) || 'Admin eliminado';
  };

  const currentUid = getAuth().currentUser?.uid;

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title="Registrar nuevo administrador"
          description="Se crea la cuenta de acceso con correo {DNI}@admin.com."
        />
        <div className="card-body">
          <Field
            id="admin-dni"
            label="DNI"
            inputMode="numeric"
            maxLength={8}
            value={dni}
            onChange={e => setDni(sanitizeDniInput(e.target.value))}
          />
          <Field
            id="admin-nombre"
            label="Nombres"
            value={nombres}
            onChange={e => setNombres(e.target.value)}
          />
          <Field
            id="admin-apellidos"
            label="Apellidos"
            value={apellidos}
            onChange={e => setApellidos(e.target.value)}
          />
          <Field
            id="admin-password"
            label="Contraseña"
            type="password"
            hint="Mínimo 6 caracteres."
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <Button onClick={handleCrear} disabled={creating} icon={<Icon name="plus" size={16} />}>
            {creating ? 'Creando…' : 'Crear administrador'}
          </Button>
        </div>
      </Card>

      <section>
        <h2 className="section-title">
          Administradores registrados{' '}
          {admins.length > 0 ? <span className="badge badge-info">{admins.length}</span> : null}
        </h2>

        {loading ? (
          <p className="text-muted">Cargando administradores…</p>
        ) : admins.length === 0 ? (
          <EmptyState
            icon={<Icon name="admins" size={32} />}
            title="No hay administradores registrados"
          />
        ) : (
          <ul className="list">
            {admins.map(item => (
              <li key={item.uid} className="row-card">
                <div className="row-info">
                  <div className="row-title">
                    {adminFullName(item) || 'Administrador'}
                    {item.uid === currentUid ? (
                      <span className="badge badge-info" style={{ marginLeft: 8 }}>Tú</span>
                    ) : null}
                  </div>
                  {item.dni ? <div className="row-meta">DNI: {item.dni}</div> : null}
                  {item.correo ? <div className="row-sub">{item.correo}</div> : null}
                  {item.creadoPor ? (
                    <div className="row-sub">Creado por: {nombreCreador(item.creadoPor)}</div>
                  ) : null}
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Editar"
                    aria-label={`Editar a ${adminFullName(item)}`}
                    onClick={() => openEdit(item)}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                  {item.uid !== currentUid ? (
                    <button
                      type="button"
                      className="btn btn-icon btn-icon-danger"
                      title="Eliminar"
                      aria-label={`Eliminar a ${adminFullName(item)}`}
                      onClick={() => setDeleteTarget(item)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={editing !== null}
        title="Editar administrador"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </>
        }
      >
        <Field
          id="edit-admin-nombre"
          label="Nombres"
          value={editNombres}
          onChange={e => setEditNombres(e.target.value)}
        />
        <Field
          id="edit-admin-apellidos"
          label="Apellidos"
          value={editApellidos}
          onChange={e => setEditApellidos(e.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Eliminar administrador"
        message={`¿Eliminar a ${deleteTarget ? adminFullName(deleteTarget) : ''}? Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
