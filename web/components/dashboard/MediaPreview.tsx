'use client';

import { assetLink } from '@/lib/api';
import type { Asset } from '@/lib/types';

export default function MediaPreview({ asset, title, className }: { asset?: Asset | null; title: string; className?: string }) {
  const src = assetLink(asset?.url);
  if (!src) return null;
  return src.endsWith('.mp4')
    ? <video src={src} controls playsInline preload="metadata" aria-label={title} className={className} />
    // eslint-disable-next-line @next/next/no-img-element
    : <img src={src} alt={title} loading="lazy" className={className} />;
}
