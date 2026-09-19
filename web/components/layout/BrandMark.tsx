import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Advolve home"
      className={cn('focus-ring rounded-md', className)}
    >
      <Image
        src="/advolve-logo.png"
        alt="Advolve"
        width={130}
        height={26}
        priority
        className="hidden dark:block"
      />
      <Image
        src="/advolve-logo-dark.png"
        alt="Advolve"
        width={130}
        height={26}
        priority
        className="block dark:hidden"
      />
    </Link>
  );
}
