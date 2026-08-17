import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPanelScreen } from '../features/admin/screen/AdminPanelScreen';

export const AdminNavigator = () => (
  <Routes>
    <Route path="/" element={<AdminPanelScreen />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);