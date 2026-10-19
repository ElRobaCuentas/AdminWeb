import type { ReactNode } from 'react';

export const StatCard = ({
  icon,
  value,
  label,
  tone = 'primary',
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  tone?: 'primary' | 'accent' | 'success';
}) => (
  <div className="stat-card">
    <span className={['stat-icon', tone !== 'primary' ? `is-${tone}` : ''].filter(Boolean).join(' ')}>
      {icon}
    </span>
    <div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  </div>
);
