import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { Icon } from '../../../shared/ui/Icon';
import { createTurnoDraft, type TurnoDraft } from '../utils/turnoDraft';

interface TurnosEditorProps {
  idPrefix: string;
  value: TurnoDraft[];
  onChange: (turnos: TurnoDraft[]) => void;
  disabled?: boolean;
}

export const TurnosEditor = ({
  idPrefix, value, onChange, disabled = false,
}: TurnosEditorProps) => {
  const updateField = (id: string, field: 'inicio' | 'fin', newValue: string) => {
    onChange(value.map(turno => (
      turno.id === id ? { ...turno, [field]: newValue } : turno
    )));
  };

  const addTurno = () => {
    onChange([...value, createTurnoDraft()]);
  };

  const removeTurno = (id: string) => {
    if (value.length <= 1) return;
    onChange(value.filter(turno => turno.id !== id));
  };

  return (
    <div className="turnos-editor">
      {value.map((turno, index) => (
        <div className="turno-row" key={turno.id}>
          <div className="turno-row-header">
            <span className="turno-num">Turno {index + 1}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeTurno(turno.id)}
              disabled={disabled || value.length <= 1}
              title={value.length <= 1 ? 'La asignación debe tener al menos un turno' : undefined}
              aria-label={`Quitar turno ${index + 1}`}
              icon={<Icon name="trash" size={15} />}
            >
              Quitar
            </Button>
          </div>
          <div className="time-grid">
            <Field
              id={`${idPrefix}-inicio-${turno.id}`}
              label="Hora de inicio"
              type="time"
              value={turno.inicio}
              onChange={event => updateField(turno.id, 'inicio', event.target.value)}
              disabled={disabled}
            />
            <Field
              id={`${idPrefix}-fin-${turno.id}`}
              label="Hora de fin"
              type="time"
              value={turno.fin}
              onChange={event => updateField(turno.id, 'fin', event.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={addTurno}
        disabled={disabled}
        icon={<Icon name="plus" size={15} />}
      >
        Añadir turno
      </Button>
      <p className="field-hint">
        Puedes agregar turnos separados o consecutivos; no deben superponerse.
        Son informativos: no inician ni detienen el recorrido.
      </p>
    </div>
  );
};
