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
import { updateNotificationRule, type NotificationRuleDto } from '@/server/admin-functions';
import {
  monitorTargetOptionsQuery,
  notificationEndpointsQuery,
  notificationRulesQuery
} from '@/features/settings/api/queries';
import { marketEventTypeLabel } from '@/features/settings/constants';
import { StatusBadge } from '@/features/settings/components/settings-page';
import NotificationRuleDialog from '@/features/settings/components/notification-rule-dialog';

export default function NotificationRulesTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(notificationRulesQuery);
  const { data: endpoints } = useQuery(notificationEndpointsQuery);
  const { data: monitorTargets } = useQuery(monitorTargetOptionsQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NotificationRuleDto | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: notificationRulesQuery.queryKey });

  const enabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      updateNotificationRule({ data: { id: input.id, enabled: input.enabled } }),
    onSuccess: () => {
      toast.success('Rule updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update rule');
    }
  });

  const rules = data ?? [];
  const endpointList = endpoints ?? [];
  const monitorTargetList = monitorTargets ?? [];
  const endpointNameById = new Map(endpointList.map((endpoint) => [endpoint.id, endpoint.name]));
  const monitorNameById = new Map(monitorTargetList.map((target) => [target.id, target.name]));

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: NotificationRuleDto) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={openCreate} disabled={endpointList.length === 0}>
            New rule
          </Button>
        </div>
      )}

      {endpointList.length === 0 && (
        <p className='text-muted-foreground text-sm'>
          Register a notification endpoint first — rules route to an endpoint.
        </p>
      )}

      {rules.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No notification rules</EmptyTitle>
            <EmptyDescription>
              Rules match a market event type and/or monitor target ("any" when unset) and route
              matching events to one endpoint.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Event type</TableHead>
                <TableHead>Monitor</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Enabled</TableHead>
                {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className='font-medium'>{rule.name}</TableCell>
                  <TableCell>
                    {rule.marketEventType ? (
                      <Badge variant='outline'>{marketEventTypeLabel(rule.marketEventType)}</Badge>
                    ) : (
                      <span className='text-muted-foreground'>any</span>
                    )}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {rule.monitorTargetId
                      ? (monitorNameById.get(rule.monitorTargetId) ?? 'unknown')
                      : 'any'}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {endpointNameById.get(rule.endpointId) ?? 'unknown'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge ok={rule.enabled} okLabel='enabled' failLabel='disabled' />
                  </TableCell>
                  {isAdmin && (
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button size='sm' variant='outline' onClick={() => openEdit(rule)}>
                          Edit
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={enabledMutation.isPending}
                          onClick={() =>
                            enabledMutation.mutate({ id: rule.id, enabled: !rule.enabled })
                          }
                        >
                          {rule.enabled ? 'Disable' : 'Enable'}
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
        <NotificationRuleDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          rule={editing}
          endpoints={endpointList}
          monitorTargets={monitorTargetList}
        />
      )}
    </div>
  );
}
