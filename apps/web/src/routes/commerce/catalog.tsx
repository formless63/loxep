import { createFileRoute } from '@tanstack/react-router';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import CatalogTable from '@/features/commerce/components/catalog-table';

export const Route = createFileRoute('/commerce/catalog')({
  component: CommerceCatalog
});

function CommerceCatalog() {
  return (
    <CommercePage
      title='Catalog'
      description='Loxep-internal SKU identity, independent of any provider listing. Minted automatically the first time an inventory item is listed.'
    >
      <CatalogTable />
    </CommercePage>
  );
}
