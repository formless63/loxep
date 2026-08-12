import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import {
  sendTestNotification,
  setNotificationEndpointEnabled,
  type NotificationEndpointDto
} from '@/server/admin-functions';
import { notificationEndpointsQuery } from '@/features/settings/api/queries';

/** Row-scoped mutations: each row's buttons disable independently. */
export function CellAction({
  data,
  onEdit
}: {
  data: NotificationEndpointDto;
  onEdit: (endpoint: NotificationEndpointDto) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: notificationEndpointsQuery.queryKey });

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      setNotificationEndpointEnabled({ data: { id: data.id, enabled } }),
    onSuccess: () => {
      toast.success('Endpoint updated');
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to update endpoint')
  });

  const testMutation = useMutation({
    mutationFn: () => sendTestNotification({ data: { id: data.id } }),
    onSuccess: (result) => {
      if (result.ok) toast.success('Test notification sent');
      else toast.error(result.error ?? 'Test notification failed');
    },
    onError: (error) => toastError(error, 'Failed to send test notification')
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={testMutation.isPending}
        onClick={() => testMutation.mutate()}
      >
        Send test
      </Button>
      <Button size='sm' variant='outline' onClick={() => onEdit(data)}>
        Edit
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={enabledMutation.isPending}
        onClick={() => enabledMutation.mutate(!data.enabled)}
      >
        {data.enabled ? 'Disable' : 'Enable'}
      </Button>
    </div>
  );
}
