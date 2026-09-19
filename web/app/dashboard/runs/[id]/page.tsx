import Lab from '@/components/dashboard/Lab';

export const metadata = { title: 'Experiment — Evolve' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Lab runId={id} />;
}
