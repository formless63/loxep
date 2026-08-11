import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
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
import { removeMonitor, setMonitorEnabled, type MonitorDto } from '@/server/market-functions';
import { monitorsQuery } from '@/features/market/api/queries';
import { monitorTargetTypeLabel } from '@/features/market/constants';
import { StatusBadge } from '@/features/market/components/market-page';
import MonitorFormDialog from '@/features/market/components/monitor-form-dialog';

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

function BackoffBadge({ backoffUntil }: { backoffUntil: string | null }) {
  if (backoffUntil === null || new Date(backoffUntil).getTime() <= Date.now()) {
    return <span className='text-muted-foreground'>—</span>;
  }
  return <Badge variant='destructive'>backing off until {formatTimestamp(backoffUntil)}</Badge>;
}

export default function MonitorsTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(monitorsQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MonitorDto | null>(null);
  const [removing, setRemoving] = React.useState<MonitorDto | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: monitorsQuery.queryKey });
    queryClient.invalidateQueries({ queryKey: ['market', 'items'] });
  };

  const enabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => setMonitorEnabled({ data: input }),
    onSuccess: () => {
      toast.success('Monitor updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update monitor');
    }
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeMonitor({ data: { id } }),
    onSuccess: (result) => {
      toast.success(result.action === 'deleted' ? 'Monitor deleted' : 'Monitor disabled');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove monitor');
    },
    onSettled: () => setRemoving(null)
  });

  const monitors = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (monitor: MonitorDto) => {
    setEditing(monitor);
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
            New monitor
          </Button>
        </div>
      )}

      {monitors.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No monitors</EmptyTitle>
            <EmptyDescription>
              Monitors are user/configuration intent — what to poll, on what cadence. Create one to
              start observing an eBay item or watchlist.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Base interval</TableHead>
                <TableHead>Next poll</TableHead>
                <TableHead>Consecutive errors</TableHead>
                <TableHead>Backoff</TableHead>
                {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitors.map((monitor) => (
                <TableRow key={monitor.id}>
                  <TableCell className='font-medium'>{monitor.name}</TableCell>
                  <TableCell>
                    <Badge variant='outline'>{monitorTargetTypeLabel(monitor.targetType)}</Badge>
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {monitor.connectionName ?? '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge ok={monitor.enabled} okLabel='enabled' failLabel='disabled' />
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {monitor.intervalSeconds}s
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {formatTimestamp(monitor.nextPollAt)}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {monitor.consecutiveErrors}
                  </TableCell>
                  <TableCell>
                    <BackoffBadge backoffUntil={monitor.backoffUntil} />
                  </TableCell>
                  {isAdmin && (
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button size='sm' variant='outline' onClick={() => openEdit(monitor)}>
                          Edit
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={enabledMutation.isPending}
                          onClick={() =>
                            enabledMutation.mutate({ id: monitor.id, enabled: !monitor.enabled })
                          }
                        >
                          {monitor.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button size='sm' variant='ghost' onClick={() => setRemoving(monitor)}>
                          Remove
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
        <MonitorFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          monitor={editing}
        />
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.lastPollAt === null
                ? 'This monitor has never polled, so it will be deleted outright.'
                : 'This monitor has poll history, so it will be disabled rather than deleted — linked observations and events are preserved.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeMutation.isPending}
              onClick={() => removing && removeMutation.mutate(removing.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
