import { useEffect, useState } from 'react';
import { AdminService, type Chofer, type Administrador } from '../services/admin_service';
import { isValidDni, normalizeDni, sanitizeDniInput } from '../../../shared/utils/dni';
import { resolveAdminName, formatDate } from '../../../shared/utils/format';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
import { Icon } from '../../../shared/ui/Icon';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { ToggleSwitch } from '../../../shared/ui/ToggleSwitch';
import { EmptyState } from '../../../shared/ui/Feedback';
import { Modal, ConfirmDialog } from '../../../shared/ui/Modal';
import { useToast } from '../../../shared/ui/toastContext';

export const ChoferesScreen = () => {
  const toast = useToast();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [admins, setAdmins] = useState<Administrador[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [dni, setDni] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellidos, setApellidos] = useState('');

  const [editing, setEditing] = useState<Chofer | null>(null);
  const [editNombre, setEditNombre] = useState('');
  const [editApellidos, setEditApellidos] = useState('');
  const [saving, setSaving] = useState(false);

  const [toggleTarget, setToggleTarget] = useState<{ chofer: Chofer; next: boolean } | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToChoferes(data => {
      setChoferes(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToAdministradores(setAdmins);
    return () => unsubscribe();
  }, []);

  const handleCreate = async () => {
    if (!dni || !nombre || !apellidos) {
      toast.error('Todos los campos son obligatorios.');
      return;
    }
    const dniNormalizado = normalizeDni(dni);
    if (!isValidDni(dniNormalizado)) {
      toast.error('El DNI debe tener 8 dígitos numéricos.');
      return;
    }

    setCreating(true);
    try {
      await AdminService.createChofer({ dni: dniNormalizado, nombre, apellidos });
      toast.success('Conductor registrado. Su clave inicial es su DNI.');
      setDni('');
      setNombre('');
      setApellidos('');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (item: Chofer) => {
    setEditing(item);
    setEditNombre(item.nombre);
    setEditApellidos(item.apellidos);
  };

  const handleEdit = async () => {
    if (!editing || !editNombre || !editApellidos) return;
    setSaving(true);
    try {
      await AdminService.updateChofer(editing.dni, { nombre: editNombre, apellidos: editApellidos });
      setEditing(null);
      toast.success('Conductor actualizado correctamente.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!toggleTarget) return;
    setToggling(true);
    const { chofer, next } = toggleTarget;
    const ok = await AdminService.toggleChoferStatus(chofer.dni, next);
    setToggling(false);
    setToggleTarget(null);
    if (ok) {
      toast.success(next ? 'Conductor activado.' : 'Conductor desactivado.');
    } else {
      toast.error(`No se pudo ${next ? 'activar' : 'desactivar'} al conductor.`);
    }
  };

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Registrar nuevo conductor" description="Su contraseña inicial será su DNI." />
        <div className="card-body">
          <Field
            id="chofer-dni"
            label="DNI"
            inputMode="numeric"
            maxLength={8}
            value={dni}
            onChange={e => setDni(sanitizeDniInput(e.target.value))}
          />
          <Field
            id="chofer-nombre"
            label="Nombres"
            value={nombre}
            onChange={e => setNombre(e.target.value)}
          />
          <Field
            id="chofer-apellidos"
            label="Apellidos"
            value={apellidos}
            onChange={e => setApellidos(e.target.value)}
          />
          <Button
            onClick={handleCreate}
            disabled={creating}
            icon={<Icon name="plus" size={16} />}
          >
            {creating ? 'Registrando…' : 'Registrar conductor'}
          </Button>
        </div>
      </Card>

      <section>
        <h2 className="section-title">
          Conductores registrados{' '}
          {choferes.length > 0 ? <span className="badge badge-info">{choferes.length}</span> : null}
        </h2>

        {loading ? (
          <p className="text-muted">Cargando conductores…</p>
        ) : choferes.length === 0 ? (
          <EmptyState
            icon={<Icon name="drivers" size={32} />}
            title="No hay conductores registrados"
            hint="Registra el primero con el formulario de arriba."
          />
        ) : (
          <ul className="list">
            {choferes.map(item => (
              <li key={item.dni} className="row-card">
                <div className="row-info">
                  <div className="row-title">
                    {item.nombre} {item.apellidos}
                  </div>
                  <div className="row-meta">DNI: {item.dni}</div>
                  {item.creadoEn ? (
                    <div className="row-sub">
                      Creado el {formatDate(item.creadoEn)}
                      {item.creadoPor ? ` · ${resolveAdminName(admins, item.creadoPor)}` : ''}
                    </div>
                  ) : null}
                </div>
                <div className="row-actions">
                  <StatusBadge active={item.activo} />
                  <ToggleSwitch
                    checked={item.activo}
                    label={`${item.activo ? 'Desactivar' : 'Activar'} a ${item.nombre} ${item.apellidos}`}
                    onChange={next => setToggleTarget({ chofer: item, next })}
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Editar"
                    aria-label={`Editar a ${item.nombre} ${item.apellidos}`}
                    onClick={() => openEdit(item)}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={editing !== null}
        title="Editar conductor"
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
          id="edit-chofer-nombre"
          label="Nombres"
          value={editNombre}
          onChange={e => setEditNombre(e.target.value)}
        />
        <Field
          id="edit-chofer-apellidos"
          label="Apellidos"
          value={editApellidos}
          onChange={e => setEditApellidos(e.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={toggleTarget !== null}
        title={toggleTarget?.next ? 'Activar conductor' : 'Desactivar conductor'}
        message={
          toggleTarget?.next
            ? `¿Deseas activar a ${toggleTarget.chofer.nombre} ${toggleTarget.chofer.apellidos}?`
            : `¿Deseas desactivar a ${toggleTarget?.chofer.nombre} ${toggleTarget?.chofer.apellidos}? Se conservará su cuenta y su historial, y podrás reactivarlo cuando quieras.`
        }
        confirmLabel={toggleTarget?.next ? 'Activar' : 'Desactivar'}
        danger={!toggleTarget?.next}
        busy={toggling}
        onConfirm={handleToggle}
        onCancel={() => setToggleTarget(null)}
      />
    </div>
  );
};
