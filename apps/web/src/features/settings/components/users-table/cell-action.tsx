import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { setUserRole, type UserDto } from '@/server/admin-functions';
import { usersQuery } from '@/features/settings/api/queries';
import { toast } from 'sonner';

/**
 * Role-toggle action, scoped to its own row: each cell instance owns its own
 * mutation, so `isPending` only disables the button for the row actually
 * being changed — a shared mutation object at the table level disabled every
 * row's button at once.
 */
export function CellAction({ data, currentUserId }: { data: UserDto; currentUserId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const nextRole = data.role.includes('admin') ? 'member' : 'admin';

  const roleMutation = useMutation({
    mutationFn: () => setUserRole({ data: { userId: data.id, role: nextRole } }),
    onSuccess: () => {
      toast.success('Role updated');
      queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update role'),
    onSettled: () => setConfirming(false)
  });

  return (
    <>
      <Button
        size='sm'
        variant='outline'
        disabled={data.id === currentUserId}
        onClick={() => setConfirming(true)}
      >
        {data.role.includes('admin') ? 'Demote to member' : 'Promote to admin'}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nextRole === 'admin' ? 'Promote' : 'Demote'} {data.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nextRole === 'admin'
                ? 'Admins can manage users, entities, connections, storage, and application settings across the installation.'
                : 'The user keeps ordinary member access to product data but loses all administrative capabilities.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={roleMutation.isPending}
              onClick={() => roleMutation.mutate()}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
