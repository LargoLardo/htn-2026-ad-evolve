import Link from 'next/link';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'focus-ring inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // brand-500 inverts between themes, and foreground-contrast inverts with
        // it, so this one pair reads correctly in both.
        primary:
          'border-brand-500 bg-brand-500 text-foreground-contrast hover:bg-brand-600 hover:border-brand-600',
        default:
          'border-border-button bg-surface-100 text-foreground hover:bg-surface-200 hover:border-border-button-hover',
        ghost: 'border-transparent text-foreground-light hover:text-foreground hover:bg-surface-200',
      },
      size: {
        small: 'h-8 px-3 text-xs',
        medium: 'h-9 px-4 text-sm',
        large: 'h-11 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'default', size: 'medium' },
  }
);

type ButtonProps = VariantProps<typeof buttonVariants> & { className?: string };

export function Button({
  variant,
  size,
  className,
  ...props
}: ButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ButtonProps & React.ComponentProps<typeof Link>) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
