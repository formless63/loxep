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
import TypedConfirmDialog from '@/components/ui/typed-confirm-dialog';
import { toastError } from '@/lib/errors';
import {
  deleteIpAlias,
  retireIpAliasFanOutRule,
  type IpAliasDto
} from '@/server/infrastructure-functions';
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
  const [retiring, setRetiring] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteIpAlias({ data: { name: data.name } }),
    onSuccess: () => {
      toast.success(`Alias '${data.name}' deleted`);
      queryClient.invalidateQueries({ queryKey: ipAliasesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to delete alias'),
    onSettled: () => setConfirming(false)
  });

  // M7 (loxep-acj.7): the "drift-finding one-click" — completing the M5
  // add-then-retire fan-out's retire half for the OLD address, across every
  // resource this alias is bound to. Only offered once there IS an old
  // address and at least one bound rule to fan out over.
  const retireMutation = useMutation({
    mutationFn: () =>
      retireIpAliasFanOutRule({
        data: { aliasName: data.name, confirmedAliasName: data.name }
      }),
    onSuccess: async (result) => {
      toast.success(
        result.resourceCount === 0
          ? `No live rule for the previous address found — nothing to retire`
          : `Retiring the previous address's rule across ${result.resourceCount} resource${result.resourceCount === 1 ? '' : 's'} — this may take a moment to reflect at Pangolin`
      );
      setRetiring(false);
      await queryClient.invalidateQueries({ queryKey: ipAliasesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to enqueue the retire')
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' onClick={() => onEdit(data)}>
        Edit
      </Button>
      {data.previousAddress !== null && data.boundRulesCount > 0 && (
        <Button size='sm' variant='outline' onClick={() => setRetiring(true)}>
          Retire old rules
        </Button>
      )}
      <Button size='sm' variant='ghost' onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <TypedConfirmDialog
        open={retiring}
        onOpenChange={setRetiring}
        title={`Retire the previous address's rule for '${data.name}'?`}
        description={
          <>
            This disables every currently-live rule matching the PREVIOUS address (
            <span className='font-mono'>{data.previousAddress}</span>) that {data.name} bound,
            across every resource it is bound to. The CURRENT address (
            <span className='font-mono'>{data.address}</span>) rule is untouched. This is reversible
            — a retired rule can be re-enabled from the resource&apos;s own rules list at any time.
          </>
        }
        confirmText={data.name}
        actionLabel='Retire old rules'
        variant='destructive'
        pending={retireMutation.isPending}
        onConfirm={() => retireMutation.mutate()}
      />
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
