import { useEffect, useRef } from 'react';

export type DecisionDialogConfig = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
};

type DecisionDialogProps = DecisionDialogConfig & {
  onConfirm: () => void;
  onCancel: () => void;
};

export default function DecisionDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: DecisionDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <div className="decision-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCancel();
  }}>
    <section
      ref={dialog}
      className="decision-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="decision-dialog-title"
      aria-describedby="decision-dialog-message"
    >
      <h2 id="decision-dialog-title">{title}</h2>
      <p id="decision-dialog-message">{message}</p>
      <div className="decision-actions">
        <button ref={cancelButton} type="button" onClick={onCancel}>{cancelLabel}</button>
        <button className={destructive ? 'destructive' : 'primary'} type="button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </section>
  </div>;
}
