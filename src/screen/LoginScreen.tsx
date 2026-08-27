import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseAuth } from '../shared/config/firebase';

export const LoginScreen = () => {
  const [dni, setDni] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    if (dni.trim().length < 8) {
      setError('Ingresa un DNI válido (mínimo 8 dígitos).');
      return;
    }
    if (!password.trim()) {
      setError('Ingresa tu contraseña.');
      return;
    }

    setLoading(true);
    try {
      const email = `${dni.trim()}@burritodriver.com`;
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

  return (
    <div className="screen">
      <div className="auth-card">
        <h1 className="auth-title">Acceso para administradores</h1>

        <div className="form-group">
          <label className="form-label" htmlFor="dni">DNI</label>
          <input
            id="dni"
            className="form-input"
            inputMode="numeric"
            maxLength={12}
            value={dni}
            onChange={e => setDni(e.target.value)}
            autoComplete="username"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="password">Contraseña</label>
          <input
            id="password"
            className="form-input"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <button
          className="form-button"
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </div>
    </div>
  );
};