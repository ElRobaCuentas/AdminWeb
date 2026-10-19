import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import {
  ToastContext,
  type ToastContextValue,
  type ToastType,
} from './toastContext';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

const ICON_BY_TYPE: Record<ToastType, IconName> = {
  success: 'checkCircle',
  error: 'alert',
  info: 'info',
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts(previous => previous.filter(toast => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = Date.now() + Math.random();
      setToasts(previous => [...previous, { id, type, message }]);
      window.setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (message: string) => notify(message, 'success'),
      error: (message: string) => notify(message, 'error'),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast toast-${toast.type}`} role="status">
            <span className="toast-icon">
              <Icon name={ICON_BY_TYPE[toast.type]} size={18} />
            </span>
            <span className="toast-text">{toast.message}</span>
            <button
              className="toast-close"
              type="button"
              aria-label="Cerrar aviso"
              onClick={() => remove(toast.id)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
