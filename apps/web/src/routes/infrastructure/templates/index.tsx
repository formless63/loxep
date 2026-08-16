import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import TemplatesTable from '@/features/infrastructure/components/templates-table';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

const templatesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  name: z.string().optional()
});

export const Route = createFileRoute('/infrastructure/templates/')({
  validateSearch: zodValidator(templatesSearchSchema),
  component: InfrastructureTemplates
});

function InfrastructureTemplates() {
  return (
    <InfrastructurePage
      title='Provisioning templates'
      description='A template is a strictly ordered list of idempotent steps — a compiler and a driver, never a second workflow engine.'
    >
      <TemplatesTable />
    </InfrastructurePage>
  );
}
