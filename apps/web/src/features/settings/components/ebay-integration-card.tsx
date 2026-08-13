import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ebayKeysetStatusQuery } from '@/features/settings/api/queries';
import EbayKeysetDialog from '@/features/settings/components/ebay-keyset-dialog';
import {
  IntegrationCard,
  IntegrationEnabledToggle
} from '@/features/settings/components/integration-card';
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
 *
 * `enabled` (loxep-dgg) is this card's own visibility under the
 * `integrations.enabled` setting — the grid only renders this card at all
 * when it is visible (enabled, or revealed via "Show disabled"), so `isAdmin`
 * gates the enable/disable toggle the same way it already gates rendering
 * this card over the generic `CatalogCard`.
 */
export default function EbayIntegrationCard({
  statusInput,
  isAdmin,
  enabled
}: {
  /** Catalog inputs from the page; the keyset half is fetched here. */
  statusInput: Omit<IntegrationStatusInput, 'ebayKeyset'>;
  isAdmin: boolean;
  enabled: boolean;
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
      disabled={!enabled}
      action={
        <>
          <Button size='sm' variant='outline' onClick={() => setDialogOpen(true)}>
            {data?.configured ? 'Rotate keyset' : 'Set up keyset'}
          </Button>
          {isAdmin && (
            <IntegrationEnabledToggle
              serviceId={service.id}
              serviceName={service.name}
              enabled={enabled}
            />
          )}
        </>
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
