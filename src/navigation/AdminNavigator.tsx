import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPanelScreen } from '../features/admin/screen/AdminPanelScreen';
import { ChoferesScreen } from '../features/admin/screen/ChoferesScreen';
import { BusesScreen } from '../features/admin/screen/BusesScreen';
import { AsignacionesScreen } from '../features/admin/screen/AsignacionesScreen';

export const AdminNavigator = () => (
  <Routes>
    <Route path="/" element={<AdminPanelScreen />} />
    <Route path="/choferes" element={<ChoferesScreen />} />
    <Route path="/buses" element={<BusesScreen />} />
    <Route path="/asignaciones" element={<AsignacionesScreen />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);