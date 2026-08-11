import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  attributeConnection,
  setConnectionStatus,
  type ConnectionDto,
  type EntityDto
} from '@/server/admin-functions';
import {
  connectionsQuery,
  ebayKeysetStatusQuery,
  entitiesQuery
} from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';
import ConnectionAddDialog from '@/features/settings/components/connection-add-dialog';
import { IntegrationStatusBadges } from '@/features/settings/components/integration-card';
import {
  connectableIntegrationServices,
  integrationServiceForProvider,
  type IntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';
import {
  EbayConnectionActions,
  EbayCredentialStatus
} from '@/features/settings/components/ebay-connection-actions';

const EBAY_PROVIDER = 'ebay';

function statusVariant(status: ConnectionDto['status']): 'secondary' | 'outline' | 'destructive' {
  if (status === 'active') return 'secondary';
  if (status === 'disabled') return 'outline';
  return 'destructive';
}

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

/**
 * Accounts, grouped by the service they belong to.
 *
 * The grouping and every "Add account" action come from the integrations
 * catalog (`@/features/settings/integrations-catalog`), so `provider` and
 * `kind` are chosen by the system rather than typed, and a service that is
 * not set up yet says so and links to `/settings/integrations` instead of
 * offering a form that would fail.
 */
export default function ConnectionsTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending } = useQuery(connectionsQuery);
  const { data: entities } = useQuery(entitiesQuery);
  // Admin-only server function: fetched only when it can succeed, and only
  // used to decide whether adding an eBay account can work at all.
  const { data: ebayKeyset } = useQuery({ ...ebayKeysetStatusQuery, enabled: isAdmin });
  const [addServiceId, setAddServiceId] = React.useState<string | null>(null);

  const connections = data ?? [];
  const statusInput: IntegrationStatusInput = {
    connections,
    endpoints: [],
    ebayKeyset: ebayKeyset ?? null
  };

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  const catalogProviders = new Set(
    connectableIntegrationServices.map((service) => service.accounts?.provider)
  );
  const uncatalogued = connections.filter(
    (connection) => !catalogProviders.has(connection.provider)
  );
  const addService =
    connectableIntegrationServices.find((service) => service.id === addServiceId) ?? null;

  return (
    <div className='flex flex-col gap-8'>
      {connectableIntegrationServices.map((service) => (
        <ServiceSection
          key={service.id}
          service={service}
          connections={connections.filter(
            (connection) => connection.provider === service.accounts?.provider
          )}
          entities={entities ?? []}
          statusInput={statusInput}
          isAdmin={isAdmin}
          onAddAccount={() => setAddServiceId(service.id)}
        />
      ))}

      {uncatalogued.length > 0 && (
        <section className='flex flex-col gap-3'>
          <h2 className='text-lg font-medium'>Other services</h2>
          <p className='text-muted-foreground text-sm'>
            Accounts recorded for services that are not in the integrations catalog. They can be
            disabled and attributed here, but no guided set-up exists for them.
          </p>
          <ConnectionRows
            connections={uncatalogued}
            entities={entities ?? []}
            isAdmin={isAdmin}
            showService
          />
        </section>
      )}

      {addService !== null && (
        <ConnectionAddDialog
          service={addService}
          open
          onOpenChange={(open) => {
            if (!open) setAddServiceId(null);
          }}
          entities={entities ?? []}
        />
      )}
    </div>
  );
}

/** One service's accounts plus its guarded "Add account" action. */
function ServiceSection({
  service,
  connections,
  entities,
  statusInput,
  isAdmin,
  onAddAccount
}: {
  service: IntegrationService;
  connections: ConnectionDto[];
  entities: EntityDto[];
  statusInput: IntegrationStatusInput;
  isAdmin: boolean;
  onAddAccount: () => void;
}) {
  const blockedReason = service.accounts?.blockedReason(statusInput) ?? null;

  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-lg font-medium'>{service.name}</h2>
          <IntegrationStatusBadges status={service.status(statusInput)} />
        </div>
        {isAdmin && (
          <div className='flex flex-col items-end gap-1'>
            <Button size='sm' disabled={blockedReason !== null} onClick={onAddAccount}>
              {service.accounts?.addLabel ?? 'Add account'}
            </Button>
            {blockedReason !== null && (
              <p className='text-muted-foreground max-w-xs text-right text-xs'>
                {blockedReason}{' '}
                <Link to='/settings/integrations' className='underline underline-offset-2'>
                  Open integrations
                </Link>
              </p>
            )}
          </div>
        )}
      </div>
      {connections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {service.name} accounts</EmptyTitle>
            <EmptyDescription>{service.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ConnectionRows connections={connections} entities={entities} isAdmin={isAdmin} />
      )}
    </section>
  );
}

/** The account table itself — one row per connection. */
function ConnectionRows({
  connections,
  entities,
  isAdmin,
  showService = false
}: {
  connections: ConnectionDto[];
  entities: EntityDto[];
  isAdmin: boolean;
  showService?: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'disabled' }) =>
      setConnectionStatus({ data: input }),
    onSuccess: () => {
      toast.success('Account status updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update status');
    }
  });

  const attributionMutation = useMutation({
    mutationFn: (input: { id: string; economicEntityId: string | null }) =>
      attributeConnection({ data: input }),
    onSuccess: () => {
      toast.success('Attribution updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update attribution');
    }
  });

  const activeEntities = entities.filter((entity) => entity.active);
  const entityNameById = new Map(entities.map((entity) => [entity.id, entity.name]));

  return (
    <div className='overflow-x-auto'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            {showService && <TableHead>Service</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Credentials</TableHead>
            <TableHead>Last success</TableHead>
            <TableHead>Last error</TableHead>
            {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow key={connection.id}>
              <TableCell className='font-medium'>{connection.name}</TableCell>
              {showService && (
                <TableCell className='text-muted-foreground'>
                  {integrationServiceForProvider(connection.provider)?.name ?? connection.provider}
                </TableCell>
              )}
              <TableCell>
                <Badge variant={statusVariant(connection.status)}>{connection.status}</Badge>
              </TableCell>
              <TableCell>
                {isAdmin ? (
                  <Select
                    value={connection.economicEntityId ?? NO_ENTITY_VALUE}
                    onValueChange={(value) =>
                      attributionMutation.mutate({
                        id: connection.id,
                        economicEntityId: value === NO_ENTITY_VALUE ? null : value
                      })
                    }
                  >
                    <SelectTrigger size='sm' className='min-w-36'>
                      <SelectValue placeholder='No attribution' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_ENTITY_VALUE}>No attribution</SelectItem>
                      {activeEntities.map((entity) => (
                        <SelectItem key={entity.id} value={entity.id}>
                          {entity.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className='text-muted-foreground'>
                    {connection.economicEntityId
                      ? (entityNameById.get(connection.economicEntityId) ?? '—')
                      : '—'}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {connection.provider === EBAY_PROVIDER ? (
                  <EbayCredentialStatus connection={connection} />
                ) : connection.credentials.length === 0 ? (
                  <span className='text-muted-foreground'>none</span>
                ) : (
                  <div className='flex flex-wrap gap-1'>
                    {connection.credentials.map((credential) => (
                      <Badge key={credential.credentialType} variant='outline'>
                        {credential.credentialType} v{credential.currentVersion}
                      </Badge>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className='text-muted-foreground'>
                {formatTimestamp(connection.lastSuccessAt)}
              </TableCell>
              <TableCell className='text-muted-foreground'>
                {connection.lastErrorAt
                  ? `${formatTimestamp(connection.lastErrorAt)} (${connection.lastErrorCode ?? 'unknown'})`
                  : '—'}
              </TableCell>
              {isAdmin && (
                <TableCell className='text-right'>
                  <div className='flex justify-end gap-2'>
                    {connection.provider === EBAY_PROVIDER && (
                      <EbayConnectionActions connection={connection} />
                    )}
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={statusMutation.isPending}
                      onClick={() =>
                        statusMutation.mutate({
                          id: connection.id,
                          status: connection.status === 'disabled' ? 'active' : 'disabled'
                        })
                      }
                    >
                      {connection.status === 'disabled' ? 'Enable' : 'Disable'}
                    </Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
