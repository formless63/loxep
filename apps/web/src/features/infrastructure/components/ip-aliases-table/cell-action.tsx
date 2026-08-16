import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { deleteIpAlias, type IpAliasDto } from '@/server/infrastructure-functions';
import { ipAliasesQuery } from '@/features/infrastructure/api/queries';

/** Row-scoped: each row's own mutation, so one delete in flight doesn't disable every row. */
export function CellAction({
  data,
  onEdit
}: {
  data: IpAliasDto;
  onEdit: (alias: IpAliasDto) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteIpAlias({ data: { name: data.name } }),
    onSuccess: () => {
      toast.success(`Alias '${data.name}' deleted`);
      queryClient.invalidateQueries({ queryKey: ipAliasesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to delete alias'),
    onSettled: () => setConfirming(false)
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' onClick={() => onEdit(data)}>
        Edit
      </Button>
      <Button size='sm' variant='ghost' onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete alias &lsquo;{data.name}&rsquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {data.boundRulesCount > 0
                ? `This alias is still referenced by ${data.boundRulesCount} rule${data.boundRulesCount === 1 ? '' : 's'}. Unbind or remove ${data.boundRulesCount === 1 ? 'it' : 'them'} first — deleting now will fail.`
                : 'This cannot be undone. No rule currently references this alias.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending || data.boundRulesCount > 0}
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
