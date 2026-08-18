import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import MovementsTable from '@/features/inventory/components/movements-table';
import MovementsTrendChart from '@/features/inventory/components/movements-trend-chart';
import { RecordMovementDialog } from '@/features/inventory/components/movement-dialogs';

const movementsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(20),
  sort: z.string().optional(),
  // Server-side filter `fetchInventoryMovements` has always accepted
  // (`MovementFilterParams.acquisitionId`) but nothing called with it until
  // now — this is what `/inventory/acquisitions/$id`'s "View movements"
  // link uses to land on a per-lot view instead of the full unfiltered
  // ledger (loxep-1zg).
  acquisitionId: z.uuid().optional()
});

export const Route = createFileRoute('/inventory/movements')({
  validateSearch: zodValidator(movementsSearchSchema),
  component: InventoryMovements
});

function InventoryMovements() {
  const { acquisitionId } = Route.useSearch();
  const [recordOpen, setRecordOpen] = React.useState(false);
  return (
    <InventoryPage
      title='Movements'
      description={
        acquisitionId
          ? 'The append-only ledger, filtered to movements sourced from this lot.'
          : 'The append-only ledger — every quantity or location change, across every item.'
      }
      actions={
        <Button size='sm' onClick={() => setRecordOpen(true)}>
          <Icons.add />
          Record adjustment
        </Button>
      }
    >
      {/*
        The trend answers "am I receiving faster than selling, and is
        shrinkage trending up" across the whole ledger — a single lot's
        movement mix isn't that question, so it's scoped to the unfiltered
        view only (loxep-8e2).
      */}
      {acquisitionId === undefined && <MovementsTrendChart />}
      <MovementsTable acquisitionId={acquisitionId} />
      <RecordMovementDialog open={recordOpen} onOpenChange={setRecordOpen} />
    </InventoryPage>
  );
}
