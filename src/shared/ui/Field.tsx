import type { InputHTMLAttributes } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

export const Field = ({ id, label, hint, error, className = '', ...rest }: FieldProps) => (
  <div className="field">
    <label className="field-label" htmlFor={id}>
      {label}
    </label>
    <input
      id={id}
      className={['field-input', error ? 'is-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
    {error ? <p className="field-error">{error}</p> : null}
    {!error && hint ? <p className="field-hint">{hint}</p> : null}
  </div>
);
