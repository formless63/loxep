import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
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
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatQuantity } from '@/lib/format';
import { recordInventoryMovement, reverseInventoryMovement } from '@/server/inventory-functions';
import { inventoryItemsQuery, inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { movementIsInbound, movementKindLabel } from '@/features/inventory/constants';
import type { InventoryMovementListItemDto } from '@/server/inventory-functions';

const NO_LOCATION_VALUE = '__none__';

/**
 * The manual-adjustment subset of `movementKind` — see
 * `@/server/inventory-functions.ts`'s `recordInventoryMovement` doc for why
 * `receipt`/`transfer_*`/`depletion_sale`/`reversal` are excluded.
 */
const MANUAL_MOVEMENT_KIND_VALUES = [
  'adjustment_in',
  'adjustment_out',
  'found',
  'shrinkage',
  'disposal',
  'consumption'
] as const;

const recordAdjustmentSchema = z.object({
  inventoryItemId: z.string().min(1, 'Pick an item'),
  movementKind: z.enum(MANUAL_MOVEMENT_KIND_VALUES),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Enter a positive quantity — direction comes from the kind'),
  locationId: z.string(),
  reasonCode: z.string().trim(),
  note: z.string().trim()
});

type RecordAdjustmentFormValues = z.infer<typeof recordAdjustmentSchema>;

/**
 * A8 (loxep-wx3) — `MovementsService.record` had zero callers: no
 * cycle-count adjustment, found stock, shrinkage, disposal, or consumption
 * could be entered anywhere in the product. Quantity is typed as a positive
 * magnitude; the sign the ledger's `CHECK` requires is derived from the
 * chosen kind (`movementIsInbound`), the same inbound/outbound classification
 * the movements table already uses to color rows — an operator should never
 * have to remember "shrinkage is negative."
 */
export function RecordMovementDialog({
  open,
  onOpenChange,
  defaultInventoryItemId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects the item and locks the picker — the item detail page's own "Record adjustment" entry point. */
  defaultInventoryItemId?: string;
}) {
  const queryClient = useQueryClient();
  const { data: items } = useQuery({ ...inventoryItemsQuery({}), enabled: open });
  const { data: locations } = useQuery({ ...inventoryLocationsQuery, enabled: open });

  const mutation = useMutation({
    mutationFn: (values: RecordAdjustmentFormValues) => {
      const inbound = movementIsInbound(values.movementKind);
      const magnitude = values.quantity.trim();
      return recordInventoryMovement({
        data: {
          inventoryItemId: values.inventoryItemId,
          movementKind: values.movementKind,
          quantity: inbound ? magnitude : `-${magnitude}`,
          locationId: values.locationId === NO_LOCATION_VALUE ? null : values.locationId,
          reasonCode: values.reasonCode.trim() === '' ? null : values.reasonCode.trim(),
          note: values.note.trim() === '' ? null : values.note.trim()
        }
      });
    },
    onSuccess: (result) => {
      toast.success(
        result.oversell
          ? `Movement recorded — on hand now ${formatQuantity(Number(result.quantityOnHand))} (below zero)`
          : `Movement recorded — on hand now ${formatQuantity(Number(result.quantityOnHand))}`
      );
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not record movement')
  });

  const form = useAppForm({
    defaultValues: {
      inventoryItemId: defaultInventoryItemId ?? '',
      movementKind: 'adjustment_in',
      quantity: '',
      locationId: NO_LOCATION_VALUE,
      reasonCode: '',
      note: ''
    } as RecordAdjustmentFormValues,
    validators: { onSubmit: recordAdjustmentSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const itemOptions = (items ?? []).map((item) => ({
    value: item.id,
    label: `${item.itemCode} — ${item.label}`
  }));
  const kindOptions = MANUAL_MOVEMENT_KIND_VALUES.map((value) => ({
    value,
    label: `${movementKindLabel(value)} (${movementIsInbound(value) ? '+' : '−'})`
  }));
  const locationOptions = [
    { value: NO_LOCATION_VALUE, label: 'No location' },
    ...(locations ?? []).map((location) => ({ value: location.id, label: location.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Record adjustment</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A cycle count, found stock, shrinkage, disposal, or consumption — written straight to
            the append-only ledger. Once written, the only correction is a reversal.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            {defaultInventoryItemId === undefined && (
              <form.AppField
                name='inventoryItemId'
                children={(field) => (
                  <field.ComboboxField
                    label='Item'
                    required
                    options={itemOptions}
                    placeholder='Select an item'
                    searchPlaceholder='Search items…'
                  />
                )}
              />
            )}
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='movementKind'
                children={(field) => (
                  <field.SelectField label='Kind' required options={kindOptions} />
                )}
              />
              <form.AppField
                name='quantity'
                children={(field) => (
                  <field.TextField
                    label='Quantity'
                    required
                    inputMode='decimal'
                    placeholder='0'
                    description='Positive magnitude — direction comes from the kind above.'
                  />
                )}
              />
            </div>
            <form.AppField
              name='locationId'
              children={(field) => <field.SelectField label='Location' options={locationOptions} />}
            />
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='reasonCode'
                children={(field) => (
                  <field.TextField label='Reason code' placeholder='e.g. annual_count' />
                )}
              />
            </div>
            <form.AppField name='note' children={(field) => <field.TextareaField label='Note' />} />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.add />
                Record
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * A8 — "Reverse" row action, the ONLY correction path for an append-only
 * ledger row. Names what it reverses (item, kind, signed quantity) in the
 * confirmation itself, matching `partners-table/cell-action.tsx`'s plain
 * (non-typed) `AlertDialog` precedent — this house has no typed-confirmation
 * convention inside `apps/web/src/features/inventory`.
 */
export function ReverseMovementDialog({
  open,
  onOpenChange,
  movement
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movement: InventoryMovementListItemDto | null;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => reverseInventoryMovement({ data: { movementId: movement?.id as string } }),
    onSuccess: (result) => {
      toast.success(`Reversed — on hand now ${formatQuantity(Number(result.quantityOnHand))}`);
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not reverse movement')
  });

  if (movement === null) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse this movement?</AlertDialogTitle>
          <AlertDialogDescription>
            Writes an opposite-sign correction against {movement.itemCode} —{' '}
            {movementKindLabel(movement.movementKind)} of{' '}
            {formatQuantity(Number(movement.quantity))}. The original row is never edited or
            deleted; this is the only correction path.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Reverse
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
