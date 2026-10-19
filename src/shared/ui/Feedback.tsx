import type { ReactNode } from 'react';

export const EmptyState = ({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) => (
  <div className="empty-state">
    {icon ? <div className="empty-icon">{icon}</div> : null}
    <strong>{title}</strong>
    {hint ? <span>{hint}</span> : null}
  </div>
);

export const Spinner = ({ large = false }: { large?: boolean }) => (
  <div
    className={['spinner', large ? 'spinner-lg' : ''].filter(Boolean).join(' ')}
    role="status"
    aria-label="Cargando"
  />
);

export const LoadingScreen = ({ text }: { text: string }) => (
  <div className="loading-screen">
    <Spinner large />
    <span>{text}</span>
  </div>
);
