import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, formatMoney, formatScore } from '@/lib/format';
import { marketItemAcquisitionLinksQuery } from '@/features/inventory/api/queries';

/**
 * "We bought one" — the return trip of the `/market` handoff: does an
 * observed item show whether we ever bought one, and what became of it. A
 * real, working read (`acquisition_opportunity_links` joined out to
 * `acquisitions`/`inventory_items`) — realized-contribution figures are not
 * shown here because that read model lives in `@loxep/inventory`, which this
 * workspace cannot reach yet (see `@/server/inventory-functions.ts`).
 */
export default function WeBoughtOnePanel({ marketplaceItemId }: { marketplaceItemId: string }) {
  const { data } = useQuery(marketItemAcquisitionLinksQuery(marketplaceItemId));

  if (data === undefined || data.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>We bought one</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {data.map((link) => (
          <div key={link.id} className='flex flex-wrap items-center gap-2 text-sm'>
            <Badge variant='secondary'>{link.linkKind.replace(/_/g, ' ')}</Badge>
            {link.acquisitionId && (
              <Link
                to='/inventory/acquisitions/$id'
                params={{ id: link.acquisitionId }}
                className='hover:underline'
              >
                {link.acquisitionReferenceCode}
              </Link>
            )}
            {link.inventoryItemId && (
              <Link
                to='/inventory/stock/$id'
                params={{ id: link.inventoryItemId }}
                className='hover:underline'
              >
                {link.inventoryItemCode}
              </Link>
            )}
            {link.targetPriceAmount && (
              <span className='text-muted-foreground'>
                target {formatMoney(link.targetPriceAmount, link.targetCurrency)}
              </span>
            )}
            {link.scoreAtLink && (
              <span className='text-muted-foreground'>
                score {formatScore(Number(link.scoreAtLink))} at link time
              </span>
            )}
            <span className='text-muted-foreground text-xs'>{formatDateTime(link.linkedAt)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
