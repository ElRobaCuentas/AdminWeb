import { useEffect, useState } from 'react';
import {
  AdminService, type Asignacion, type Bus, type Chofer,
} from '../services/admin_service';
import { Card, CardHeader } from '../../../shared/ui/Card';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
import { Icon } from '../../../shared/ui/Icon';
import { EmptyState } from '../../../shared/ui/Feedback';
import { ConfirmDialog, Modal } from '../../../shared/ui/Modal';
import { useToast } from '../../../shared/ui/toastContext';
import {
  formatCalendarDate, isDateOnOrAfter, isValidDateString,
} from '../../../shared/utils/date';
import { TurnosEditor } from '../components/TurnosEditor';
import {
  formatCreatedAt, formatHora, getTurnos, parseTurnos, type Turno,
} from '../utils/turno';
import { createTurnoDraft, type TurnoDraft } from '../utils/turnoDraft';

export const AsignacionesScreen = () => {
  const toast = useToast();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [selectedFecha, setSelectedFecha] = useState(() => AdminService.getTodayDateString());
  const [selectedChofer, setSelectedChofer] = useState<string | null>(null);
  const [selectedBus, setSelectedBus] = useState<string | null>(null);
  const [createTurnos, setCreateTurnos] = useState<TurnoDraft[]>(() => [createTurnoDraft()]);

  const [cancelTarget, setCancelTarget] = useState<Asignacion | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [turnosModal, setTurnosModal] = useState<{
    asignacion: Asignacion;
    mode: 'add' | 'edit';
  } | null>(null);
  const [editTurnos, setEditTurnos] = useState<TurnoDraft[]>([]);
  const [savingTurnos, setSavingTurnos] = useState(false);

  const today = AdminService.getTodayDateString();
  const choferesActivos = choferes.filter(c => c.activo);

  useEffect(() => {
    const unsubChoferes = AdminService.subscribeToChoferes(setChoferes);
    const unsubBuses = AdminService.subscribeToBuses(data => {
      setBuses(data.filter(b => b.activo));
    });

    return () => {
      unsubChoferes();
      unsubBuses();
    };
  }, []);

  useEffect(() => {
    if (!isValidDateString(selectedFecha)) {
      setAsignaciones([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubAsignaciones = AdminService.subscribeToAsignacionesPorFecha(
      selectedFecha,
      data => {
        setAsignaciones(data);
        setLoading(false);
      },
    );

    return () => unsubAsignaciones();
  }, [selectedFecha]);

  const handleCreate = async () => {
    if (!selectedChofer || !selectedBus) {
      toast.error('Selecciona un conductor y un bus.');
      return;
    }

    const fecha = selectedFecha.trim();
    if (!isValidDateString(fecha)) {
      toast.error('Selecciona una fecha válida.');
      return;
    }
    if (!isDateOnOrAfter(fecha, today)) {
      toast.error('La fecha no puede ser anterior a hoy.');
      return;
    }

    const { turnos, error: turnosError } = parseTurnos(createTurnos);
    if (turnosError) {
      toast.error(turnosError);
      return;
    }

    setCreating(true);
    try {
      await AdminService.createAsignacion(selectedChofer, selectedBus, fecha, turnos);
      toast.success(`Asignación creada para el ${formatCalendarDate(fecha)}.`);
      setSelectedChofer(null);
      setSelectedBus(null);
      setCreateTurnos([createTurnoDraft()]);
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

  const draftsFromTurnos = (turnos: Turno[]): TurnoDraft[] =>
    turnos.map(turno => createTurnoDraft(formatHora(turno.inicio), formatHora(turno.fin)));

  const openTurnosModal = (asignacion: Asignacion, mode: 'add' | 'edit') => {
    const existingDrafts = draftsFromTurnos(getTurnos(asignacion));
    const baseDrafts = existingDrafts.length > 0 ? existingDrafts : [createTurnoDraft()];

    setTurnosModal({ asignacion, mode });
    setEditTurnos(mode === 'add' && existingDrafts.length > 0
      ? [...baseDrafts, createTurnoDraft()]
      : baseDrafts);
  };

  const closeTurnosModal = () => {
    if (savingTurnos) return;
    setTurnosModal(null);
    setEditTurnos([]);
  };

  const handleSaveTurnos = async () => {
    if (!turnosModal) return;

    const { turnos, error: validationError } = parseTurnos(editTurnos);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSavingTurnos(true);
    try {
      await AdminService.updateTurnos(turnosModal.asignacion.id, turnos);
      toast.success('Turnos actualizados.');
      setTurnosModal(null);
      setEditTurnos([]);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingTurnos(false);
    }
  };

  const cancelChoferNombre = cancelTarget
    ? choferes.find(c => c.dni === cancelTarget.choferId)?.nombre || cancelTarget.choferId
    : '';

  const turnosChoferNombre = turnosModal
    ? choferes.find(c => c.dni === turnosModal.asignacion.choferId)?.nombre
      || turnosModal.asignacion.choferId
    : '';

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title="Programar asignación"
          description="Elige la fecha, el conductor, el vehículo y uno o más turnos. La fecha y los horarios se interpretan en America/Lima."
        />
        <div className="card-body">
          <div className="steps">
            <div>
              <div className="step-label">
                <span className="step-num">1</span> Fecha
              </div>
              <Field
                id="fecha-asignacion"
                label="Fecha de la asignación"
                type="date"
                min={today}
                value={selectedFecha}
                onChange={e => setSelectedFecha(e.target.value)}
                hint="Día calendario Lima: de 00:00 a 00:00 del día siguiente. Duración: 24h"
              />
            </div>

            <div>
              <div className="step-label">
                <span className="step-num">2</span> Conductor
              </div>
              {choferesActivos.length === 0 ? (
                <p className="text-muted">No hay conductores activos.</p>
              ) : (
                <div className="chip-grid">
                  {choferesActivos.map(c => (
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
                <span className="step-num">3</span> Vehículo
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
                <span className="step-num">4</span> Turnos informativos
              </div>
              <TurnosEditor
                idPrefix="crear-turnos"
                value={createTurnos}
                onChange={setCreateTurnos}
                disabled={creating}
              />
            </div>
          </div>

          <Button onClick={handleCreate} disabled={creating} icon={<Icon name="plus" size={16} />}>
            {creating ? 'Asignando…' : 'Crear asignación'}
          </Button>
        </div>
      </Card>

      <section>
        <h2 className="section-title">
          Asignaciones activas{selectedFecha ? ` del ${formatCalendarDate(selectedFecha)}` : ''}{' '}
          {asignaciones.length > 0 ? <span className="badge badge-info">{asignaciones.length}</span> : null}
        </h2>

        {loading ? (
          <p className="text-muted">Cargando asignaciones…</p>
        ) : asignaciones.length === 0 ? (
          <EmptyState
            icon={<Icon name="assignment" size={32} />}
            title={selectedFecha
              ? 'No hay asignaciones activas para esta fecha'
              : 'Selecciona una fecha'}
            hint="Crea una asignación con el formulario de arriba."
          />
        ) : (
          <ul className="list">
            {asignaciones.map(item => {
              const choferNombre =
                choferes.find(c => c.dni === item.choferId)?.nombre || item.choferId;
              const turnos = getTurnos(item);
              const turnosLabel = turnos.length === 1 ? 'turno activo' : 'turnos activos';
              return (
                <li key={item.id} className="row-card assignment-row">
                  <div className="row-info">
                    <div className="row-title">{choferNombre}</div>
                    <div className="row-meta">Bus asignado: {item.busId}</div>
                    {turnos.length > 0 ? (
                      <div className="turnos-list">
                        {turnos.map((turno, index) => (
                          <div className="row-sub" key={`${item.id}-${index}`}>
                            Turno {index + 1}: {formatHora(turno.inicio)} – {formatHora(turno.fin)}
                          </div>
                        ))}
                        <div className="turno-summary">
                          Asignación única · {turnos.length} {turnosLabel}
                        </div>
                      </div>
                    ) : (
                      <div className="row-sub">Sin turnos definidos</div>
                    )}
                    {item.createdAt ? (
                      <div className="row-sub">Creada {formatCreatedAt(item.createdAt)}</div>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openTurnosModal(item, 'add')}
                      icon={<Icon name="plus" size={15} />}
                    >
                      Añadir turno
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openTurnosModal(item, 'edit')}
                      icon={<Icon name="edit" size={15} />}
                    >
                      Editar turnos
                    </Button>
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
        message={`¿Cancelar la asignación de ${cancelChoferNombre} con el bus ${cancelTarget?.busId ?? ''} para el ${cancelTarget ? formatCalendarDate(cancelTarget.fecha) : ''}?`}
        confirmLabel="Cancelar asignación"
        cancelLabel="Volver"
        danger
        busy={cancelling}
        onConfirm={handleCancel}
        onCancel={() => setCancelTarget(null)}
      />

      <Modal
        open={turnosModal !== null}
        title={turnosModal?.mode === 'add' ? 'Añadir turno' : 'Editar turnos'}
        onClose={closeTurnosModal}
        footer={
          <>
            <Button variant="secondary" onClick={closeTurnosModal} disabled={savingTurnos}>
              Cancelar
            </Button>
            <Button onClick={handleSaveTurnos} disabled={savingTurnos}>
              {savingTurnos ? 'Guardando…' : 'Guardar turnos'}
            </Button>
          </>
        }
      >
        {turnosModal ? (
          <div className="turnos-modal">
            <p className="text-muted">
              {turnosChoferNombre} · Bus {turnosModal.asignacion.busId} ·{' '}
              {formatCalendarDate(turnosModal.asignacion.fecha)}
            </p>
            <TurnosEditor
              idPrefix="editar-turnos"
              value={editTurnos}
              onChange={setEditTurnos}
              disabled={savingTurnos}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
};
