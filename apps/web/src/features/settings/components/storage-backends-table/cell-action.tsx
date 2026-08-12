import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { applyStorageBackendAction, type StorageBackendDto } from '@/server/admin-functions';
import { storageBackendsQuery } from '@/features/settings/api/queries';

/** Row-scoped mutation: only the button for the row being changed disables. */
export function CellAction({ data }: { data: StorageBackendDto }) {
  const queryClient = useQueryClient();

  const actionMutation = useMutation({
    mutationFn: (action: 'enable' | 'disable' | 'set-default') =>
      applyStorageBackendAction({ data: { id: data.id, action } }),
    onSuccess: () => {
      toast.success('Storage backend updated');
      queryClient.invalidateQueries({ queryKey: storageBackendsQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update backend')
  });

  return (
    <div className='flex justify-end gap-2'>
      {!data.isDefault && data.enabled && (
        <Button
          size='sm'
          variant='outline'
          disabled={actionMutation.isPending}
          onClick={() => actionMutation.mutate('set-default')}
        >
          Set default
        </Button>
      )}
      <Button
        size='sm'
        variant='ghost'
        disabled={actionMutation.isPending || data.isDefault}
        onClick={() => actionMutation.mutate(data.enabled ? 'disable' : 'enable')}
      >
        {data.enabled ? 'Disable' : 'Enable'}
      </Button>
    </div>
  );
}
