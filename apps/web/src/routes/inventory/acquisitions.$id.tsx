import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import AcquisitionDetail from '@/features/inventory/components/acquisition-detail';
import IntakeForm from '@/features/inventory/components/intake-form';

export const Route = createFileRoute('/inventory/acquisitions/$id')({
  component: InventoryAcquisitionDetail
});

function InventoryAcquisitionDetail() {
  const { id } = Route.useParams();
  const [intakeOpen, setIntakeOpen] = React.useState(false);

  return (
    <InventoryPage
      title='Acquisition'
      description='Cost components, landed cost by currency, and the items unpacked from this lot.'
      actions={
        <>
          <Button size='sm' variant='outline' onClick={() => setIntakeOpen(true)}>
            <Icons.add />
            Add item to this lot
          </Button>
          <Link
            to='/inventory/acquisitions'
            className='text-muted-foreground text-sm hover:underline'
          >
            <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
            Back to acquisitions
          </Link>
        </>
      }
    >
      <AcquisitionDetail acquisitionId={id} />
      {intakeOpen && (
        <IntakeForm
          open={intakeOpen}
          onOpenChange={setIntakeOpen}
          prefill={{ acquisitionId: id }}
        />
      )}
    </InventoryPage>
  );
}
