import { useEffect, useState } from 'react';
import {
  AdminService, type Asignacion, type Bus, type Chofer,
} from '../services/admin_service';
import { Field } from '../../../shared/ui/Field';
import { Button } from '../../../shared/ui/Button';
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

const nombreChofer = (chofer?: Chofer) =>
  chofer ? `${chofer.nombre} ${chofer.apellidos}`.trim() : '';

export const AsignacionesScreen = () => {
  const toast = useToast();
  const today = AdminService.getTodayDateString();

  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedFecha, setSelectedFecha] = useState(today);
  const [createFecha, setCreateFecha] = useState(today);
  const [selectedChofer, setSelectedChofer] = useState<string | null>(null);
  const [selectedBus, setSelectedBus] = useState<string | null>(null);
  const [createTurnos, setCreateTurnos] = useState<TurnoDraft[]>(() => [createTurnoDraft()]);
  const [creating, setCreating] = useState(false);

  const [editTarget, setEditTarget] = useState<Asignacion | null>(null);
  const [editTurnos, setEditTurnos] = useState<TurnoDraft[]>([]);
  const [savingTurnos, setSavingTurnos] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<Asignacion | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const choferesActivos = choferes.filter(c => c.activo);
  const fechaValida = isValidDateString(selectedFecha);
  const heading = !fechaValida
    ? 'Asignaciones'
    : selectedFecha === today
      ? 'Asignaciones de hoy'
      : `Asignaciones del ${formatCalendarDate(selectedFecha)}`;

  const choferNombre = (dni: string) =>
    nombreChofer(choferes.find(c => c.dni === dni)) || dni;

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

    const fecha = createFecha.trim();
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
      toast.success('Asignación creada.');
      setSelectedFecha(fecha);
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

  const openEdit = (asignacion: Asignacion) => {
    const existingDrafts = draftsFromTurnos(getTurnos(asignacion));
    setEditTarget(asignacion);
    setEditTurnos(existingDrafts.length > 0 ? existingDrafts : [createTurnoDraft()]);
  };

  const closeEdit = () => {
    if (savingTurnos) return;
    setEditTarget(null);
    setEditTurnos([]);
  };

  const handleSaveTurnos = async () => {
    if (!editTarget) return;

    const { turnos, error: validationError } = parseTurnos(editTurnos);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSavingTurnos(true);
    try {
      await AdminService.updateTurnos(editTarget.id, turnos);
      toast.success('Horarios actualizados.');
      setEditTarget(null);
      setEditTurnos([]);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingTurnos(false);
    }
  };

  const cancelNombre = cancelTarget ? choferNombre(cancelTarget.choferId) : '';
  const editNombre = editTarget ? choferNombre(editTarget.choferId) : '';

  return (
    <div className="stack">
      <section className="screen-toolbar">
        <div className="screen-toolbar-heading">
          <h2 className="screen-title" id="asignaciones-title">{heading}</h2>
          {asignaciones.length > 0 ? (
            <span className="badge-count">{asignaciones.length}</span>
          ) : null}
        </div>
        <div className="screen-toolbar-actions">
          <input
            aria-label="Fecha de las asignaciones"
            className="field-input date-input"
            type="date"
            min={today}
            value={selectedFecha}
            onChange={event => setSelectedFecha(event.target.value)}
          />
          {selectedFecha !== today ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm date-today"
              onClick={() => setSelectedFecha(today)}
            >
              Hoy
            </button>
          ) : null}
        </div>
      </section>

      {loading ? (
        <p className="text-muted">Cargando asignaciones.</p>
      ) : asignaciones.length === 0 ? (
        <div className="board">
          <div className="board-empty">
            <strong>{fechaValida ? 'No hay asignaciones para este día.' : 'Selecciona una fecha.'}</strong>
          </div>
        </div>
      ) : (
        <section className="board" aria-labelledby="asignaciones-title">
          <ul className="board-list">
            {asignaciones.map((item, index) => {
              const turnos = getTurnos(item);
              return (
                <li
                  className="board-row"
                  key={item.id}
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                >
                  <div className="board-time">
                    {turnos.length ? turnos.map((turno, turnoIndex) => (
                      <div key={`${turno.inicio}-${turno.fin}`}>
                        {formatHora(turno.inicio)} - {formatHora(turno.fin)}
                        {turnos.length > 1 ? <small> (Horario {turnoIndex + 1})</small> : null}
                      </div>
                    )) : 'Sin horario'}
                  </div>
                  <span className="plate plate-sm board-bus">{item.busId}</span>
                  <div className="board-driver">
                    {choferNombre(item.choferId)}
                    {typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? (
                      <small>Creada {formatCreatedAt(item.createdAt)}</small>
                    ) : <small>Fecha de creación no disponible</small>}
                  </div>
                  <div className="board-actions">
                    <button
                      type="button"
                      className="board-action"
                      onClick={() => openEdit(item)}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="board-action board-action-danger"
                      onClick={() => setCancelTarget(item)}
                    >
                      Cancelar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="assignment-form card" aria-labelledby="create-assignment-title">
        <div className="card-header"><h2 id="create-assignment-title">Crear asignación</h2></div>
        <div className="card-body">
        <div className="steps">
          <div>
            <div className="step-label">
              <span className="step-num">1</span> ¿Qué día?
            </div>
            <Field
              id="crear-fecha"
              label="Fecha"
              type="date"
              min={today}
              value={createFecha}
              disabled={creating}
              onChange={event => setCreateFecha(event.target.value)}
              hint="Hoy o una fecha futura."
            />
          </div>

          <div>
            <div className="step-label">
              <span className="step-num">2</span> ¿Quién conduce?
            </div>
            {choferesActivos.length === 0 ? (
              <p className="text-muted">No hay conductores activos.</p>
            ) : (
              <div className="chip-grid">
                {choferesActivos.map(c => (
                  <button
                    key={c.dni}
                    type="button"
                    aria-pressed={selectedChofer === c.dni}
                    disabled={creating}
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
              <span className="step-num">3</span> ¿Qué bus?
            </div>
            {buses.length === 0 ? (
              <p className="text-muted">No hay buses activos.</p>
            ) : (
              <div className="chip-grid">
                {buses.map(b => (
                  <button
                    key={b.placa}
                    type="button"
                    aria-pressed={selectedBus === b.placa}
                    disabled={creating}
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
              <span className="step-num">4</span> ¿A qué hora?
            </div>
            <TurnosEditor
              idPrefix="crear-horarios"
              value={createTurnos}
              onChange={setCreateTurnos}
              disabled={creating}
            />
          </div>
        </div>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? 'Creando…' : 'Crear asignación'}
          </Button>
        </div>
      </section>

      <Modal
        open={editTarget !== null}
        title="Editar asignación"
        onClose={closeEdit}
        footer={
          <>
            <Button variant="secondary" onClick={closeEdit} disabled={savingTurnos}>
              Cerrar
            </Button>
            <Button onClick={handleSaveTurnos} disabled={savingTurnos}>
              {savingTurnos ? 'Guardando…' : 'Guardar'}
            </Button>
          </>
        }
      >
        {editTarget ? (
          <div className="turnos-modal">
            <p className="text-muted">
              {editNombre} · Bus {editTarget.busId} · {formatCalendarDate(editTarget.fecha)}
            </p>
            <TurnosEditor
              idPrefix="editar-horarios"
              value={editTurnos}
              onChange={setEditTurnos}
              disabled={savingTurnos}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancelar asignación"
        message={`¿Cancelar la asignación de ${cancelNombre} con el bus ${cancelTarget?.busId ?? ''} del ${cancelTarget ? formatCalendarDate(cancelTarget.fecha) : ''}?`}
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
