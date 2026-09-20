'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Layers, Network, SlidersHorizontal } from 'lucide-react';
import { BrandMark } from '@/components/layout/BrandMark';
import { Dialog } from '@/components/ui/dialog';
import { getConfig, listRuns } from '@/lib/api';
import type { Config, RunSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

// Experiments is the only destination. "Lab" used to be a second entry for the
// same noun, which made opening a saved run look like leaving the section.
const NAV = [{ href: '/dashboard', label: 'Experiments', icon: Layers }];

export default function Sidebar() {
  const pathname = usePathname();
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [dialog, setDialog] = useState<'how' | 'connections' | null>(null);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
    listRuns().then(setRuns).catch(() => {});
  }, [pathname]);

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[220px] flex-col border-r border-border bg-alternative max-lg:w-[64px] max-lg:items-center">
        {/* Brand sits in its own band whose height matches the top bar, so the
            two horizontal rules line up across the sidebar seam. The collapsed
            64px rail cannot fit the wordmark, so it drops out there. */}
        <div className="flex h-12 shrink-0 items-center border-b border-border px-4 max-lg:justify-center max-lg:px-0">
          <BrandMark className="max-lg:hidden" />
        </div>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4 max-lg:w-full max-lg:items-center max-lg:px-2">
          <p className="label px-3 pb-1 max-lg:hidden">Workspace</p>

          {NAV.map(({ href, label, icon: Icon }) => {
            // Any run page is still inside Experiments, so keep it highlighted.
            const active = pathname === href || pathname.startsWith('/dashboard/runs');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'focus-ring flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors max-lg:justify-center max-lg:px-2',
                  active
                    ? 'bg-brand-200 text-brand'
                    : 'text-foreground-light hover:bg-surface-200 hover:text-foreground'
                )}
              >
                <Icon size={17} strokeWidth={1.75} />
                <span className="max-lg:hidden">{label}</span>
                {runs.length > 0 && (
                  <span className="ml-auto text-xs text-foreground-lighter max-lg:hidden">
                    {runs.length}
                  </span>
                )}
              </Link>
            );
          })}

          <button
            type="button"
            onClick={() => setDialog('how')}
            className="focus-ring flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground-light transition-colors hover:bg-surface-200 hover:text-foreground max-lg:justify-center max-lg:px-2"
          >
            <Network size={17} strokeWidth={1.75} />
            <span className="max-lg:hidden">How it works</span>
          </button>

          <div className="mt-auto flex w-full flex-col gap-1 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setDialog('connections')}
              className="focus-ring flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground-light transition-colors hover:bg-surface-200 hover:text-foreground max-lg:justify-center max-lg:px-2"
            >
              <SlidersHorizontal size={17} strokeWidth={1.75} />
              <span className="max-lg:hidden">Connections</span>
              <span
                aria-hidden
                className={cn(
                  'ml-auto size-1.5 rounded-full max-lg:hidden',
                  config?.liveResearch ? 'bg-brand' : 'bg-foreground-muted'
                )}
              />
            </button>
          </div>
        </div>
      </aside>

      <Dialog open={dialog === 'how'} onClose={() => setDialog(null)} label="How Advolve works">
        <div className="flex flex-col gap-4 text-sm text-foreground-light">
          <h2 className="text-2xl text-foreground">A population of ideas. A visible lineage.</h2>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li><strong className="font-normal text-foreground">Research once.</strong> Turn the product, audience and goal into evidence-linked creative hypotheses.</li>
            <li><strong className="font-normal text-foreground">Generate genomes.</strong> Give every concept a hook, visual approach, emotional angle, proof point, call to action, palette, motion and audio.</li>
            <li><strong className="font-normal text-foreground">Generate and review media.</strong> Create images or Seedance video takes. Review actual pixels, copy and claims; video review samples six frames and transcribes audio. Shortlist reviewed takes and retain provisional drafts if all fail.</li>
            <li><strong className="font-normal text-foreground">Evaluate and select.</strong> Score shortlisted takes with Percept’s four Glasser families against a fixed original baseline. Images become 10-second videos. Selection takes the largest predicted response; emotion priorities guide concepts only. Read that number as response magnitude, not quality.</li>
            <li><strong className="font-normal text-foreground">Recombine and mutate.</strong> Preserve the best candidate, mix parent genes and change exactly one gene per child.</li>
            <li><strong className="font-normal text-foreground">Review the finalists.</strong> Inspect genomes, compare generations and download the drafts.</li>
          </ol>
          <h3 className="text-lg text-foreground">What the score means</h3>
          <p>
            Percept scoring summarizes predicted cortical activity. It needs no fitted decoder,
            but is not a validated emotion or conversion score. An uploaded original is the fixed
            baseline; otherwise the first shortlisted take establishes it.
          </p>
          <p>
            Treat the number as the size of a predicted response, not a grade. Published work
            testing TRIBE against real viewer engagement on YouTube found a correlation
            indistinguishable from zero, no better than loudness. The maps are the useful
            output: they say which region of an ad carries the response, which holds whether
            or not the overall magnitude predicts anything.
          </p>
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'connections'}
        onClose={() => setDialog(null)}
        label="Model connections"
      >
        <div className="flex flex-col gap-4 text-sm text-foreground-light">
          <h2 className="text-2xl text-foreground">Your models, connected locally.</h2>
          {config ? (
            <>
              <dl className="flex flex-col divide-y divide-border border-y border-border">
                {[
                  ['Research & concept generation', config.liveResearch],
                  ['Image generation', config.liveImages],
                  ['Seedance 2.0 videos', config.liveVideos],
                  ['Media review', config.visualScreening],
                  ['Percept/TRIBE scoring', config.tribe],
                ].map(([label, on]) => (
                  <div key={label as string} className="flex items-center justify-between gap-4 py-2.5">
                    <dt>{label as string}</dt>
                    <dd className={on ? 'text-brand' : 'text-foreground-lighter'}>
                      {on ? 'Configured' : 'Not connected'}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Credentials stay in the local server environment and are never sent to the browser.
                Configured credentials do not guarantee model access or worker readiness.
              </p>
              <p className="text-xs text-foreground-lighter">
                Text model <code className="text-foreground">{config.textModel}</code>
                <br />
                Image model <code className="text-foreground">{config.imageModel}</code>
                <br />
                Review model <code className="text-foreground">{config.screenModel}</code>
              </p>
              <p>
                To enable live generation, copy <code>.env.example</code> to <code>.env</code>, set{' '}
                <code>OPENAI_API_KEY</code> and <code>PIKA_API_KEY</code>, then restart the API server.
              </p>
              <h3 className="text-lg text-foreground">Percept/TRIBE scoring</h3>
              <p className="text-xs text-foreground-lighter">{config.tribeStatus}</p>
              <p>
                Needs an updated scoring endpoint (<code>BASETEN_TRIBE_ENDPOINT</code> with{' '}
                <code>BASETEN_API_KEY</code>, or <code>TRIBE_SCORE_URL</code> with optional <code>TRIBE_TOKEN</code>).
                See <code>worker/README.md</code>.
              </p>
              <p className="text-xs text-foreground-lighter">
                Decoder training: {config.decoderTraining}. This app never starts model downloads,
                extraction jobs or training.
              </p>
            </>
          ) : (
            <p>Loading configuration…</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
