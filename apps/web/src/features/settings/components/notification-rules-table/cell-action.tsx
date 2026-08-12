import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { updateNotificationRule, type NotificationRuleDto } from '@/server/admin-functions';
import { notificationRulesQuery } from '@/features/settings/api/queries';

/** Row-scoped mutation: only the row being toggled disables. */
export function CellAction({
  data,
  onEdit
}: {
  data: NotificationRuleDto;
  onEdit: (rule: NotificationRuleDto) => void;
}) {
  const queryClient = useQueryClient();

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => updateNotificationRule({ data: { id: data.id, enabled } }),
    onSuccess: () => {
      toast.success('Rule updated');
      queryClient.invalidateQueries({ queryKey: notificationRulesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update rule')
  });

  return (
    <div className='flex justify-end gap-2'>
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
