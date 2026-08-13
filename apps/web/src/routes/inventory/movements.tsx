import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import MovementsTable from '@/features/inventory/components/movements-table';

const movementsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(20),
  sort: z.string().optional()
});

export const Route = createFileRoute('/inventory/movements')({
  validateSearch: zodValidator(movementsSearchSchema),
  component: InventoryMovements
});

function InventoryMovements() {
  return (
    <InventoryPage
      title='Movements'
      description='The append-only ledger — every quantity or location change, across every item.'
    >
      <MovementsTable />
    </InventoryPage>
  );
}
