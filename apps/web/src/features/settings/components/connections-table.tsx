import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  type ConnectionDto
} from '@/server/admin-functions';
import { connectionsQuery, entitiesQuery } from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';
import ConnectionCreateDialog from '@/features/settings/components/connection-create-dialog';
import EbayIntegrationCard from '@/features/settings/components/ebay-integration-card';
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

export default function ConnectionsTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(connectionsQuery);
  const { data: entities } = useQuery(entitiesQuery);
  const [createOpen, setCreateOpen] = React.useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'disabled' }) =>
      setConnectionStatus({ data: input }),
    onSuccess: () => {
      toast.success('Connection status updated');
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

  const connections = data ?? [];
  const activeEntities = (entities ?? []).filter((entity) => entity.active);
  const entityNameById = new Map((entities ?? []).map((entity) => [entity.id, entity.name]));

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && <EbayIntegrationCard />}

      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={() => setCreateOpen(true)}>
            New connection
          </Button>
        </div>
      )}

      {connections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No connections</EmptyTitle>
            <EmptyDescription>
              Connections are configured relationships to external accounts, stores, or services —
              created in-app, never via environment variables.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Kind</TableHead>
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
                  <TableCell>{connection.provider}</TableCell>
                  <TableCell className='text-muted-foreground'>{connection.kind}</TableCell>
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
      )}

      {createOpen && (
        <ConnectionCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          entities={entities ?? []}
        />
      )}
    </div>
  );
}
