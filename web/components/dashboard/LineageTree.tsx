'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetLink } from '@/lib/api';
import { nodeScore, scoreLabel } from '@/lib/scores';
import type { Candidate, Run } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Every candidate in the run as one graph, laid out by generation, with an edge
 * from each parent to each child.
 *
 * The generation-by-generation list this replaces hid the thing that matters:
 * when a whole generation descends from a single parent, or when the elite is
 * copied forward unchanged, the list shows a row of apparently new candidates
 * and the tree shows one node with four children and a dashed self-edge. The
 * second reading is the true one.
 */

const NODE_W = 150;
const NODE_H = 186;
const GAP_X = 30;
const GAP_Y = 88;

/** How far above a child its parents' lines meet. Short enough that the joined
 *  stem reads as belonging to the child, long enough to be visible as a stem. */
const JUNCTION_RISE = 26;

const MIN_SCALE = 0.15;
const MAX_SCALE = 2.5;
/** Pointer travel, in pixels, past which a gesture was a pan and the click it
 *  ends with should not open a creative. */
const DRAG_SLOP = 4;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** An "Elite retained" child is the parent copied, not a new creative. It gets a
 *  dashed edge so a converged run looks converged instead of productive. */
const isCarriedOver = (candidate: Candidate) => /elite/i.test(candidate.mutation ?? '');

export default function LineageTree({
  run,
  onInspect,
}: {
  run: Run;
  onInspect: (candidate: Candidate) => void;
}) {
  // Crossing-minimisation gets the tangle down but cannot remove it: a child
  // has two parents that may sit anywhere. Isolating one node's lineage on
  // hover makes any individual descent readable no matter how dense the whole.
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => {
    const rows = run.rounds.map(round => round.candidates);
    const widest = Math.max(1, ...rows.map(r => r.length));
    const width = widest * NODE_W + (widest - 1) * GAP_X;
    const position = new Map<string, { x: number; y: number; candidate: Candidate; gen: number; rowIndex: number }>();

    rows.forEach((candidates, rowIndex) => {
      // Order each row under its parents before placing it.
      //
      // Children were previously laid out in the order they were created, which
      // has nothing to do with where their parents sit, so almost every edge
      // crossed almost every other one. Sorting a row by the mean position of
      // its parents is the standard crossing-minimisation step, and on a row of
      // eight it is the difference between a graph and a ball of wool.
      const barycentre = (candidate: Candidate) => {
        const parents = (candidate.parents ?? []).map(id => position.get(id)?.x).filter((x): x is number => typeof x === 'number');
        // A node with no placed parent keeps its own order rather than piling
        // up at zero, which would drag unrelated nodes to the left edge.
        return parents.length ? parents.reduce((sum, x) => sum + x, 0) / parents.length : Number.POSITIVE_INFINITY;
      };
      const ordered = rowIndex === 0 ? candidates : [...candidates]
        .map((candidate, index) => ({ candidate, index, key: barycentre(candidate) }))
        .sort((a, b) => (a.key - b.key) || (a.index - b.index))
        .map(entry => entry.candidate);

      // Centre short rows against the widest one so edges stay readable.
      const rowWidth = ordered.length * NODE_W + (ordered.length - 1) * GAP_X;
      const offset = (width - rowWidth) / 2;
      ordered.forEach((candidate, i) => {
        position.set(candidate.id, {
          x: offset + i * (NODE_W + GAP_X),
          y: rowIndex * (NODE_H + GAP_Y),
          candidate,
          gen: run.rounds[rowIndex].number,
          rowIndex,
        });
      });
    });

    // One link per child, not one per parent.
    //
    // Crossover takes two parents and makes one child. Drawn as two separate
    // edges that reads as two independent claims, A made this and C made this,
    // when the truth is that A and C together made it, and you could only find
    // that out by hovering. Grouping by child lets the two lines meet at a
    // junction and descend as a single stem, so "these two made this one" is
    // one object on screen instead of two.
    const links = [];
    for (const { candidate } of position.values()) {
      const parentIds = (candidate.parents ?? []).filter(id => position.has(id));
      if (!parentIds.length) continue;
      const child = position.get(candidate.id)!;
      const childX = child.x + NODE_W / 2;
      links.push({
        childId: candidate.id,
        parentIds,
        carried: isCarriedOver(candidate),
        childX, childY: child.y,
        junctionX: childX, junctionY: child.y - JUNCTION_RISE,
        parents: parentIds.map(id => {
          const parent = position.get(id)!;
          return { id, x: parent.x + NODE_W / 2, y: parent.y + NODE_H };
        }),
      });
    }

    // Only the parent pool breeds, so most of a generation leaves no
    // descendants. Fading those explains the density: every line radiates from
    // a handful of nodes because only a handful were ever bred from, which
    // otherwise looks like the edges were drawn at random.
    const bred = new Set(links.flatMap(link => link.parentIds));
    const lastRow = rows.length - 1;

    return {
      width,
      height: rows.length * NODE_H + (rows.length - 1) * GAP_Y,
      nodes: [...position.values()].map(node => ({
        ...node,
        // The final generation has no descendants because the run stopped, not
        // because it was passed over. Fading it would say the opposite.
        dead: node.rowIndex < lastRow && !bred.has(node.candidate.id),
      })),
      links,
    };
  }, [run]);

  // A run of three generations at eight wide is wider than any screen, and the
  // scrolling strip it used to live in let you see a row at a time, which is
  // the one thing a lineage view must not do. Pan and zoom instead.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  // A pan and a click both end in a pointerup, so without this every pan that
  // finished over a node would open it.
  const travelled = useRef(0);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout.width || !layout.height) return;
    const padding = 32;
    // Never magnify past life size on fit: a two-node run blown up to fill the
    // viewport looks like a bug rather than a small run.
    const scale = clampScale(Math.min(
      (viewport.clientWidth - padding * 2) / layout.width,
      (viewport.clientHeight - padding * 2) / layout.height,
      1,
    ));
    setView({
      scale,
      x: (viewport.clientWidth - layout.width * scale) / 2,
      y: (viewport.clientHeight - layout.height * scale) / 2,
    });
  }, [layout.width, layout.height]);

  useEffect(() => { fit(); }, [fit]);

  /** Zoom about a point in viewport coordinates, so whatever is under the
   *  cursor stays under the cursor. */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView(current => {
      const scale = clampScale(current.scale * factor);
      const ratio = scale / current.scale;
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  }, []);

  const zoomAtCentre = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (viewport) zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }, [zoomAt]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Registered by hand because React attaches wheel passively, so calling
    // preventDefault on its synthetic event does nothing and the page scrolls
    // out from behind the graph while you are trying to zoom it.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

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
        setView(current => {
          const ratio = target / current.scale;
          return { scale: target, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
        });
        return;
      }

      const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
      travelled.current += Math.hypot(dx, dy);
      setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
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
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    }
  };

  /** Keyboard focus moves between nodes that may be off screen, and a
   *  transformed element cannot be scrolled into view, so pan to it instead. */
  const reveal = useCallback((x: number, y: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setView(current => {
      const padding = 16;
      const left = x * current.scale + current.x, top = y * current.scale + current.y;
      const right = left + NODE_W * current.scale, bottom = top + NODE_H * current.scale;
      let nextX = current.x, nextY = current.y;
      if (left < padding) nextX += padding - left;
      else if (right > viewport.clientWidth - padding) nextX -= right - (viewport.clientWidth - padding);
      if (top < padding) nextY += padding - top;
      else if (bottom > viewport.clientHeight - padding) nextY -= bottom - (viewport.clientHeight - padding);
      return { ...current, x: nextX, y: nextY };
    });
  }, []);

  if (!layout.nodes.length) return null;

  // Counted per creative rather than per line, now that two parents produce one
  // link: "2 of 15 links" would no longer match anything visible on screen.
  const carried = layout.links.filter(link => link.carried).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-foreground-lighter">
        <span className="flex items-center gap-1.5">
          <svg width="22" height="8" aria-hidden><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="1.5" /></svg>
          new creative
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="8" aria-hidden><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" /></svg>
          elite carried over unchanged
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="24" height="14" aria-hidden>
            <path d="M 2 1 C 2 6, 12 6, 12 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M 22 1 C 22 6, 12 6, 12 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="12" y1="8" x2="12" y2="13" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="8" r="2" fill="currentColor" />
          </svg>
          two parents crossed into one child
        </span>
        {layout.nodes.some(node => node.dead) && (
          <span className="flex items-center gap-1.5 opacity-40">
            <span aria-hidden className="size-3 rounded-sm border border-current" />
            not bred from
          </span>
        )}
        {carried > 0 && (
          <span className="text-foreground-light">
            {carried} of {layout.links.length} descendants are copies, not new creatives.
          </span>
        )}
        <span className="ml-auto">Hover a creative to isolate its lineage.</span>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-border bg-surface-75">
        {/* Controls sit above the transformed layer so zooming does not shrink
            the buttons that do the zooming. */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
          <ViewButton label="Zoom out" onClick={() => zoomAtCentre(1 / 1.25)}>-</ViewButton>
          <ViewButton label="Zoom in" onClick={() => zoomAtCentre(1.25)}>+</ViewButton>
          <ViewButton label="Fit to view" onClick={fit}>Fit</ViewButton>
        </div>

        <div
          ref={viewportRef}
          onPointerDown={onPointerDown}
          className="h-[min(72vh,760px)] w-full cursor-grab touch-none select-none active:cursor-grabbing"
        >
          <div
            className="relative origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
          <svg
            className="pointer-events-none absolute inset-0 text-border-stronger"
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            {layout.links.map(link => {
              const related = !hovered || link.childId === hovered || link.parentIds.includes(hovered);
              const joined = link.parents.length > 1;
              // A single parent runs straight to the child: there is nothing to
              // join, and a stem would imply a merge that did not happen.
              const endX = joined ? link.junctionX : link.childX;
              const endY = joined ? link.junctionY : link.childY;
              const stroke = related && hovered ? 2.5 : 1.5;
              return (
                <g
                  key={link.childId}
                  className="transition-opacity duration-150"
                  opacity={related ? (hovered ? 1 : 0.55) : 0.08}
                  strokeDasharray={link.carried ? '3 3' : undefined}
                >
                  {link.parents.map((parent, i) => {
                    // Hovering one parent should still admit the other exists.
                    // Showing only the hovered limb would repeat the original
                    // lie in a quieter voice: this child had two parents, and
                    // hiding the second one makes it look like it had one. The
                    // co-parent's limb therefore stays visible but reads as
                    // secondary, thin and dashed, so the hovered contribution
                    // is obvious without erasing the other.
                    const coParent = Boolean(hovered) && joined && link.childId !== hovered && parent.id !== hovered;
                    const bend = Math.max(16, (endY - parent.y) / 2);
                    return (
                      <path
                        key={i}
                        d={`M ${parent.x} ${parent.y} C ${parent.x} ${parent.y + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={coParent ? 1 : stroke}
                        strokeDasharray={coParent ? '2 4' : undefined}
                        opacity={coParent ? 0.55 : undefined}
                      />
                    );
                  })}
                  {joined && (
                    <>
                      <path
                        d={`M ${link.junctionX} ${link.junctionY} L ${link.childX} ${link.childY}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={stroke}
                        strokeDasharray={undefined}
                      />
                      {/* The dot is what makes the merge a single event rather
                          than two lines that happen to touch. */}
                      <circle cx={link.junctionX} cy={link.junctionY} r={3} fill="currentColor" strokeDasharray={undefined} />
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {layout.nodes.map(({ candidate, x, y, gen, dead }) => {
            const src = assetLink(candidate.asset?.url);
            const shown = nodeScore(candidate);
            return (
              <button
                key={candidate.id}
                onClick={() => { if (travelled.current <= DRAG_SLOP) onInspect(candidate); }}
                onMouseEnter={() => setHovered(candidate.id)}
                onMouseLeave={() => setHovered(current => (current === candidate.id ? null : current))}
                onFocus={() => { setHovered(candidate.id); reveal(x, y); }}
                onBlur={() => setHovered(current => (current === candidate.id ? null : current))}
                title={`${scoreLabel(candidate)}. ${shown.title} ${candidate.mutation ?? ''}`}
                style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                className={cn(
                  'focus-ring absolute flex flex-col overflow-hidden rounded-md border text-left transition-all',
                  candidate.selected
                    ? 'border-brand-400 ring-1 ring-brand-400'
                    : 'border-border hover:border-border-stronger',
                  isCarriedOver(candidate) ? 'bg-surface-200' : 'bg-surface-100',
                  // Faded, never hidden: it was made and reviewed, it just was
                  // not bred from, and that is worth being able to look at.
                  dead ? 'opacity-40 hover:opacity-100' : isCarriedOver(candidate) ? 'opacity-80' : ''
                )}
              >
                <span className="relative block aspect-square w-full bg-surface-300">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-[9px] uppercase text-foreground-muted">
                      not rendered
                    </span>
                  )}
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] text-white">g{gen}</span>
                </span>
                <span className="flex flex-1 flex-col justify-center gap-0.5 px-2 py-1.5">
                  <span className="flex items-baseline justify-between gap-1">
                    <span className="truncate text-[11px] text-foreground-lighter">
                      {isCarriedOver(candidate) ? 'copy' : candidate.id.slice(-4)}
                    </span>
                    {shown.value !== null && (
                      <span className="text-sm tabular-nums text-foreground">{shown.value}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'truncate text-[10px]',
                      shown.value === null ? 'text-foreground-muted/70 italic' : 'text-foreground-muted'
                    )}
                  >
                    {shown.unit}
                  </span>
                </span>
              </button>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ViewButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      // Stops a click on the controls from being read as the end of a pan.
      onPointerDown={event => event.stopPropagation()}
      className="focus-ring min-w-7 rounded-md border border-border bg-surface-100/90 px-2 py-1 text-xs text-foreground-light backdrop-blur transition-colors hover:text-foreground"
    >
      {children}
    </button>
  );
}
