import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import FleetTable from '@/features/infrastructure/components/fleet-table';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

const fleetSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  name: z.string().optional(),
  controlSurface: z.string().optional()
});

export const Route = createFileRoute('/infrastructure/fleet/')({
  validateSearch: zodValidator(fleetSearchSchema),
  component: InfrastructureFleet
});

function InfrastructureFleet() {
  return (
    <InfrastructurePage
      title='Fleet'
      description='Hosting targets a domain can point at — nodes, tunnel-connected hosts, and bare servers.'
    >
      <FleetTable />
    </InfrastructurePage>
  );
}
