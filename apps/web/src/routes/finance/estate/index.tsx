import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { FinancePage } from '@/features/finance/components/finance-page';
import FinanceEstateIndexTable from '@/features/finance/estate/components/estate-index-table';

const estateIndexSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  name: z.string().optional(),
  provider: z.string().optional()
});

/**
 * `/finance/estate` — Rule N2's "`/finance` gains the equivalent when
 * Invoice Ninja's wave lands": every finance-category connection listed
 * once, with a link into its own `/finance/estate/$connectionId` page.
 * Deliberately the ONLY estate-related nav entry this workspace gets — no
 * per-provider sidebar items, matching `/infrastructure/estate`'s own role.
 */
export const Route = createFileRoute('/finance/estate/')({
  validateSearch: zodValidator(estateIndexSearchSchema),
  component: FinanceEstateIndex
});

function FinanceEstateIndex() {
  return (
    <FinancePage
      title='Estates'
      description='Every finance connection, read live — open one to browse its actual estate.'
    >
      <FinanceEstateIndexTable />
    </FinancePage>
  );
}
