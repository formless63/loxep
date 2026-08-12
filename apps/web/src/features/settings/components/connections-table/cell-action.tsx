import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { setConnectionStatus, type ConnectionDto } from '@/server/admin-functions';
import { connectionsQuery } from '@/features/settings/api/queries';
import { EbayConnectionActions } from '@/features/settings/components/ebay-connection-actions';

const EBAY_PROVIDER = 'ebay';

/**
 * Row-scoped status toggle: its own mutation instance fixes the bug where a
 * single shared `statusMutation` disabled every row's Enable/Disable button
 * at once while any one row's request was in flight.
 */
export function CellAction({ data }: { data: ConnectionDto }) {
  const queryClient = useQueryClient();

  const statusMutation = useMutation({
    mutationFn: (status: 'active' | 'disabled') =>
      setConnectionStatus({ data: { id: data.id, status } }),
    onSuccess: () => {
      toast.success('Account status updated');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update status')
  });

  return (
    <div className='flex justify-end gap-2'>
      {data.provider === EBAY_PROVIDER && <EbayConnectionActions connection={data} />}
      <Button
        size='sm'
        variant='outline'
        disabled={statusMutation.isPending}
        onClick={() => statusMutation.mutate(data.status === 'disabled' ? 'active' : 'disabled')}
      >
        {data.status === 'disabled' ? 'Enable' : 'Disable'}
      </Button>
    </div>
  );
}
