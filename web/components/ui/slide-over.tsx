'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Right-hand panel for transient work, the way Studio opens "New table".
 *
 * Built on native <dialog> so it gets the top layer, a real backdrop and
 * Escape-to-close without a focus-trap dependency. The default centring and
 * max-width are overridden to pin it to the right edge, full height.
 */
export function SlideOver({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
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
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // Clicks landing on the dialog element itself, outside its content box,
        // are backdrop clicks.
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
        'ml-auto mr-0 mt-0 mb-0 h-dvh max-h-dvh w-[min(92vw,460px)] max-w-none',
        'border-l border-border bg-surface-100 p-0 text-foreground',
        'backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        className
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg text-foreground">{title}</h2>
              {description && (
                <p className="text-xs text-foreground-lighter">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title.toLowerCase()}`}
              className="focus-ring shrink-0 rounded-md p-1 text-foreground-lighter transition-colors hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
