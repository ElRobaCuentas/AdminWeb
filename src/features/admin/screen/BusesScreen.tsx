import { useEffect, useState } from 'react';
import { AdminService, type Bus, type Administrador } from '../services/admin_service';
import { resolveAdminName, formatDate } from '../../../shared/utils/format';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
import { Icon } from '../../../shared/ui/Icon';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { ToggleSwitch } from '../../../shared/ui/ToggleSwitch';
import { EmptyState } from '../../../shared/ui/Feedback';
import { ConfirmDialog } from '../../../shared/ui/Modal';
import { useToast } from '../../../shared/ui/toastContext';

export const BusesScreen = () => {
  const toast = useToast();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [admins, setAdmins] = useState<Administrador[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [placa, setPlaca] = useState('');

  const [toggleTarget, setToggleTarget] = useState<{ bus: Bus; next: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToBuses(data => {
      setBuses(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = AdminService.subscribeToAdministradores(setAdmins);
    return () => unsubscribe();
  }, []);

  const handleCreate = async () => {
    if (!placa) {
      toast.error('La placa es obligatoria.');
      return;
    }
    if (placa.trim().length < 6) {
      toast.error('Ingresa una placa válida.');
      return;
    }

    setCreating(true);
    try {
      await AdminService.createBus({ placa: placa.toUpperCase().trim() });
      toast.success('Bus registrado correctamente en la flota.');
      setPlaca('');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async () => {
    if (!toggleTarget) return;
    setBusy(true);
    const { bus, next } = toggleTarget;
    const ok = await AdminService.toggleBusStatus(bus.placa, next);
    setBusy(false);
    setToggleTarget(null);
    if (ok) {
      toast.success(next ? 'Bus activado.' : 'Bus desactivado.');
    } else {
      toast.error(`No se pudo ${next ? 'activar' : 'desactivar'} el bus.`);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const bus = deleteTarget;
    setBusy(true);
    try {
      const tieneAsignacion = await AdminService.hasActiveBusAssignment(bus.placa);
      if (tieneAsignacion) {
        toast.error('Este bus tiene una asignación activa. Cancela la asignación primero.');
        return;
      }
      await AdminService.deleteBus(bus.placa);
      toast.success(`Bus ${bus.placa} eliminado correctamente.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Registrar nuevo bus" description="La placa se guardará en mayúsculas." />
        <div className="card-body">
          <Field
            id="bus-placa"
            label="Placa (Ej: AHK-452)"
            placeholder="AHK-452"
            style={{ textTransform: 'uppercase' }}
            value={placa}
            onChange={e => setPlaca(e.target.value)}
          />
          <Button onClick={handleCreate} disabled={creating} icon={<Icon name="plus" size={16} />}>
            {creating ? 'Registrando…' : 'Registrar bus'}
          </Button>
        </div>
      </Card>

      <section>
        <h2 className="section-title">
          Flota registrada{' '}
          {buses.length > 0 ? <span className="badge badge-info">{buses.length}</span> : null}
        </h2>

        {loading ? (
          <p className="text-muted">Cargando buses…</p>
        ) : buses.length === 0 ? (
          <EmptyState
            icon={<Icon name="bus" size={32} />}
            title="No hay buses registrados"
            hint="Registra el primero con el formulario de arriba."
          />
        ) : (
          <ul className="list">
            {buses.map(item => (
              <li key={item.placa} className="row-card">
                <div className="row-info">
                  <div className="row-title">{item.placa}</div>
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
                    label={`${item.activo ? 'Desactivar' : 'Activar'} el bus ${item.placa}`}
                    onChange={next => setToggleTarget({ bus: item, next })}
                  />
                  <button
                    type="button"
                    className="btn btn-icon btn-icon-danger"
                    title="Eliminar"
                    aria-label={`Eliminar el bus ${item.placa}`}
                    onClick={() => setDeleteTarget(item)}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={toggleTarget !== null}
        title={toggleTarget?.next ? 'Activar bus' : 'Desactivar bus'}
        message={`¿Deseas ${toggleTarget?.next ? 'activar' : 'desactivar'} el bus ${toggleTarget?.bus.placa}?`}
        confirmLabel={toggleTarget?.next ? 'Activar' : 'Desactivar'}
        danger={!toggleTarget?.next}
        busy={busy}
        onConfirm={handleToggle}
        onCancel={() => setToggleTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Eliminar bus"
        message={`¿Eliminar el bus ${deleteTarget?.placa}? Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        danger
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
