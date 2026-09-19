import RunView from '@/components/dashboard/RunView';

export const metadata = { title: 'Experiment | Advolve' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView runId={id} />;
}
