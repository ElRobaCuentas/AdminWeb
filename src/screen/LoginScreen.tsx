import { useState, type KeyboardEvent } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseAuth } from '../shared/config/firebase';
import { isValidDni, normalizeDni, sanitizeDniInput } from '../shared/utils/dni';
import { Button } from '../shared/ui/Button';
import { Field } from '../shared/ui/Field';

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
        <h1 className="login-brand-top">El Burrito</h1>

        <div className="login-brand-hero">
          <p className="login-brand-description">Buses, choferes y jornadas diarias.</p>
          <div className="login-route">
            <div className="login-route-stop">
              Conductores
            </div>
            <div className="login-route-stop">
              Buses
            </div>
            <div className="login-route-stop">
              Asignaciones
            </div>
            <div className="login-route-stop">
              Administradores
            </div>
          </div>
        </div>

      </div>

      <div className="login-panel">
        <div className="login-card">
          <h2>Acceso para administradores</h2>
          <p className="login-sub">Ingresa con tu DNI y contraseña.</p>

          <div onKeyDown={handleKeyDown}>
            <Field
              id="dni"
              label="DNI"
              inputMode="numeric"
              maxLength={8}
              hint="8 dígitos, sin puntos."
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

            <Button block onClick={handleLogin} disabled={loading} className="mt-4">
              {loading ? 'Entrando…' : 'Entrar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
