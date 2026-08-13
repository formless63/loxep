import { createFileRoute, Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import ItemDetail from '@/features/inventory/components/item-detail';

export const Route = createFileRoute('/inventory/stock/$id')({
  component: InventoryStockDetail
});

function InventoryStockDetail() {
  const { id } = Route.useParams();

  return (
    <InventoryPage
      title='Stock item'
      description='State, location, cost basis, and its movement history.'
      actions={
        <Link to='/inventory/stock' className='text-muted-foreground text-sm hover:underline'>
          <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
          Back to stock
        </Link>
      }
    >
      <ItemDetail itemId={id} />
    </InventoryPage>
  );
}
