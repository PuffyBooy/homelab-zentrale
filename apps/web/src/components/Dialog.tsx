import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { cx } from '@hz/ui';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the accessible name. */
  title?: string;
  /** Accessible name when there is no visible heading. */
  label?: string;
  className?: string;
  /** Clicking the backdrop closes the dialog. */
  dismissable?: boolean;
  children: ReactNode;
}

/**
 * Modal dialog on top of the native <dialog> (top layer, inert background, Escape).
 * Adds a strict Tab trap and returns focus to the opener on close.
 * Proposed for packages/ui as `Dialog` (docs/QUESTIONS.md).
 */
export function Dialog({
  open,
  onClose,
  title,
  label,
  className,
  dismissable = true,
  children,
}: DialogProps): ReactElement | null {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    const auto = d.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
    (auto ?? d.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      if (d.open) d.close();
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className={cx('hz-dialog', className)}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      {title ? (
        <h2 className="hz-dialog-head" id={titleId}>
          {title}
        </h2>
      ) : null}
      {children}
    </dialog>
  );
}
