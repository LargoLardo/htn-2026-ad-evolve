import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The old mark absolutely-positioned an arrow badge in the same accent colour
 *  as the tile behind it, so it just ate the corner. This is a plain centred
 *  tile -- brand fill, contrast glyph -- which inverts correctly with the theme. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Evolve home"
      className={cn('focus-ring flex items-center gap-2.5 rounded-md', className)}
    >
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-[9px] bg-brand font-heading text-[19px] font-extrabold leading-none text-foreground-contrast"
      >
        e
      </span>
      <span className="font-heading text-xl font-extrabold tracking-tight text-foreground">
        evolve<span className="text-brand">.</span>
      </span>
    </Link>
  );
}
