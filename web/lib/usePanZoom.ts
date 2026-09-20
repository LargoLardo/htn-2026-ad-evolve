'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pan and zoom for one transformed surface.
 *
 * Extracted from the lineage tree, which had the fuller implementation of the
 * two, so the map inherits pinch, focal-point zoom and window-level tracking
 * rather than the tree losing them. The map's own behaviours survive as options:
 * it snaps back to the origin at minimum scale and ignores a bare wheel until
 * the surface is zoomed, because over an ad a bare wheel is the page scrolling.
 */

export interface PanZoomOptions {
  min?: number;
  max?: number;
  /** Snap x and y back to 0 whenever scale returns to `min`. */
  snapToOriginAtMin?: boolean;
  /** Ignore a wheel without ctrl or meta while sitting at `min`. */
  requireModifierAtMin?: boolean;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

/** Pointer travel, in pixels, past which a gesture was a pan and the click it
 *  ends with should not be treated as a click. */
const DRAG_SLOP = 4;

export function usePanZoom<Element extends HTMLElement>({
  min = 0.15,
  max = 2.5,
  snapToOriginAtMin = false,
  requireModifierAtMin = false,
}: PanZoomOptions = {}) {
  const viewportRef = useRef<Element | null>(null);
  const [view, setView] = useState<View>({ scale: min === 1 ? 1 : 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const travelled = useRef(0);

  const clampScale = useCallback(
    (scale: number) => Math.min(max, Math.max(min, scale)),
    [min, max]
  );

  const settle = useCallback(
    (next: View): View => (snapToOriginAtMin && next.scale === min ? { scale: min, x: 0, y: 0 } : next),
    [min, snapToOriginAtMin]
  );

  /** Zoom about a point in viewport coordinates, so whatever is under the
   *  cursor stays under the cursor. */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setView((current) => {
        const scale = clampScale(current.scale * factor);
        const ratio = scale / current.scale;
        return settle({ scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio });
      });
    },
    [clampScale, settle]
  );

  const zoomAtCentre = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (viewport) zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
    },
    [zoomAt]
  );

  const reset = useCallback(() => setView({ scale: min === 1 ? 1 : 1, x: 0, y: 0 }), [min]);

  /** Centre content of this size, never magnifying past life size: a tiny run
   *  blown up to fill the viewport looks like a bug rather than a small run. */
  const fit = useCallback(
    (width: number, height: number, padding = 32) => {
      const viewport = viewportRef.current;
      if (!viewport || !width || !height) return;
      const scale = clampScale(
        Math.min((viewport.clientWidth - padding * 2) / width, (viewport.clientHeight - padding * 2) / height, 1)
      );
      setView({
        scale,
        x: (viewport.clientWidth - width * scale) / 2,
        y: (viewport.clientHeight - height * scale) / 2,
      });
    },
    [clampScale]
  );

  /** Pan a point in content coordinates into view. A transformed element cannot
   *  be scrolled into view, so move the surface instead. */
  const reveal = useCallback((x: number, y: number, width: number, height: number, padding = 16) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setView((current) => {
      const left = x * current.scale + current.x;
      const top = y * current.scale + current.y;
      const right = left + width * current.scale;
      const bottom = top + height * current.scale;
      let { x: nextX, y: nextY } = current;
      if (left < padding) nextX += padding - left;
      else if (right > viewport.clientWidth - padding) nextX -= right - (viewport.clientWidth - padding);
      if (top < padding) nextY += padding - top;
      else if (bottom > viewport.clientHeight - padding) nextY -= bottom - (viewport.clientHeight - padding);
      return { ...current, x: nextX, y: nextY };
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Registered by hand because React attaches wheel passively, so calling
    // preventDefault on its synthetic event does nothing and the page scrolls
    // out from behind the surface while you are trying to zoom it.
    const onWheel = (event: WheelEvent) => {
      if (requireModifierAtMin && !event.ctrlKey && !event.metaKey && view.scale === min) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAt, requireModifierAtMin, view.scale, min]);

  useEffect(() => {
    // On window rather than the viewport so a pan that leaves the element, which
    // is most of them, keeps tracking instead of sticking.
    const onMove = (event: PointerEvent) => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];
      const viewport = viewportRef.current;

      if (points.length === 2 && pinch.current && viewport) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        if (!pinch.current.distance) return;
        const rect = viewport.getBoundingClientRect();
        const cx = (points[0].x + points[1].x) / 2 - rect.left;
        const cy = (points[0].y + points[1].y) / 2 - rect.top;
        const target = clampScale(pinch.current.scale * (distance / pinch.current.distance));
        travelled.current = Infinity;
        setView((current) => {
          const ratio = target / current.scale;
          return settle({ scale: target, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio });
        });
        return;
      }

      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      travelled.current += Math.hypot(dx, dy);
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    };
    const onRelease = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, [clampScale, settle]);

  const onPointerDown = useCallback((event: React.PointerEvent<Element>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    }
  }, [view.scale]);

  /** True when the gesture that just ended was a pan, so its click is not one. */
  const wasPan = useCallback(() => travelled.current > DRAG_SLOP, []);

  return { viewportRef, view, setView, onPointerDown, wasPan, zoomAt, zoomAtCentre, fit, reset, reveal };
}
