import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export type ConfirmFn = (options: string | ConfirmOptions) => Promise<boolean>;

interface ActiveConfirm extends Required<Omit<ConfirmOptions, 'danger'>> {
  danger: boolean;
  resolve(result: boolean): void;
  returnFocus: HTMLElement | null;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

const normalizeOptions = (input: string | ConfirmOptions): Required<ConfirmOptions> =>
  typeof input === 'string'
    ? { message: input, title: '请确认', confirmLabel: '确定', cancelLabel: '取消', danger: false }
    : {
        message: input.message,
        title: input.title ?? '请确认',
        confirmLabel: input.confirmLabel ?? '确定',
        cancelLabel: input.cancelLabel ?? '取消',
        danger: input.danger ?? false,
      };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  const activeRef = useRef<ActiveConfirm | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const confirm = useCallback<ConfirmFn>((input) => {
    // The modal backdrop makes a second user-triggered confirmation impossible.
    // Fail closed if code nevertheless requests one while another is active.
    if (activeRef.current) return Promise.resolve(false);
    const options = normalizeOptions(input);
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return new Promise<boolean>((resolve) => {
      const next: ActiveConfirm = { ...options, resolve, returnFocus };
      activeRef.current = next;
      setActive(next);
    });
  }, []);

  const close = useCallback((result: boolean) => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    setActive(null);
    current.resolve(result);
    requestAnimationFrame(() => {
      if (current.returnFocus?.isConnected) {
        current.returnFocus.focus({ preventScroll: true });
      }
    });
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {active && createPortal(
        <div
          className="confirm-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && close(false)}
        >
          <div
            ref={dialogRef}
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onKeyDown={handleKeyDown}
          >
            <header>
              <h2 id={titleId}>{active.title}</h2>
            </header>
            <div id={descriptionId} className="confirm-message">{active.message}</div>
            <footer>
              <button type="button" autoFocus onClick={() => close(false)}>
                {active.cancelLabel}
              </button>
              <button
                type="button"
                className={active.danger ? 'danger-btn' : 'primary-btn'}
                onClick={() => close(true)}
              >
                {active.confirmLabel}
              </button>
            </footer>
          </div>
        </div>,
        document.body
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider');
  return confirm;
}
