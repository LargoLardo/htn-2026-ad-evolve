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
    const position = new Map<string, { x: number; y: number; candidate: Candidate; gen: number }>();

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
        });
      });
    });

    const edges: { from: string; to: string; carried: boolean }[] = [];
    for (const { candidate } of position.values()) {
      for (const parent of candidate.parents ?? []) {
        if (position.has(parent)) edges.push({ from: parent, to: candidate.id, carried: isCarriedOver(candidate) });
      }
    }

    return {
      width,
      height: rows.length * NODE_H + (rows.length - 1) * GAP_Y,
      nodes: [...position.values()],
      edges: edges.map(edge => {
        const a = position.get(edge.from)!, b = position.get(edge.to)!;
        return { ...edge, x1: a.x + NODE_W / 2, y1: a.y + NODE_H, x2: b.x + NODE_W / 2, y2: b.y };
      }),
    };
  }, [run]);

  if (!layout.nodes.length) return null;

  const carried = layout.edges.filter(edge => edge.carried).length;

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
        {carried > 0 && (
          <span className="text-foreground-light">
            {carried} of {layout.edges.length} links are copies, not new creatives.
          </span>
        )}
      </div>

      <div className="overflow-auto rounded-lg border border-border bg-surface-75 p-5">
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="pointer-events-none absolute inset-0 text-border-stronger"
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            {layout.edges.map((edge, i) => {
              const related = !hovered || edge.from === hovered || edge.to === hovered;
              return (
              <path
                key={i}
                // Vertical cubic: leaves the parent downward and enters the child
                // downward, so crossings stay legible when one parent has many
                // children, which is the common case here.
                d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + GAP_Y / 2}, ${edge.x2} ${edge.y2 - GAP_Y / 2}, ${edge.x2} ${edge.y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={related && hovered ? 2.5 : 1.5}
                strokeDasharray={edge.carried ? '3 3' : undefined}
                className="transition-opacity duration-150"
                opacity={related ? (hovered ? 1 : 0.55) : 0.08}
              />
              );
            })}
          </svg>

          {layout.nodes.map(({ candidate, x, y, gen }) => {
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
                  'focus-ring absolute flex flex-col overflow-hidden rounded-md border text-left transition-colors',
                  candidate.selected
                    ? 'border-brand-400 ring-1 ring-brand-400'
                    : 'border-border hover:border-border-stronger',
                  isCarriedOver(candidate) ? 'bg-surface-200 opacity-80' : 'bg-surface-100'
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
