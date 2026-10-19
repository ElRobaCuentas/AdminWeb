interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

export const ToggleSwitch = ({ checked, onChange, disabled, label }: ToggleSwitchProps) => (
  <input
    type="checkbox"
    className="switch"
    role="switch"
    aria-label={label}
    checked={checked}
    disabled={disabled}
    onChange={event => onChange(event.target.checked)}
  />
);
