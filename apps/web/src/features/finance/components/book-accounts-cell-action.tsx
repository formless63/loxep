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
import { ledgerAccountsQuery } from '@/features/finance/api/books-queries';
import {
  archiveLedgerAccount,
  reactivateLedgerAccount,
  type LedgerAccountDto
} from '@/server/ledger-accounts-functions';

/**
 * Edit + archive/reactivate — every mutating verb `AccountsService` exports
 * besides `createAccount`/`updateAccount` (the dialog). Archiving a system
 * account is refused server-side (`LedgerImmutableError`); the toast surfaces
 * that message rather than hiding the button, so an operator learns WHY
 * rather than wondering where the control went.
 */
export function AccountCellAction({
  data,
  accountingBookId,
  onEdit
}: {
  data: LedgerAccountDto;
  accountingBookId: string;
  onEdit: (account: LedgerAccountDto) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ledgerAccountsQuery(accountingBookId).queryKey });

  const archiveMutation = useMutation({
    mutationFn: () => archiveLedgerAccount({ data: { ledgerAccountId: data.id } }),
    onSuccess: () => {
      toast.success(`${data.code} archived`);
      void invalidate();
    },
    onError: (error) => toastError(error, 'Failed to archive account'),
    onSettled: () => setConfirming(false)
  });

  const reactivateMutation = useMutation({
    mutationFn: () => reactivateLedgerAccount({ data: { ledgerAccountId: data.id } }),
    onSuccess: () => {
      toast.success(`${data.code} reactivated`);
      void invalidate();
    },
    onError: (error) => toastError(error, 'Failed to reactivate account')
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' onClick={() => onEdit(data)}>
        Edit
      </Button>
      {data.status === 'active' ? (
        <Button size='sm' variant='ghost' onClick={() => setConfirming(true)}>
          Archive
        </Button>
      ) : (
        <Button
          size='sm'
          variant='ghost'
          disabled={reactivateMutation.isPending}
          onClick={() => reactivateMutation.mutate()}
        >
          Reactivate
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {data.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              An archived account keeps every posted line exactly as it is — it only stops accepting
              new postings. There is no delete, and a system account cannot be archived at all.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate()}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
