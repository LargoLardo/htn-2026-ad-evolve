import { cn } from '@/lib/utils';

/** Supabase's signature card.
 *
 *  The 1px border is not a border: it is `p-px` on a gradient-filled parent with
 *  an opaque child painted on top, so the edge fades from --border at the top to
 *  nearly nothing at the bottom. The inner radius is hand-computed as the outer
 *  radius minus the 1px pad (8px -> 7px, 12px -> 11px), otherwise the corners
 *  show a visible sliver of the gradient. */
export function Panel({
  className,
  innerClassName,
  hover = true,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  innerClassName?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        'group/panel relative rounded-lg p-px md:rounded-xl',
        'bg-linear-to-b from-border to-border/50 dark:to-surface-100',
        'transition-all',
        hover && 'hover:bg-none hover:bg-border-stronger',
        className
      )}
      {...props}
    >
      <div
        className={cn(
          'relative z-10 h-full w-full overflow-hidden rounded-[7px] md:rounded-[11px]',
          'bg-surface-75 text-foreground-light',
          innerClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
