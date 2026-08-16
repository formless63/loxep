import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import EstateIndexTable from '@/features/infrastructure/components/estate-index-table';

const estateIndexSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  name: z.string().optional(),
  provider: z.string().optional()
});

/**
 * `/infrastructure/estate` — Rule N2's "one nav entry per workspace, never
 * one per provider": every infrastructure-category connection listed once,
 * with a link into its own `/infrastructure/estate/$connectionId` page.
 * Deliberately the ONLY estate-related nav entry this workspace gets — no
 * per-provider sidebar items, matching `/settings/connections`' own role as
 * the universal connection list.
 */
export const Route = createFileRoute('/infrastructure/estate/')({
  validateSearch: zodValidator(estateIndexSearchSchema),
  component: InfrastructureEstateIndex
});

function InfrastructureEstateIndex() {
  return (
    <InfrastructurePage
      title='Estates'
      description='Every infrastructure connection, read live — open one to browse its actual estate.'
    >
      <EstateIndexTable />
    </InfrastructurePage>
  );
}
