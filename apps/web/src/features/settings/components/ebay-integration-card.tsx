import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ebayKeysetStatusQuery } from '@/features/settings/api/queries';
import EbayKeysetDialog from '@/features/settings/components/ebay-keyset-dialog';

/**
 * Admin-only card for the ONE global eBay application keyset (`storeEbayKeyset` /
 * `EBAY_KEYSET_SECRET_KEY` in `@/server/ebay-oauth`) — every eBay connection shares
 * it, so it lives above the connections table rather than inside any one
 * connection's row. Only a configured-status badge is shown; the keyset
 * values themselves are write-only and never returned by any server function.
 */
export default function EbayIntegrationCard() {
  const { data, isPending } = useQuery(ebayKeysetStatusQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-4'>
        <div>
          <CardTitle className='text-base'>eBay integration</CardTitle>
          <CardDescription>
            The application keyset behind every eBay connection&apos;s OAuth consent flow.
          </CardDescription>
        </div>
        <Button size='sm' variant='outline' onClick={() => setDialogOpen(true)}>
          {data?.configured ? 'Rotate keyset' : 'Configure keyset'}
        </Button>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='h-6 w-64' />
        ) : (
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <Badge variant={data?.configured ? 'secondary' : 'destructive'}>
              {data?.configured ? 'Configured' : 'Not configured'}
            </Badge>
            {data?.configured && (
              <>
                <Badge variant='outline'>{data.environment}</Badge>
                <Badge variant='outline'>source: {data.source}</Badge>
                {!data.ruNameConfigured && (
                  <Badge variant='destructive'>
                    RuName missing — &quot;Connect eBay account&quot; will fail
                  </Badge>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
      {dialogOpen && <EbayKeysetDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </Card>
  );
}
