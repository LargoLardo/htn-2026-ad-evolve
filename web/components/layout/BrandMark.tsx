import Link from 'next/link';
import { cn } from '@/lib/utils';

/** Wordmark only -- no icon tile. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Evolve home"
      className={cn(
        'focus-ring rounded-md font-heading text-xl font-extrabold tracking-tight text-foreground',
        className
      )}
    >
      evolve<span className="text-brand">.</span>
    </Link>
  );
}
