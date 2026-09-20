'use client';

import { useMemo, useState } from 'react';
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
          return { x: parent.x + NODE_W / 2, y: parent.y + NODE_H };
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

      <div className="overflow-auto rounded-lg border border-border bg-surface-75 p-5">
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
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
                    // Vertical cubic: leaves the parent downward and arrives
                    // downward, so crossings stay legible when one parent has
                    // many children, which is the common case here.
                    const bend = Math.max(16, (endY - parent.y) / 2);
                    return (
                      <path
                        key={i}
                        d={`M ${parent.x} ${parent.y} C ${parent.x} ${parent.y + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={stroke}
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
                onClick={() => onInspect(candidate)}
                onMouseEnter={() => setHovered(candidate.id)}
                onMouseLeave={() => setHovered(current => (current === candidate.id ? null : current))}
                onFocus={() => setHovered(candidate.id)}
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
  );
}
