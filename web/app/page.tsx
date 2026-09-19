import Nav from '@/components/layout/Nav';
import Footer from '@/components/layout/Footer';
import { SectionContainer } from '@/components/ui/section-container';
import { Panel } from '@/components/ui/panel';
import { ButtonLink } from '@/components/ui/button';
import { FlickeringGrid } from '@/components/effects/FlickeringGrid';

const STAGES = [
  { n: '01', title: 'Research once', body: 'Turn the product, audience and goal into evidence-linked creative hypotheses.' },
  { n: '02', title: 'Generate genomes', body: 'Every concept gets a hook, visual approach, emotional angle, proof point, CTA and palette.' },
  { n: '03', title: 'Screen, then render', body: 'A cheap heuristic screens every concept. Only the shortlist becomes images.' },
  { n: '04', title: 'Evaluate and select', body: 'Rank eligible candidates against your relative emotional priorities.' },
  { n: '05', title: 'Recombine and mutate', body: 'Preserve the best, mix parent genes, change individual traits, repeat.' },
  { n: '06', title: 'Review finalists', body: 'Inspect genomes, compare generations, download the drafts and the full run.' },
];

const MODES = [
  {
    name: 'Demo',
    span: 'md:col-span-12 xl:col-span-6',
    tagline: 'Runs with no API key and no network.',
    rows: [
      ['Research', 'Brief-derived hypotheses, seeded gene pools'],
      ['Images', 'Local SVG storyboard illustrations'],
      ['Scoring', 'Transparent keyword and design heuristic'],
    ],
  },
  {
    name: 'Live',
    span: 'md:col-span-6 xl:col-span-3',
    tagline: 'Adds an OpenAI key. Makes paid API calls.',
    rows: [
      ['Research', 'Web search with checked source provenance'],
      ['Images', 'Generated square PNG drafts'],
      ['Scoring', 'Same unvalidated genome heuristic'],
    ],
  },
  {
    name: 'TRIBE',
    span: 'md:col-span-6 xl:col-span-3',
    tagline: 'Adds a calibrated GPU worker.',
    rows: [
      ['Research', 'Same live research and generation'],
      ['Images', 'Real PNG submitted to the worker'],
      ['Scoring', 'Neural features + your fitted decoder'],
    ],
  },
];

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main" className="relative min-h-screen">
        {/* Supabase's hero is asymmetric rather than centred: headline in column
            one, subcopy bottom-aligned against it in column two. The flickering
            grid sits behind it, masked so it fades out before it reaches the
            text and never competes with the headline for attention. */}
        <div className="relative isolate overflow-hidden">
          <FlickeringGrid
            className="absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_60%_at_30%_40%,black_10%,transparent_70%)]"
            squareSize={4}
            gridGap={6}
            flickerChance={0.25}
            maxOpacity={0.22}
          />
          <SectionContainer className="pt-12 pb-8 md:pt-32 md:pb-16">
          <div className="flex flex-col gap-6 lg:gap-8">
            <div className="grid grid-cols-1 items-end gap-4 lg:grid-cols-2">
              <h1 className="text-4xl text-foreground sm:text-5xl sm:leading-none">
                <span className="block">Evolve the ad,</span>
                <span className="block text-brand">not just the copy.</span>
              </h1>
              <p className="text-balance text-foreground-lighter">
                A population of creative concepts, each with an inspectable genome.
                Screen them cheaply, render only the survivors, then recombine and
                mutate across generations, with the full lineage visible the whole way.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ButtonLink href="/dashboard" variant="primary" size="large">
                Start an experiment
              </ButtonLink>
              <ButtonLink href="#loop" variant="default" size="large">
                How it works
              </ButtonLink>
            </div>
          </div>
          </SectionContainer>
        </div>

        <section id="loop" className="border-t border-border">
          <SectionContainer>
            <div className="flex flex-col gap-3">
              <span className="label">The loop</span>
              <h2 className="max-w-[35ch] text-balance text-3xl tracking-tight text-foreground md:text-4xl">
                Six stages, run for as many generations as you choose.
              </h2>
            </div>
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {STAGES.map((stage) => (
                <Panel key={stage.n} innerClassName="flex h-full flex-col gap-2 p-5">
                  <span className="font-mono text-xs text-brand">{stage.n}</span>
                  <h3 className="text-lg text-foreground">{stage.title}</h3>
                  <p className="text-sm text-foreground-lighter">{stage.body}</p>
                </Panel>
              ))}
            </div>
          </SectionContainer>
        </section>

        <section id="modes" className="border-t border-border">
          <SectionContainer>
            <div className="flex flex-col gap-3">
              <span className="label">Three modes</span>
              <h2 className="max-w-[35ch] text-balance text-3xl tracking-tight text-foreground md:text-4xl">
                Start offline. Add a key when you want real generation.
              </h2>
            </div>
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-12">
              {MODES.map((mode) => (
                <Panel
                  key={mode.name}
                  className={mode.span}
                  innerClassName="flex h-full flex-col gap-4 p-5"
                >
                  <div className="flex flex-col gap-1">
                    <h3 className="text-xl text-foreground">{mode.name}</h3>
                    <p className="text-sm text-foreground-lighter">{mode.tagline}</p>
                  </div>
                  <dl className="mt-auto flex flex-col gap-2 border-t border-border-muted pt-4">
                    {mode.rows.map(([key, value]) => (
                      <div key={key} className="flex flex-col gap-0.5">
                        <dt className="font-mono text-[11px] uppercase tracking-wider text-foreground-muted">
                          {key}
                        </dt>
                        <dd className="text-sm text-foreground-light">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </Panel>
              ))}
            </div>
            {/* The README is emphatic about this, so the marketing page says it too. */}
            <p className="mt-6 max-w-[80ch] text-sm text-foreground-lighter">
              TRIBE v2 predicts cortical activity. It does not ship a validated
              joy/trust/curiosity/desire scorer, and this prototype does not pretend
              that demo scores come from it. Demo scores are an unvalidated design
              heuristic, not measured emotion and not a conversion forecast.
            </p>
          </SectionContainer>
        </section>

        <section id="cta" className="border-t border-border">
          <SectionContainer className="flex flex-col items-center gap-6 py-24 text-center md:py-32">
            <h2 className="max-w-[24ch] text-balance text-3xl tracking-tight text-foreground-lighter md:text-4xl">
              Bring a product brief.{' '}
              <span className="text-foreground">Leave with a lineage.</span>
            </h2>
            <ButtonLink href="/dashboard" variant="primary" size="large">
              Open the lab
            </ButtonLink>
          </SectionContainer>
        </section>
      </main>
      <Footer />
    </>
  );
}
