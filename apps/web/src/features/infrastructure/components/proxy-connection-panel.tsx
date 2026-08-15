import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import {
  hostingTargetQuery,
  pangolinConnectionOptionsQuery
} from '@/features/infrastructure/api/queries';
import { linkHostingTargetProxyConnection } from '@/server/infrastructure-functions';
import ProxyResourceRow, { ProxyResourceEmptyState } from './proxy-resource-row';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

const NO_CONNECTION = '__none__';

/**
 * The fleet-detail write surface `hosting_targets.proxy_connection_id`
 * finally has (Pangolin chain design milestone 2, loxep-acj.2 — the column
 * has been nullable and unused since migration `0012`). Links or clears
 * `proxy_connection_id`/`external_site_id`; writes ONLY Loxep's own row,
 * never a Pangolin call — the reconciler this drives is CHECK MODE ONLY this
 * milestone.
 *
 * Not gated on an existing link, the same "DURABLE home for declaring
 * intent" rule `ContainerHostRegistrationPanel` documents for Dockhand: a
 * target that has never been linked to Pangolin at all still needs
 * somewhere to declare the link.
 */
function LinkConnectionForm({
  hostingTargetId,
  hostingTargetName,
  currentConnectionId,
  currentExternalSiteId,
  onDone
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  currentConnectionId: string | null;
  currentExternalSiteId: string | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: connections } = useQuery(pangolinConnectionOptionsQuery);
  const [connectionId, setConnectionId] = React.useState(currentConnectionId ?? NO_CONNECTION);
  const [externalSiteId, setExternalSiteId] = React.useState(currentExternalSiteId ?? '');

  const mutation = useMutation({
    mutationFn: () =>
      linkHostingTargetProxyConnection({
        data: {
          hostingTargetId,
          connectionId: connectionId === NO_CONNECTION ? null : connectionId,
          externalSiteId: externalSiteId.trim() === '' ? undefined : externalSiteId.trim()
        }
      }),
    onSuccess: async () => {
      toast.success('Proxy connection updated');
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
      onDone();
    },
    onError: (error) => toastError(error, 'Failed to update the proxy connection')
  });

  return (
    <div className='flex flex-col gap-3 rounded-md border p-3'>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='proxy-connection-select'>Pangolin connection</Label>
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger id='proxy-connection-select' className='w-full'>
            <SelectValue placeholder='None' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CONNECTION}>None</SelectItem>
            {(connections ?? []).map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='proxy-external-site-id'>Pangolin site id</Label>
        <Input
          id='proxy-external-site-id'
          value={externalSiteId}
          onChange={(event) => setExternalSiteId(event.target.value)}
          placeholder='Optional — the newt site this target runs behind'
          disabled={connectionId === NO_CONNECTION}
        />
      </div>
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' size='sm' onClick={onDone}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export default function ProxyConnectionPanel({
  hostingTargetId,
  hostingTargetName,
  proxyConnectionId,
  proxyConnectionName,
  externalSiteId,
  proxyResources
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  proxyConnectionId: string | null;
  proxyConnectionName: string | null;
  externalSiteId: string | null;
  proxyResources: ProxyResourceChainDto[];
}) {
  const [editing, setEditing] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Proxy connection</CardTitle>
        <CardDescription>
          Which Pangolin instance reconciles proxy resources fronting this target.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {editing ? (
          <LinkConnectionForm
            hostingTargetId={hostingTargetId}
            hostingTargetName={hostingTargetName}
            currentConnectionId={proxyConnectionId}
            currentExternalSiteId={externalSiteId}
            onDone={() => setEditing(false)}
          />
        ) : proxyConnectionId === null ? (
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <p className='text-muted-foreground text-sm'>Not linked to a Pangolin connection.</p>
            <Button size='sm' variant='outline' onClick={() => setEditing(true)}>
              <Icons.add />
              Link connection
            </Button>
          </div>
        ) : (
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex flex-wrap items-center gap-2 text-sm'>
              <Badge variant='outline'>{proxyConnectionName ?? proxyConnectionId}</Badge>
              {externalSiteId && (
                <span className='text-muted-foreground'>site {externalSiteId}</span>
              )}
            </div>
            <Button size='sm' variant='outline' onClick={() => setEditing(true)}>
              <Icons.edit />
              Edit
            </Button>
          </div>
        )}

        <div>
          <p className='mb-2 text-sm font-medium'>
            Proxy resources fronted by this target ({proxyResources.length})
          </p>
          {proxyResources.length === 0 ? (
            <ProxyResourceEmptyState
              title='No proxy resource declared'
              description='No Pangolin resource has been declared as fronting this target yet.'
            />
          ) : (
            <ul className='flex flex-col gap-3'>
              {proxyResources.map((resource) => (
                <ProxyResourceRow
                  key={resource.id}
                  resource={resource}
                  linkTo={{
                    to: '/infrastructure/domains/$name',
                    params: { name: resource.domainName },
                    label: resource.domainName
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
