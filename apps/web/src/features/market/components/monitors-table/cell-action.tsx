import { useState } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icons } from '@/components/icons';
import { removeMonitor, setMonitorEnabled, type MonitorDto } from '@/server/market-functions';
import { monitorsQuery } from '@/features/market/api/queries';

interface CellActionProps {
  data: MonitorDto;
  onEdit: (monitor: MonitorDto) => void;
}

/** Row action menu (loxep-foi.3): replaces the three inline Edit/Enable/Remove buttons. */
export function CellAction({ data, onEdit }: CellActionProps) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: monitorsQuery.queryKey });
    queryClient.invalidateQueries({ queryKey: ['market', 'items'] });
  };

  const enabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => setMonitorEnabled({ data: input }),
    onSuccess: () => {
      toast.success('Monitor updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update monitor');
    }
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeMonitor({ data: { id } }),
    onSuccess: (result) => {
      toast.success(result.action === 'deleted' ? 'Monitor deleted' : 'Monitor disabled');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove monitor');
    },
    onSettled: () => setRemoving(false)
  });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon-sm'>
            <span className='sr-only'>Open menu</span>
            <Icons.ellipsis className='h-4 w-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onEdit(data)}>
            <Icons.edit className='mr-2 h-4 w-4' /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={enabledMutation.isPending}
            onClick={() => enabledMutation.mutate({ id: data.id, enabled: !data.enabled })}
          >
            {data.enabled ? (
              <Icons.xCircle className='mr-2 h-4 w-4' />
            ) : (
              <Icons.circleCheck className='mr-2 h-4 w-4' />
            )}
            {data.enabled ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRemoving(true)}>
            <Icons.trash className='mr-2 h-4 w-4' /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {data.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {data.lastPollAt === null
                ? 'This monitor has never polled, so it will be deleted outright.'
                : 'This monitor has poll history, so it will be disabled rather than deleted — linked observations and events are preserved.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeMutation.isPending}
              onClick={() => removeMutation.mutate(data.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
