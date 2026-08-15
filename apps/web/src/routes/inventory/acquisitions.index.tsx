import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import AcquisitionsTable from '@/features/inventory/components/acquisitions-table';
import AcquisitionForm from '@/features/inventory/components/acquisition-form';

/**
 * `acquisitions.index.tsx`, not `acquisitions.tsx` — `acquisitions.$id.tsx`
 * is a sibling; see `stock.index.tsx`'s doc for the route-nesting reason.
 */
const acquisitionsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  status: z.string().optional(),
  sourceKind: z.string().optional(),
  // `fetchAcquisitions`'s `connectionId` filter had no caller (loxep-1zg) —
  // this is what `/settings/connections`' "View acquisitions" row action
  // uses to land here filtered to what a specific connection has ingested.
  connectionId: z.uuid().optional()
});

export const Route = createFileRoute('/inventory/acquisitions/')({
  validateSearch: zodValidator(acquisitionsSearchSchema),
  component: InventoryAcquisitions
});

function InventoryAcquisitions() {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <InventoryPage
      title='Acquisitions'
      description='Lots, however they arrived — an auction box, an estate sale, a marketplace purchase.'
      actions={
        <Button size='sm' onClick={() => setCreateOpen(true)}>
          <Icons.add />
          New acquisition
        </Button>
      }
    >
      <AcquisitionsTable />
      <AcquisitionForm open={createOpen} onOpenChange={setCreateOpen} />
    </InventoryPage>
  );
}
