'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="focus-ring inline-flex size-9 items-center justify-center rounded-md text-foreground-light transition-colors hover:text-foreground"
    >
      {/* Until mount, resolvedTheme is unknown; render a same-size placeholder so
          the icon swap cannot cause a hydration mismatch or a layout shift. */}
      {mounted ? (
        isDark ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />
      ) : (
        <span className="block size-[18px]" />
      )}
    </button>
  );
}
