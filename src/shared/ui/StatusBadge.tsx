import type { ReactNode } from 'react';

export const StatusBadge = ({
  active,
  activeLabel = 'Activo',
  inactiveLabel = 'Inactivo',
}: {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
}) => (
  <span className={`badge ${active ? 'badge-success' : 'badge-neutral'}`}>
    {active ? activeLabel : inactiveLabel}
  </span>
);

export const Badge = ({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'neutral';
}) => <span className={`badge badge-${tone}`}>{children}</span>;
