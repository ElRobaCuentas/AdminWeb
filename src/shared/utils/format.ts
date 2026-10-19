import type { Administrador } from '../../features/admin/services/admin_service';

export const formatDate = (timestamp?: number): string => {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

export const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString('es-PE');
};

export const adminFullName = (admin: Administrador): string =>
  `${admin.nombres || ''} ${admin.apellidos || ''}`.trim();

export const resolveAdminName = (
  admins: Administrador[],
  uid?: string | null,
): string => {
  if (!uid) return 'Admin eliminado';
  const admin = admins.find(item => item.uid === uid);
  if (admin?.nombres) {
    return `${admin.nombres} ${admin.apellidos ?? ''}`.trim();
  }
  return 'Admin eliminado';
};

export const initialsOf = (nombre: string, apellidos?: string): string => {
  const first = nombre.trim().charAt(0);
  const second = (apellidos ?? '').trim().charAt(0);
  const initials = `${first}${second}`.toUpperCase();
  return initials || 'AD';
};
