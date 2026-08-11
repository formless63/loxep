import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard/overview')({
  component: DashboardOverview
});

function DashboardOverview() {
  return (
    <div className='flex flex-1 flex-col gap-4 p-4 pt-0'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Dashboard</h1>
        <p className='text-muted-foreground'>Loxep workspace overview.</p>
      </div>
    </div>
  );
}
