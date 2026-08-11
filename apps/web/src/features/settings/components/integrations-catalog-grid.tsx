import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { connectionsQuery, notificationEndpointsQuery } from '@/features/settings/api/queries';
import EbayIntegrationCard from '@/features/settings/components/ebay-integration-card';
import { IntegrationCard } from '@/features/settings/components/integration-card';
import {
  integrationCategories,
  integrationServices,
  type IntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';

/**
 * The integrations catalog: every service Loxep supports, its set-up state,
 * and the one action that continues its set-up. Rendered straight from the
 * typed registry (`@/features/settings/integrations-catalog`), so a service
 * appears here, in the connections page's per-service "Add account" actions,
 * and in the guided forms from a single definition.
 */
export default function IntegrationsCatalogGrid({ isAdmin }: { isAdmin: boolean }) {
  const { data: connections, isPending: connectionsPending } = useQuery(connectionsQuery);
  const { data: endpoints, isPending: endpointsPending } = useQuery(notificationEndpointsQuery);

  const statusInput: IntegrationStatusInput = {
    connections: connections ?? [],
    endpoints: endpoints ?? [],
    ebayKeyset: null
  };
  const isPending = connectionsPending || endpointsPending;

  return (
    <div className='flex flex-col gap-8'>
      {integrationCategories.map((category) => {
        const services = integrationServices.filter((service) => service.category === category);
        if (services.length === 0) return null;
        return (
          <section key={category} className='flex flex-col gap-3'>
            <h2 className='text-lg font-medium'>{category}</h2>
            <div className='grid gap-4 md:grid-cols-2'>
              {services.map((service) =>
                service.manage.kind === 'ebay-keyset' && isAdmin ? (
                  <EbayIntegrationCard key={service.id} statusInput={statusInput} />
                ) : (
                  <CatalogCard
                    key={service.id}
                    service={service}
                    statusInput={statusInput}
                    isPending={isPending}
                  />
                )
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A registry-driven card. The eBay keyset card is the one exception (it owns
 * an admin-only dialog and its own status query) and is rendered above.
 */
function CatalogCard({
  service,
  statusInput,
  isPending
}: {
  service: IntegrationService;
  statusInput: IntegrationStatusInput;
  isPending: boolean;
}) {
  const manage = service.manage;
  return (
    <IntegrationCard
      name={service.name}
      description={service.description}
      status={service.status(statusInput)}
      isPending={isPending}
      action={
        manage.kind === 'route' ? (
          <Button size='sm' variant='outline' asChild>
            <Link to={manage.to}>{manage.label}</Link>
          </Button>
        ) : (
          <Button size='sm' variant='outline' disabled>
            Administrators only
          </Button>
        )
      }
    />
  );
}
