import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import IpAliasesTable from '@/features/infrastructure/components/ip-aliases-table';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

const aliasesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  name: z.string().optional(),
  source: z.string().optional()
});

export const Route = createFileRoute('/infrastructure/aliases')({
  validateSearch: zodValidator(aliasesSearchSchema),
  component: InfrastructureAliases
});

function InfrastructureAliases() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <InfrastructurePage
      title='IP aliases'
      description='Named dynamic-IP addresses — the primitive Pangolin itself does not have. Reference one from a rule instead of a literal address, and every referencing rule fans out together when the address changes.'
    >
      <IpAliasesTable isAdmin={isAdmin} />
    </InfrastructurePage>
  );
}
