import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import RunsTable from '@/features/infrastructure/components/runs-table';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

const runsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional()
});

export const Route = createFileRoute('/infrastructure/runs/')({
  validateSearch: zodValidator(runsSearchSchema),
  component: InfrastructureRuns
});

function InfrastructureRuns() {
  return (
    <InfrastructurePage title='Reconcile runs' description='What the reconciler did, step by step.'>
      <RunsTable />
    </InfrastructurePage>
  );
}
