import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { etsyKeysetStatusQuery } from '@/features/settings/api/queries';
import EtsyKeysetDialog from '@/features/settings/components/etsy-keyset-dialog';
import { IntegrationCard } from '@/features/settings/components/integration-card';
import {
  getIntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';

/**
 * The Etsy catalog card, admin-only, hosting the ONE global Etsy application
 * keyset (`storeEtsyKeyset` / `ETSY_KEYSET_SECRET_KEY` in
 * `@/server/etsy-oauth`) — mirrors `EbayIntegrationCard`'s shape exactly.
 * Every Etsy shop shares it, which is why it is set up here rather than
 * against any one shop on the connections page.
 */
export default function EtsyIntegrationCard({
  statusInput
}: {
  statusInput: Omit<IntegrationStatusInput, 'etsyKeyset'>;
}) {
  const { data, isPending } = useQuery(etsyKeysetStatusQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const service = getIntegrationService('etsy');
  const status = service.status({ ...statusInput, etsyKeyset: data ?? null });

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
        <p className='text-muted-foreground text-sm'>Add Etsy shops from the connections page.</p>
      )}
      {dialogOpen && <EtsyKeysetDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </IntegrationCard>
  );
}
