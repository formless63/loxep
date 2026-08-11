import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { applyStorageBackendAction, type StorageBackendDto } from '@/server/admin-functions';
import { storageBackendsQuery } from '@/features/settings/api/queries';
import { STORAGE_DRIVER_LABELS } from '@/features/settings/constants';
import { StatusBadge } from '@/features/settings/components/settings-page';
import StorageBackendDialog from '@/features/settings/components/storage-backend-dialog';

function describeConfig(backend: StorageBackendDto): string {
  const config = backend.config as Record<string, unknown> | null;
  if (!config || typeof config !== 'object') return '—';
  if (backend.driver === 'local') {
    return typeof config.rootDir === 'string' ? config.rootDir : '—';
  }
  if (backend.driver === 's3') {
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint : '?';
    const bucket = typeof config.bucket === 'string' ? config.bucket : '?';
    return `${endpoint} / ${bucket}`;
  }
  return '—';
}

export default function StorageBackendsTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(storageBackendsQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const actionMutation = useMutation({
    mutationFn: (input: { id: string; action: 'enable' | 'disable' | 'set-default' }) =>
      applyStorageBackendAction({ data: input }),
    onSuccess: () => {
      toast.success('Storage backend updated');
      queryClient.invalidateQueries({ queryKey: storageBackendsQuery.queryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update backend');
    }
  });

  const backends = data ?? [];

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={() => setDialogOpen(true)}>
            Register backend
          </Button>
        </div>
      )}

      {backends.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No storage backends</EmptyTitle>
            <EmptyDescription>
              Register a local-filesystem or S3-compatible backend to store media objects.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Credentials</TableHead>
              {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {backends.map((backend) => (
              <TableRow key={backend.id}>
                <TableCell className='font-medium'>{backend.name}</TableCell>
                <TableCell>
                  <Badge variant='outline'>
                    {STORAGE_DRIVER_LABELS[backend.driver as 'local' | 's3'] ?? backend.driver}
                  </Badge>
                </TableCell>
                <TableCell className='text-muted-foreground max-w-xs truncate'>
                  {describeConfig(backend)}
                </TableCell>
                <TableCell>
                  <StatusBadge ok={backend.enabled} okLabel='enabled' failLabel='disabled' />
                </TableCell>
                <TableCell>
                  {backend.isDefault ? (
                    <Badge>default</Badge>
                  ) : (
                    <span className='text-muted-foreground'>—</span>
                  )}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {backend.driver === 's3'
                    ? backend.hasCredentials
                      ? 'encrypted'
                      : 'missing'
                    : 'n/a'}
                </TableCell>
                {isAdmin && (
                  <TableCell className='text-right'>
                    <div className='flex justify-end gap-2'>
                      {!backend.isDefault && backend.enabled && (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={actionMutation.isPending}
                          onClick={() =>
                            actionMutation.mutate({ id: backend.id, action: 'set-default' })
                          }
                        >
                          Set default
                        </Button>
                      )}
                      <Button
                        size='sm'
                        variant='ghost'
                        disabled={actionMutation.isPending || backend.isDefault}
                        onClick={() =>
                          actionMutation.mutate({
                            id: backend.id,
                            action: backend.enabled ? 'disable' : 'enable'
                          })
                        }
                      >
                        {backend.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Alert>
        <AlertTitle>Backend migration</AlertTitle>
        <AlertDescription>
          Moving objects between backends uses the resumable copy → verify → cutover → cleanup
          workflow at the service level; a migration UI arrives in a later phase.
        </AlertDescription>
      </Alert>

      {dialogOpen && <StorageBackendDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}
