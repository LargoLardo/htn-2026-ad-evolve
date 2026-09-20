import Nav from '@/components/layout/Nav';
import Footer from '@/components/layout/Footer';
import { SectionContainer } from '@/components/ui/section-container';
import { Panel } from '@/components/ui/panel';
import { ButtonLink } from '@/components/ui/button';
import { FlickeringGrid } from '@/components/effects/FlickeringGrid';

const STAGES = [
  { n: '01', title: 'Research once', body: 'Turn the product, audience and goal into evidence-linked creative hypotheses.' },
  { n: '02', title: 'Generate genomes', body: 'Every concept gets a hook, visual approach, emotional angle, proof point, CTA, palette, motion and audio.' },
  { n: '03', title: 'Generate and review media', body: 'Generate image or video takes, review the media, and shortlist candidates for neural evaluation.' },
  { n: '04', title: 'Evaluate and select', body: 'Rank reviewed candidates by neural score against one fixed original baseline.' },
  { n: '05', title: 'Recombine and mutate', body: 'Preserve the best, mix parent genes, change one gene per child, repeat.' },
  { n: '06', title: 'Review finalists', body: 'Inspect genomes, compare generations, download the drafts and the full run.' },
];

const MODES = [
  {
    name: 'Image ads', span: 'md:col-span-12 xl:col-span-6',
    tagline: 'Generate takes with OpenAI, guided by your brief or an uploaded original.',
    rows: [['Research', 'Web search with checked source provenance'], ['Generation', 'Square PNG drafts'], ['Evaluation', 'A 10-second still video for TRIBE inference']],
  },
  {
    name: 'Video ads', span: 'md:col-span-6 xl:col-span-3',
    tagline: 'Seedance 2.0 through Pika, with motion and audio traits.',
    rows: [['Generation', 'Portrait, landscape or square videos'], ['Review', 'Six sampled frames plus an audio transcript'], ['Evolution', 'Preserve the winner and mutate one gene per child']],
  },
  {
    name: 'Neural scoring', span: 'md:col-span-6 xl:col-span-3',
    tagline: 'Four-family Glasser scoring against one shared baseline.',
    rows: [['Baseline', 'One original creative, fixed across all generations'], ['Aggregation', 'Four equally weighted Glasser families'], ['Selection', 'Highest neural score among reviewed takes']],
  },
];

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main" className="relative min-h-screen">
        {/* One centred column holding the whole viewport, less the 64px sticky
            nav above it. svh rather than vh so mobile browser chrome retracting
            does not make the section taller than the screen it is measured
            against. The flickering grid is masked to a centred ellipse so it
            fades out before it reaches the text. */}
        <div className="relative isolate flex min-h-[calc(100svh-4rem)] items-center overflow-hidden">
          <FlickeringGrid
            className="absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,black_10%,transparent_75%)]"
            squareSize={4}
            gridGap={6}
            flickerChance={0.25}
            maxOpacity={0.22}
          />
          <SectionContainer className="py-16">
            <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center lg:gap-8">
              <h1 className="text-4xl text-foreground sm:text-5xl sm:leading-none md:text-6xl">
                <span className="block">Evolve the ad,</span>
                <span className="block text-brand">not just the copy.</span>
              </h1>
              <p className="max-w-[60ch] text-balance text-lg text-foreground-lighter">
                A population of creative concepts, each with an inspectable genome.
                Generate and review image or video takes, score the shortlist, then recombine and
                mutate across generations, with the full lineage visible the whole way.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
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
                  <span className="text-xs font-medium tabular-nums text-brand">{stage.n}</span>
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
              <span className="label">Images, videos and neural feedback</span>
              <h2 className="max-w-[35ch] text-balance text-3xl tracking-tight text-foreground md:text-4xl">
                Evolve image and video ads against one shared baseline.
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
                        <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-foreground-muted">
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
              TRIBE v2 predicts cortical activity. Neural scoring requires no fitted decoder,
              but is not a validated emotion or conversion score. If every media review fails,
              a nonempty provisional shortlist remains visible with its failed checks intact.
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
