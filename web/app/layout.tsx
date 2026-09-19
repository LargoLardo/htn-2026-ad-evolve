import type { Metadata } from 'next';
import './globals.css';
import { dmSans, manrope } from '@/lib/fonts';
import { Providers } from '@/components/layout/Providers';

export const metadata: Metadata = {
  title: 'Evolve | Creative evolution lab',
  description:
    'An evolutionary creative lab: product brief to diverse ad genomes, screening, rendering and selection over successive generations.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required: next-themes writes data-theme on the
    // client before React hydrates, which would otherwise be flagged as a mismatch.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${manrope.variable}`}
    >
      <body className="bg-background">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
