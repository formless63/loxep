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
import {
  removeOpportunityRule,
  setOpportunityRuleEnabled,
  type OpportunityRuleDto
} from '@/server/market-functions';
import { opportunityRulesQuery } from '@/features/market/api/queries';

interface CellActionProps {
  data: OpportunityRuleDto;
  onEdit: (rule: OpportunityRuleDto) => void;
}

/** Row action menu — edit, enable/disable, remove. Mirrors `monitors-table/cell-action.tsx` exactly. */
export function CellAction({ data, onEdit }: CellActionProps) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: opportunityRulesQuery.queryKey });
  };

  const enabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      setOpportunityRuleEnabled({ data: input }),
    onSuccess: () => {
      toast.success('Rule updated');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update rule');
    }
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeOpportunityRule({ data: { id } }),
    onSuccess: () => {
      toast.success('Rule removed');
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove rule');
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
              A hard delete — `market_events.rule_id` is a historical attribution stamp, not a
              foreign key, so past scored events keep their record of this rule even after it's
              gone.
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
