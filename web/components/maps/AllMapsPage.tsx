'use client';

import { useEffect, useState } from 'react';
import MapsView, { type MappableImage } from './MapsView';

/**
 * Every image that has precomputed maps, including ones that were never part of
 * a run. The maps tab inside a run can only offer that run's candidates, so a
 * file mapped straight from disk would otherwise be invisible.
 */
export default function AllMapsPage() {
  const [images, setImages] = useState<MappableImage[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/maps')
      .then(response => response.json())
      .then(async (hashes: string[]) => {
        const entries = await Promise.all(hashes.map(async hash => {
          // The artifact carries its own dimensions and build time, which makes a
          // far better label than a truncated hash.
          const data = await fetch(`/api/maps/${hash}`).then(r => r.ok ? r.json() : null).catch(() => null);
          return {
            hash,
            url: `/assets/${hash}.png`,
            label: data
              ? `${data.width}x${data.height} · ${data.grid}x${data.grid} · ${new Date(data.builtAt).toLocaleString()}`
              : hash.slice(0, 12),
          };
        }));
        if (live) setImages(entries);
      })
      .catch(() => live && setImages([]));
    return () => { live = false; };
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1 border-b border-border px-6 py-5">
        <h1 className="text-2xl text-foreground">Maps</h1>
        <p className="text-sm text-foreground-lighter">
          Attention, impact and the gap for every image that has been mapped, whether or not it belongs to a run.
        </p>
      </div>
      <div className="px-6 py-6">
        {images === null ? (
          <p className="text-sm text-foreground-lighter">Loading…</p>
        ) : images.length ? (
          <MapsView images={images} />
        ) : (
          <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
            Nothing mapped yet. Build one with{' '}
            <code>node scripts/build-demo-maps.mjs --image path/to/ad.png</code>
          </div>
        )}
      </div>
    </div>
  );
}
