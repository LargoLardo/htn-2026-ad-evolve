import { BrandMark } from './BrandMark';

export default function Footer() {
  return (
    <footer className="bg-alternative">
      {/* Faded hairline: cheaper than a border and it stops short of the gutters. */}
      <div aria-hidden className="h-px w-full bg-linear-to-r from-transparent via-border to-transparent" />
      <div className="section-container flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <BrandMark />
        <p className="max-w-[62ch] text-xs text-foreground-lighter">
          Advolve evaluates creative against predicted cortical response, scored by
          TRIBE against one fixed original baseline. Predictions are
          parcel-averaged and directional. They are not measured emotion, recall or
          conversion.
        </p>
      </div>
    </footer>
  );
}
