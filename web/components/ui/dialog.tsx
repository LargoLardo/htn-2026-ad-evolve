'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Native <dialog>, same as the original app: it gives us the top layer, the
 *  backdrop pseudo-element and Escape handling without a focus-trap dependency. */
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
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onCancel={onClose}
      // showModal() puts the backdrop behind the dialog box, so a click landing
      // on the dialog element itself but outside its content box is a backdrop click.
      onClick={(event) => {
        if (event.target !== ref.current) return;
        const box = ref.current.getBoundingClientRect();
        const inside =
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom;
        if (!inside) onClose();
      }}
      className={cn(
        'm-auto w-[min(92vw,820px)] rounded-xl border border-border-overlay bg-surface-100 p-0',
        'text-foreground backdrop:bg-black/60 backdrop:backdrop-blur-sm',
        className
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
            <span className="label">{label}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${label.toLowerCase()}`}
              className="focus-ring rounded-md p-1 text-foreground-lighter transition-colors hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
