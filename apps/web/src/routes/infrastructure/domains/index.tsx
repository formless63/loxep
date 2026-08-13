import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import DomainsTable from '@/features/infrastructure/components/domains-table';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

const domainsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  name: z.string().optional(),
  state: z.string().optional()
});

export const Route = createFileRoute('/infrastructure/domains/')({
  validateSearch: zodValidator(domainsSearchSchema),
  component: InfrastructureDomains
});

function InfrastructureDomains() {
  return (
    <InfrastructurePage
      title='Domains'
      description='Every domain Loxep declares DNS intent for: provisioning state, hosting target, mail, and drift.'
    >
      <DomainsTable />
    </InfrastructurePage>
  );
}
