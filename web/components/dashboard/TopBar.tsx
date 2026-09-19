'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import ThemeToggle from '@/components/layout/ThemeToggle';

/**
 * Supabase Studio's shell: a short top bar carrying a breadcrumb trail and the
 * global controls, above the page body.
 *
 * The theme toggle lives here rather than at the foot of the sidebar, where the
 * Next devtools badge sits directly on top of it in development.
 */
export default function TopBar() {
  const pathname = usePathname();

  const crumbs: { label: string; href?: string }[] = [{ label: 'Evolve', href: '/dashboard' }];
  if (pathname === '/dashboard') {
    crumbs.push({ label: 'Lab' });
  } else if (pathname === '/dashboard/runs') {
    crumbs.push({ label: 'Experiments' });
  } else if (pathname.startsWith('/dashboard/runs/')) {
    crumbs.push({ label: 'Experiments', href: '/dashboard/runs' });
    crumbs.push({ label: pathname.split('/').pop()?.slice(0, 8) ?? 'Run' });
  }

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur-xs">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden className="select-none text-border-stronger">
                /
              </span>
            )}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="focus-ring truncate rounded text-foreground-lighter transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate text-foreground">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-1">
        <Link
          href="/"
          className="focus-ring hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-foreground-lighter transition-colors hover:bg-surface-200 hover:text-foreground sm:flex"
        >
          <BookOpen size={14} strokeWidth={1.75} />
          Overview
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
