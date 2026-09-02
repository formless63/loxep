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
import { setOrderAttribution } from '@/server/orders-functions';
import { orderQuery } from '@/features/commerce/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { UNATTRIBUTED_ENTITY_VALUE } from '@/features/finance/constants';

/**
 * `OrderIngestionService.setOrderAttribution` (loxep-7fs, A22) — had zero
 * callers, so an order's economic entity was whatever resolved at ingest
 * FOREVER, feeding every downstream financial figure. Explicit, audited
 * per-order override: flips `entity_attribution_source` to `manual`, which
 * `reattributeOrders`'s bulk correction (not mounted this pass) will never
 * touch again.
 */
export default function OrderAttributionDialog({
  open,
  onOpenChange,
  orderId,
  currentEconomicEntityId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  currentEconomicEntityId: string | null;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <OrderAttributionContent
          key={`${orderId}:${currentEconomicEntityId ?? UNATTRIBUTED_ENTITY_VALUE}`}
          onOpenChange={onOpenChange}
          orderId={orderId}
          currentEconomicEntityId={currentEconomicEntityId}
        />
      )}
    </ResponsiveDialog>
  );
}

function OrderAttributionContent({
  onOpenChange,
  orderId,
  currentEconomicEntityId
}: {
  onOpenChange: (open: boolean) => void;
  orderId: string;
  currentEconomicEntityId: string | null;
}) {
  const queryClient = useQueryClient();
  const { data: entities } = useQuery(entitiesQuery);
  const [economicEntityId, setEconomicEntityId] = React.useState(
    currentEconomicEntityId ?? UNATTRIBUTED_ENTITY_VALUE
  );

  const mutation = useMutation({
    mutationFn: () =>
      setOrderAttribution({
        data: {
          orderId,
          economicEntityId: economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : economicEntityId
        }
      }),
    onSuccess: () => {
      toast.success('Order attribution updated');
      void queryClient.invalidateQueries({ queryKey: orderQuery(orderId).queryKey });
      void queryClient.invalidateQueries({ queryKey: ['commerce', 'orders'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not update attribution')
  });

  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...(entities ?? []).map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  return (
    <ResponsiveDialogContent className='sm:max-w-[420px]'>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Set order attribution</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          An explicit, audited override. Feeds every downstream financial figure for this order —
          change it deliberately.
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
            Save
          </Button>
        </div>
      </div>
    </ResponsiveDialogContent>
  );
}
