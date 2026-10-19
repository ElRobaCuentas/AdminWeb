import { useEffect, useState } from 'react';
import {
  AdminService, type Asignacion, type Bus, type Chofer,
} from '../services/admin_service';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
import { Icon } from '../../../shared/ui/Icon';
import { EmptyState } from '../../../shared/ui/Feedback';
import { ConfirmDialog } from '../../../shared/ui/Modal';
import { useToast } from '../../../shared/ui/toastContext';
import { formatHora, formatCreatedAt, timeToMinutos } from '../utils/turno';

export const AsignacionesScreen = () => {
  const toast = useToast();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [selectedChofer, setSelectedChofer] = useState<string | null>(null);
  const [selectedBus, setSelectedBus] = useState<string | null>(null);
  const [horaInicio, setHoraInicio] = useState('');
  const [horaFin, setHoraFin] = useState('');

  const [cancelTarget, setCancelTarget] = useState<Asignacion | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const unsubChoferes = AdminService.subscribeToChoferes(data => {
      setChoferes(data.filter(c => c.activo));
    });
    const unsubBuses = AdminService.subscribeToBuses(data => {
      setBuses(data.filter(b => b.activo));
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
    if (!selectedChofer || !selectedBus) {
      toast.error('Selecciona un conductor y un bus.');
      return;
    }

    const inicio = timeToMinutos(horaInicio);
    const fin = timeToMinutos(horaFin);
    if (inicio === null || fin === null) {
      toast.error('Ingresa un horario válido para el turno.');
      return;
    }

    setCreating(true);
    try {
      await AdminService.createAsignacion(selectedChofer, selectedBus, inicio, fin);
      toast.success('Asignación creada para el turno de hoy.');
      setSelectedChofer(null);
      setSelectedBus(null);
      setHoraInicio('');
      setHoraFin('');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    const ok = await AdminService.cancelarAsignacion(cancelTarget.id);
    setCancelling(false);
    setCancelTarget(null);
    if (ok) {
      toast.success('Asignación cancelada.');
    } else {
      toast.error('No se pudo cancelar la asignación.');
    }
  };

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title={`Turno de hoy: ${AdminService.getTodayDateString()}`}
          description="Selecciona un conductor y un vehículo activo."
        />
        <div className="card-body">
          <div className="steps">
            <div>
              <div className="step-label">
                <span className="step-num">1</span> Conductor
              </div>
              {choferes.length === 0 ? (
                <p className="text-muted">No hay conductores activos.</p>
              ) : (
                <div className="chip-grid">
                  {choferes.map(c => (
                    <button
                      key={c.dni}
                      type="button"
                      className={['chip', selectedChofer === c.dni ? 'is-selected' : ''].filter(Boolean).join(' ')}
                      onClick={() => setSelectedChofer(c.dni)}
                    >
                      {c.nombre} {c.apellidos}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="step-label">
                <span className="step-num">2</span> Vehículo
              </div>
              {buses.length === 0 ? (
                <p className="text-muted">No hay buses activos.</p>
              ) : (
                <div className="chip-grid">
                  {buses.map(b => (
                    <button
                      key={b.placa}
                      type="button"
                      className={['chip', selectedBus === b.placa ? 'is-selected' : ''].filter(Boolean).join(' ')}
                      onClick={() => setSelectedBus(b.placa)}
                    >
                      {b.placa}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="step-label">
                <span className="step-num">3</span> Horario del turno
              </div>
              <div className="time-grid">
                <Field
                  id="hora-inicio"
                  label="Hora de inicio"
                  type="time"
                  value={horaInicio}
                  onChange={e => setHoraInicio(e.target.value)}
                />
                <Field
                  id="hora-fin"
                  label="Hora de fin"
                  type="time"
                  value={horaFin}
                  onChange={e => setHoraFin(e.target.value)}
                />
              </div>
            </div>
          </div>

          <Button onClick={handleCreate} disabled={creating} icon={<Icon name="plus" size={16} />}>
            {creating ? 'Asignando…' : 'Crear asignación'}
          </Button>
        </div>
      </Card>

      <section>
        <h2 className="section-title">
          Asignaciones activas{' '}
          {asignaciones.length > 0 ? <span className="badge badge-info">{asignaciones.length}</span> : null}
        </h2>

        {loading ? (
          <p className="text-muted">Cargando asignaciones…</p>
        ) : asignaciones.length === 0 ? (
          <EmptyState
            icon={<Icon name="assignment" size={32} />}
            title="Nadie está manejando en este momento"
            hint="Crea una asignación con el formulario de arriba."
          />
        ) : (
          <ul className="list">
            {asignaciones.map(item => {
              const choferNombre =
                choferes.find(c => c.dni === item.choferId)?.nombre || item.choferId;
              return (
                <li key={item.id} className="row-card">
                  <div className="row-info">
                    <div className="row-title">{choferNombre}</div>
                    <div className="row-meta">Bus asignado: {item.busId}</div>
                    {item.horaInicio !== undefined && item.horaFin !== undefined ? (
                      <div className="row-sub">
                        Turno {formatHora(item.horaInicio)} – {formatHora(item.horaFin)}
                        {item.createdAt ? ` · Creada ${formatCreatedAt(item.createdAt)}` : ''}
                      </div>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setCancelTarget(item)}
                      icon={<Icon name="close" size={15} />}
                    >
                      Cancelar
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancelar asignación"
        message="¿El conductor dejará de manejar este bus hoy?"
        confirmLabel="Cancelar asignación"
        cancelLabel="Volver"
        danger
        busy={cancelling}
        onConfirm={handleCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
};
