import { cn } from '@/lib/utils';

/** Supabase's marketing wrapper: `section-container` holds the max-width and the
 *  responsive side gutters; the padding here is the vertical rhythm. */
export function SectionContainer({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('section-container relative py-16 sm:py-18 md:py-24', className)}
      {...props}
    />
  );
}
