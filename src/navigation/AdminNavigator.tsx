import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../shared/layout/AppShell';
import { ChoferesScreen } from '../features/admin/screen/ChoferesScreen';
import { BusesScreen } from '../features/admin/screen/BusesScreen';
import { AsignacionesScreen } from '../features/admin/screen/AsignacionesScreen';
import { AdminsScreen } from '../features/admin/screen/AdminsScreen';

export const AdminNavigator = () => (
  <AppShell>
    <Routes>
      <Route path="/" element={<AsignacionesScreen />} />
      <Route path="/choferes" element={<ChoferesScreen />} />
      <Route path="/buses" element={<BusesScreen />} />
      <Route path="/asignaciones" element={<Navigate to="/" replace />} />
      <Route path="/admins" element={<AdminsScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </AppShell>
);
