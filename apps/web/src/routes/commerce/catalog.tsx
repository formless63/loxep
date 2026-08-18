import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import CatalogTable from '@/features/commerce/components/catalog-table';
import CatalogItemFormDialog from '@/features/commerce/components/catalog-item-form-dialog';

export const Route = createFileRoute('/commerce/catalog')({
  component: CommerceCatalog
});

function CommerceCatalog() {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <CommercePage
      title='Catalog'
      description='Loxep-internal SKU identity, independent of any provider listing. Minted automatically the first time an inventory item is listed, or create one directly.'
      actions={
        <Button size='sm' onClick={() => setCreateOpen(true)}>
          <Icons.add />
          New catalog item
        </Button>
      }
    >
      <CatalogTable />
      <CatalogItemFormDialog open={createOpen} onOpenChange={setCreateOpen} item={null} />
    </CommercePage>
  );
}
