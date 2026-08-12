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
import { deactivateEntity, type EntityDto } from '@/server/admin-functions';
import { entitiesQuery } from '@/features/settings/api/queries';

/** Row-scoped: each row's own mutation, so one deactivation in flight doesn't disable every row. */
export function CellAction({
  data,
  onEdit
}: {
  data: EntityDto;
  onEdit: (entity: EntityDto) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateEntity({ data: { id: data.id } }),
    onSuccess: () => {
      toast.success('Entity deactivated');
      queryClient.invalidateQueries({ queryKey: entitiesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to deactivate entity'),
    onSettled: () => setConfirming(false)
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' onClick={() => onEdit(data)}>
        Edit
      </Button>
      {data.active && (
        <Button size='sm' variant='ghost' onClick={() => setConfirming(true)}>
          Deactivate
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {data.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deactivation is a soft state — attributed data keeps referencing the entity, but it
              can no longer receive new attributions. Entities are never deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deactivateMutation.isPending}
              onClick={() => deactivateMutation.mutate()}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
