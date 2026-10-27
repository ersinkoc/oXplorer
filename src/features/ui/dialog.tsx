import { type ReactNode, useEffect, useRef } from "react";

/**
 * Minimal modal built on <dialog>: native focus trapping, Esc to close, and
 * inert background. `onClose` fires for Esc and backdrop clicks.
 */
export function Dialog({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={`m-auto rounded-xl border border-border bg-bg p-0 text-fg shadow-2xl backdrop:bg-black/25 ${className ?? ""}`}
    >
      {open && children}
    </dialog>
  );
}

export function DialogButton({
  children,
  onClick,
  primary,
  autoFocus,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/noAutofocus: dialogs move focus to their default action
      autoFocus={autoFocus}
      onClick={onClick}
      className={`h-7 rounded-md px-3 text-[13px] ${
        primary ? "bg-accent text-white" : "border border-border bg-bg hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}
