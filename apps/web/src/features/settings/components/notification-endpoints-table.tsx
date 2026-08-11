import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
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
  sendTestNotification,
  setNotificationEndpointEnabled,
  type NotificationEndpointDto
} from '@/server/admin-functions';
import { notificationEndpointsQuery } from '@/features/settings/api/queries';
import { StatusBadge } from '@/features/settings/components/settings-page';
import NotificationEndpointDialog from '@/features/settings/components/notification-endpoint-dialog';

export default function NotificationEndpointsTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(notificationEndpointsQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NotificationEndpointDto | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: notificationEndpointsQuery.queryKey });

  const enabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      setNotificationEndpointEnabled({ data: input }),
    onSuccess: () => {
      toast.success('Endpoint updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update endpoint');
    }
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => sendTestNotification({ data: { id } }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success('Test notification sent');
      } else {
        toast.error(result.error ?? 'Test notification failed');
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to send test notification');
    }
  });

  const endpoints = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (endpoint: NotificationEndpointDto) => {
    setEditing(endpoint);
    setDialogOpen(true);
  };

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={openCreate}>
            New endpoint
          </Button>
        </div>
      )}

      {endpoints.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No notification endpoints</EmptyTitle>
            <EmptyDescription>
              Endpoints are the destinations rules deliver to. Register one to start receiving
              notifications — ntfy is the first supported endpoint type.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Token</TableHead>
                {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((endpoint) => (
                <TableRow key={endpoint.id}>
                  <TableCell className='font-medium'>{endpoint.name}</TableCell>
                  <TableCell className='text-muted-foreground max-w-xs truncate'>
                    {endpoint.config.baseUrl}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>{endpoint.config.topic}</TableCell>
                  <TableCell>
                    <StatusBadge ok={endpoint.enabled} okLabel='enabled' failLabel='disabled' />
                  </TableCell>
                  <TableCell>
                    {endpoint.hasToken ? (
                      <Badge variant='outline'>token set</Badge>
                    ) : (
                      <span className='text-muted-foreground'>none</span>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={testMutation.isPending}
                          onClick={() => testMutation.mutate(endpoint.id)}
                        >
                          Send test
                        </Button>
                        <Button size='sm' variant='outline' onClick={() => openEdit(endpoint)}>
                          Edit
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={enabledMutation.isPending}
                          onClick={() =>
                            enabledMutation.mutate({
                              id: endpoint.id,
                              enabled: !endpoint.enabled
                            })
                          }
                        >
                          {endpoint.enabled ? 'Disable' : 'Enable'}
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

      {dialogOpen && (
        <NotificationEndpointDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          endpoint={editing}
        />
      )}
    </div>
  );
}
