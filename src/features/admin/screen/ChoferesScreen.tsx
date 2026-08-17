import { useNavigate } from 'react-router-dom';

export const ChoferesScreen = () => {
  const navigate = useNavigate();

  return (
    <div className="screen">
      <div className="panel">
        <h1 className="panel-title">Gestión de choferes</h1>
        <p className="panel-subtitle">Módulo en construcción.</p>
        <button className="form-button" onClick={() => navigate('/')}>
          Volver
        </button>
      </div>
    </div>
  );
};