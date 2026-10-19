import type { ReactNode } from 'react';

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="page-header">
    <div>
      <h1>{title}</h1>
      {description ? <p className="page-desc">{description}</p> : null}
    </div>
    {actions ? <div className="page-header-actions">{actions}</div> : null}
  </div>
);
