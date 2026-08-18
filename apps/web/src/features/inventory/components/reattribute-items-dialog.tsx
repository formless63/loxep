import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { reattributeInventoryItems } from '@/server/inventory-functions';
import { entitiesQuery } from '@/features/settings/api/queries';
import { UNATTRIBUTED_ENTITY_VALUE } from '@/features/finance/constants';

/**
 * A27 (loxep-wx3) — `ItemsService.reattribute` had zero callers. Scoped to
 * ONE lot's items (the only filter this detail page can offer); rewrites
 * only rows whose attribution source is still a default, never a `manual`
 * choice — the operator's own explicit picks are never silently overwritten.
 */
export default function ReattributeItemsDialog({
  open,
  onOpenChange,
  acquisitionId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  acquisitionId: string;
}) {
  const queryClient = useQueryClient();
  const { data: entities } = useQuery({ ...entitiesQuery, enabled: open });
  const [economicEntityId, setEconomicEntityId] = React.useState(UNATTRIBUTED_ENTITY_VALUE);

  const mutation = useMutation({
    mutationFn: () =>
      reattributeInventoryItems({
        data: {
          acquisitionId,
          economicEntityId: economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : economicEntityId
        }
      }),
    onSuccess: (result) => {
      toast.success(
        result.updated === 0
          ? 'Nothing to reattribute — every item already has a manual attribution'
          : `${result.updated} item(s) reattributed`
      );
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not reattribute items')
  });

  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...(entities ?? []).map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Reattribute this lot's items</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Corrects a default that was never a decision — items an operator already attributed
            manually are never touched.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className='space-y-6'>
          <FieldGroup>
            <Select value={economicEntityId} onValueChange={setEconomicEntityId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entityOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='button' disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Icons.spinner className='animate-spin' />}
              Reattribute
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
