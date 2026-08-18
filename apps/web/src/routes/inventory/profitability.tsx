import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import ProfitabilityContent, {
  ProfitabilitySkeleton
} from '@/features/inventory/components/profitability';
import { inventoryProfitabilityQuery } from '@/features/inventory/api/queries';

const PAGE_TITLE = 'Profitability';
const PAGE_DESCRIPTION =
  'Realized contribution, acquisition ROI, and stock-at-cost — the "did flipping make money" read.';

export const Route = createFileRoute('/inventory/profitability')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(inventoryProfitabilityQuery);
  },
  errorComponent: ProfitabilityError,
  component: InventoryProfitability
});

function ProfitabilityData() {
  const { data } = useSuspenseQuery(inventoryProfitabilityQuery);
  return <ProfitabilityContent data={data} />;
}

function InventoryProfitability() {
  return (
    <InventoryPage title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
      <React.Suspense fallback={<ProfitabilitySkeleton />}>
        <ProfitabilityData />
      </React.Suspense>
    </InventoryPage>
  );
}

function ProfitabilityError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <InventoryPage title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
      <Alert variant='destructive'>
        <AlertTitle>Profitability unavailable</AlertTitle>
        <AlertDescription className='flex flex-col items-start gap-2'>
          <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
          <Button variant='outline' size='sm' onClick={() => void router.invalidate()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </InventoryPage>
  );
}
