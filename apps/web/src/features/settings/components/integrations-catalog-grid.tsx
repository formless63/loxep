import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  connectionsQuery,
  integrationsEnabledQuery,
  notificationEndpointsQuery
} from '@/features/settings/api/queries';
import EbayIntegrationCard from '@/features/settings/components/ebay-integration-card';
import EtsyIntegrationCard from '@/features/settings/components/etsy-integration-card';
import {
  IntegrationCard,
  IntegrationEnabledToggle
} from '@/features/settings/components/integration-card';
import {
  filterIntegrationServices,
  integrationCategories,
  integrationServices,
  isIntegrationEnabled,
  type IntegrationEnabledMap,
  type IntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';

/**
 * The integrations catalog: every service Loxep supports, its set-up state,
 * and the one action that continues its set-up. Rendered straight from the
 * typed registry (`@/features/settings/integrations-catalog`), so a service
 * appears here, in the connections page's per-service "Add account" actions,
 * and in the guided forms from a single definition.
 *
 * With 14+ providers the unfiltered grid is noisy (loxep-dgg), so it filters
 * by the `integrations.enabled` application setting: a disabled entry is
 * hidden by default and only reappears (dimmed, badged) behind "Show
 * disabled". Filtering is a display preference only — a disabled provider's
 * own status/connections are unaffected, and admins get a per-card toggle to
 * change the setting from right here.
 */
export default function IntegrationsCatalogGrid({ isAdmin }: { isAdmin: boolean }) {
  const { data: connections, isPending: connectionsPending } = useQuery(connectionsQuery);
  const { data: endpoints, isPending: endpointsPending } = useQuery(notificationEndpointsQuery);
  const { data: enabledMap, isPending: enabledMapPending } = useQuery(integrationsEnabledQuery);
  const [showDisabled, setShowDisabled] = React.useState(false);

  const statusInput: IntegrationStatusInput = {
    connections: connections ?? [],
    endpoints: endpoints ?? [],
    ebayKeyset: null,
    etsyKeyset: null
  };
  const isPending = connectionsPending || endpointsPending;
  const map: IntegrationEnabledMap = enabledMap ?? {};
  const hiddenCount = integrationServices.filter(
    (service) => !isIntegrationEnabled(map, service.id)
  ).length;

  return (
    <div className='flex flex-col gap-8'>
      {hiddenCount > 0 && (
        <div className='flex items-center gap-2'>
          <Switch
            id='show-disabled-integrations'
            checked={showDisabled}
            onCheckedChange={setShowDisabled}
            disabled={enabledMapPending}
          />
          <Label htmlFor='show-disabled-integrations' className='text-muted-foreground text-sm'>
            Show disabled ({hiddenCount})
          </Label>
        </div>
      )}
      {integrationCategories.map((category) => {
        const categoryServices = integrationServices.filter(
          (service) => service.category === category
        );
        const services = filterIntegrationServices(categoryServices, map, {
          includeDisabled: showDisabled
        });
        if (services.length === 0) return null;
        return (
          <section key={category} className='flex flex-col gap-3'>
            <h2 className='text-lg font-medium'>{category}</h2>
            <div className='grid gap-4 md:grid-cols-2'>
              {services.map((service) => {
                const enabled = isIntegrationEnabled(map, service.id);
                return service.manage.kind === 'ebay-keyset' && isAdmin ? (
                  <EbayIntegrationCard
                    key={service.id}
                    statusInput={statusInput}
                    isAdmin={isAdmin}
                    enabled={enabled}
                  />
                ) : service.manage.kind === 'etsy-keyset' && isAdmin ? (
                  <EtsyIntegrationCard
                    key={service.id}
                    statusInput={statusInput}
                    isAdmin={isAdmin}
                    enabled={enabled}
                  />
                ) : (
                  <CatalogCard
                    key={service.id}
                    service={service}
                    statusInput={statusInput}
                    isPending={isPending}
                    isAdmin={isAdmin}
                    enabled={enabled}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A registry-driven card. The eBay/Etsy keyset cards are the one exception
 * (each owns an admin-only dialog and its own status query) and are
 * rendered above.
 */
function CatalogCard({
  service,
  statusInput,
  isPending,
  isAdmin,
  enabled
}: {
  service: IntegrationService;
  statusInput: IntegrationStatusInput;
  isPending: boolean;
  isAdmin: boolean;
  enabled: boolean;
}) {
  const manage = service.manage;
  return (
    <IntegrationCard
      id={service.id}
      name={service.name}
      description={service.description}
      status={service.status(statusInput)}
      isPending={isPending}
      disabled={!enabled}
      action={
        <>
          {manage.kind === 'route' ? (
            <Button size='sm' variant='outline' asChild>
              <Link to={manage.to}>{manage.label}</Link>
            </Button>
          ) : (
            <Button size='sm' variant='outline' disabled>
              Administrators only
            </Button>
          )}
          {isAdmin && (
            <IntegrationEnabledToggle
              serviceId={service.id}
              serviceName={service.name}
              enabled={enabled}
            />
          )}
        </>
      }
    />
  );
}
