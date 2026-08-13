import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import ItemsTable from '@/features/inventory/components/items-table';
import IntakeForm from '@/features/inventory/components/intake-form';

/**
 * List route named `stock.index.tsx`, not `stock.tsx` — `stock.$id.tsx` is a
 * sibling, and a flat `stock.tsx` would become that detail route's layout
 * instead of the list content (the same route-nesting lesson
 * `routes/finance/expenses.index.tsx` recorded for `expenses.$id.tsx`).
 */
const stockSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  status: z.string().optional(),
  locationId: z.string().optional(),
  conditionCode: z.string().optional()
});

export const Route = createFileRoute('/inventory/stock/')({
  validateSearch: zodValidator(stockSearchSchema),
  component: InventoryStock
});

function InventoryStock() {
  const [intakeOpen, setIntakeOpen] = React.useState(false);

  return (
    <InventoryPage
      title='Stock'
      description='Every unit on hand — filter by status, location, or condition. Intake review is this list filtered to Intake.'
      actions={
        <Button size='sm' onClick={() => setIntakeOpen(true)}>
          <Icons.add />
          Add item
        </Button>
      }
    >
      <ItemsTable />
      {intakeOpen && <IntakeForm open={intakeOpen} onOpenChange={setIntakeOpen} />}
    </InventoryPage>
  );
}
