'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Canvas grid of squares that randomly change opacity.
 *
 * Adapted from CCCSolutions' effects/FlickeringGrid. Two changes: the colour is
 * resolved from a CSS custom property so it follows the theme instead of being a
 * fixed prop, and prefers-reduced-motion paints a single static frame rather
 * than animating.
 */
export function FlickeringGrid({
  squareSize = 4,
  gridGap = 6,
  flickerChance = 0.3,
  maxOpacity = 0.3,
  colorVar = '--brand-default',
  className,
}: {
  squareSize?: number;
  gridGap?: number;
  flickerChance?: number;
  maxOpacity?: number;
  colorVar?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const { resolvedTheme } = useTheme();

  // The token holds an unwrapped HSL triple ("79deg 62% 71%"), matching how the
  // Tailwind @theme layer consumes it.
  const resolveColor = useCallback(() => {
    if (typeof window === 'undefined') return 'rgba(128,128,128,';
    const raw = getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim();
    if (!raw) return 'rgba(128,128,128,';
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const ctx = probe.getContext('2d');
    if (!ctx) return 'rgba(128,128,128,';
    ctx.fillStyle = `hsl(${raw})`;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    return `rgba(${r}, ${g}, ${b},`;
  }, [colorVar]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const color = resolveColor();
    const cell = squareSize + gridGap;

    let frame = 0;
    let cols = 0;
    let rows = 0;
    let dpr = 1;
    let squares = new Float32Array(0);

    const size = () => {
      dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // ceil so partial cells at the right and bottom edges still paint; floor
      // leaves an unfilled strip whose size varies with the container.
      cols = Math.ceil(w / cell);
      rows = Math.ceil(h / cell);
      squares = new Float32Array(cols * rows);
      for (let i = 0; i < squares.length; i++) squares[i] = Math.random() * maxOpacity;
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          ctx.fillStyle = `${color}${squares[i * rows + j]})`;
          ctx.fillRect(i * cell * dpr, j * cell * dpr, squareSize * dpr, squareSize * dpr);
        }
      }
    };

    size();
    draw();

    let last = 0;
    const animate = (time: number) => {
      const delta = (time - last) / 1000;
      last = time;
      for (let i = 0; i < squares.length; i++) {
        if (Math.random() < flickerChance * delta) squares[i] = Math.random() * maxOpacity;
      }
      draw();
      frame = requestAnimationFrame(animate);
    };

    if (inView && !reduced) frame = requestAnimationFrame(animate);

    const resize = new ResizeObserver(() => {
      size();
      draw();
    });
    resize.observe(container);

    const visibility = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0,
    });
    visibility.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
    };
    // resolvedTheme is a dependency because the brand token changes with it.
  }, [squareSize, gridGap, flickerChance, maxOpacity, inView, resolveColor, resolvedTheme]);

  return (
    <div ref={containerRef} className={className} aria-hidden>
      <canvas ref={canvasRef} className="pointer-events-none block" />
    </div>
  );
}
