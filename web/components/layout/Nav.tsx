import { BrandMark } from './BrandMark';
import ThemeToggle from './ThemeToggle';
import { ButtonLink } from '@/components/ui/button';

/** Supabase's nav treatment: a tint plate underneath an translucent blurred bar,
 *  so content scrolling under it stays faintly visible without bleeding through. */
export default function Nav() {
  return (
    <div className="sticky top-0 z-40">
      <div
        aria-hidden
        className="absolute inset-0 h-full w-full bg-background/90 transition-all duration-300 dark:bg-background/95"
      />
      <nav className="relative z-40 border-b border-border backdrop-blur-xs transition-all duration-300">
        <div className="section-container relative flex h-16 items-center justify-between">
          <BrandMark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <ButtonLink href="/dashboard" variant="primary" size="medium">
              Open the lab
            </ButtonLink>
          </div>
        </div>
      </nav>
    </div>
  );
}
