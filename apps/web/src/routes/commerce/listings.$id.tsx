import { createFileRoute, Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import ListingDetail from '@/features/commerce/components/listing-detail';

export const Route = createFileRoute('/commerce/listings/$id')({
  component: CommerceListingDetail
});

function CommerceListingDetail() {
  const { id } = Route.useParams();

  return (
    <CommercePage
      title='Listing'
      description='Status, price, and the sale it recorded, when it has one.'
      actions={
        <Link to='/commerce/listings' className='text-muted-foreground text-sm hover:underline'>
          <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
          Back to listings
        </Link>
      }
    >
      <ListingDetail listingId={id} />
    </CommercePage>
  );
}
