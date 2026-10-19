import type { ReactNode } from 'react';

export const Card = ({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) => <div className={['card', className].filter(Boolean).join(' ')}>{children}</div>;

export const CardHeader = ({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <div className="card-header">
    <div>
      <h2>{title}</h2>
      {description ? <p className="card-desc">{description}</p> : null}
    </div>
    {action}
  </div>
);
