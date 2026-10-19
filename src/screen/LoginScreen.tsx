import { useState, type KeyboardEvent } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseAuth } from '../shared/config/firebase';
import { isValidDni, normalizeDni, sanitizeDniInput } from '../shared/utils/dni';
import { Button } from '../shared/ui/Button';
import { Field } from '../shared/ui/Field';
import { Icon } from '../shared/ui/Icon';

export const LoginScreen = () => {
  const [dni, setDni] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    if (!isValidDni(normalizeDni(dni))) {
      setError('El DNI debe tener 8 dígitos numéricos.');
      return;
    }
    if (!password.trim()) {
      setError('Ingresa tu contraseña.');
      return;
    }

    setLoading(true);
    try {
      const email = `${normalizeDni(dni)}@admin.com`;
      await signInWithEmailAndPassword(firebaseAuth, email, password);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'auth/network-request-failed') {
        setError('Sin conexión. Verifica tu conexión a internet.');
      } else if (
        code === 'auth/user-not-found' ||
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password'
      ) {
        setError('Datos incorrectos. DNI o contraseña no válidos.');
      } else if (code === 'auth/user-disabled') {
        setError('Cuenta deshabilitada. Comunícate con la oficina.');
      } else {
        setError('Ocurrió un error inesperado.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') void handleLogin();
  };

  return (
    <div className="login">
      <div className="login-brand">
        <div className="login-brand-top">
          <span className="brand-mark">
            <Icon name="bus" size={22} />
          </span>
          El Burrito
        </div>

        <div className="login-brand-hero">
          <h1>Panel de administración</h1>
          <p>
            Gestiona conductores, buses y asignaciones diarias del sistema de
            transporte en tiempo real.
          </p>
          <ul className="login-brand-list">
            <li>
              <Icon name="drivers" size={18} /> Registro y control de conductores
            </li>
            <li>
              <Icon name="bus" size={18} /> Administración de los buses
            </li>
            <li>
              <Icon name="assignment" size={18} /> Asignaciones del turno diario
            </li>
          </ul>
        </div>

        <div className="login-brand-foot">EVENTUAL</div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="login-mobile-brand">
            <span className="brand-mark">
              <Icon name="bus" size={20} />
            </span>
            El Burrito
          </div>

          <h2>Acceso para administradores</h2>
          <p className="login-sub">Ingresa con tu DNI y contraseña.</p>

          <div onKeyDown={handleKeyDown}>
            <Field
              id="dni"
              label="DNI"
              inputMode="numeric"
              maxLength={8}
              value={dni}
              onChange={e => setDni(sanitizeDniInput(e.target.value))}
              autoComplete="username"
            />

            <Field
              id="password"
              label="Contraseña"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />

            {error ? <p className="field-error">{error}</p> : null}

            <Button
              block
              onClick={handleLogin}
              disabled={loading}
              className="mt-4"
              icon={loading ? undefined : <Icon name="logout" size={16} />}
            >
              {loading ? 'Entrando…' : 'Entrar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
