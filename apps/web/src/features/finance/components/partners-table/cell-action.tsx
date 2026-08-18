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
import { partnersQuery } from '@/features/finance/api/partners-queries';
import { updatePartner } from '@/server/partners-functions';
import type { PartnerListItemDto } from '@/server/partners-functions';
import PartnerFormDialog from '@/features/finance/components/partner-form-dialog';

/**
 * Edit + archive only — no merge affordance (see `partners-functions.ts`'s
 * module doc: merging is a picker flow this pass does not build).
 */
export function CellAction({ data }: { data: PartnerListItemDto }) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  const archiveMutation = useMutation({
    mutationFn: () => updatePartner({ data: { counterpartyId: data.id, status: 'archived' } }),
    onSuccess: () => {
      toast.success(`${data.displayName} archived`);
      void queryClient.invalidateQueries({ queryKey: partnersQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to archive trading partner'),
    onSettled: () => setConfirming(false)
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' onClick={() => setEditOpen(true)}>
        Edit
      </Button>
      {data.status !== 'archived' && (
        <Button size='sm' variant='ghost' onClick={() => setConfirming(true)}>
          Archive
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {data.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              An archived trading partner drops out of pickers (the expense payee combobox, role
              selectors) but every historical reference keeps pointing at it. There is no delete.
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
      {editOpen && <PartnerFormDialog open={editOpen} onOpenChange={setEditOpen} partner={data} />}
    </div>
  );
}
