import localFont from 'next/font/local';

// Both families are vendored as variable woff2 with their OFL licenses alongside
// them, so they load with no network request and no Google Fonts dependency.
export const dmSans = localFont({
  src: '../fonts/dm-sans-400-700.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-dm-sans',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const manrope = localFont({
  src: '../fonts/manrope-400-800.woff2',
  weight: '400 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-manrope',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});
