import { createFileRoute, Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import OrderDetail from '@/features/commerce/components/order-detail';

export const Route = createFileRoute('/commerce/orders/$id')({
  component: CommerceOrderDetail
});

function CommerceOrderDetail() {
  const { id } = Route.useParams();

  return (
    <CommercePage
      title='Order'
      description='Lines, fees, refunds, fulfillments, and the totals underneath — plus the provenance that produced them.'
      actions={
        <Link to='/commerce/orders' className='text-muted-foreground text-sm hover:underline'>
          <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
          Back to orders
        </Link>
      }
    >
      <OrderDetail orderId={id} />
    </CommercePage>
  );
}
