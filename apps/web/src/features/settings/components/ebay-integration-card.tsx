import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ebayKeysetStatusQuery } from '@/features/settings/api/queries';
import EbayKeysetDialog from '@/features/settings/components/ebay-keyset-dialog';
import { IntegrationCard } from '@/features/settings/components/integration-card';
import {
  getIntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';

/**
 * The eBay catalog card, admin-only, hosting the ONE global eBay application
 * keyset (`storeEbayKeyset` / `EBAY_KEYSET_SECRET_KEY` in
 * `@/server/ebay-oauth`). Every eBay account shares it, which is why it is
 * set up here on the integrations catalog rather than against any one
 * account on the connections page. Only a configured-status badge is shown;
 * the keyset values themselves are write-only and never returned by any
 * server function.
 */
export default function EbayIntegrationCard({
  statusInput
}: {
  /** Catalog inputs from the page; the keyset half is fetched here. */
  statusInput: Omit<IntegrationStatusInput, 'ebayKeyset'>;
}) {
  const { data, isPending } = useQuery(ebayKeysetStatusQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const service = getIntegrationService('ebay');
  const status = service.status({ ...statusInput, ebayKeyset: data ?? null });

  return (
    <IntegrationCard
      name={service.name}
      description={service.description}
      status={status}
      isPending={isPending}
      action={
        <Button size='sm' variant='outline' onClick={() => setDialogOpen(true)}>
          {data?.configured ? 'Rotate keyset' : 'Set up keyset'}
        </Button>
      }
    >
      {data?.configured === true && (
        <p className='text-muted-foreground text-sm'>
          {data.ruNameConfigured
            ? 'Add eBay accounts from the connections page.'
            : 'Add the redirect URL name from your eBay developer keyset before connecting an account.'}
        </p>
      )}
      {dialogOpen && <EbayKeysetDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </IntegrationCard>
  );
}
