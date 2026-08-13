import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { acquisitionsQuery, inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { itemConditionOptions } from '@/features/inventory/constants';
import { createInventoryItem } from '@/server/inventory-functions';

const DEFAULT_CURRENCY = 'USD';

const intakeSchema = z.object({
  label: z.string().trim().min(1, 'A description is required'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  acquisitionId: z.string(),
  locationId: z.string(),
  conditionCode: z.string(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive quantity, e.g. 1'),
  acquisitionCostAmount: z.string(),
  estimatedValueAmount: z.string()
});

type IntakeFormValues = z.infer<typeof intakeSchema>;

export interface IntakeFormPrefill {
  acquisitionId?: string;
  currency?: string;
  vendorName?: string;
}

const NO_LOT_VALUE = '__no_lot__';
const NO_LOCATION_VALUE = '__no_location__';

/**
 * Intake review's create screen: one item against a lot (or "found stock"
 * with no lot). This is the ONE surface the design mandates serving three
 * producers eventually — hand entry today; an ingested eBay purchase and a
 * parsed receipt land in the same `CreateItemInput` shape in a later
 * milestone, so this form (and `createInventoryItem`'s validated contract)
 * needs no reshaping when they arrive.
 *
 * Blocked on `@loxep/inventory` not yet being an `apps/web` dependency (see
 * `@/server/inventory-functions.ts`'s top doc) — submitting shows the exact
 * fix through the same error-toast path a validation failure would use.
 */
export default function IntakeForm({
  open,
  onOpenChange,
  prefill
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: IntakeFormPrefill;
}) {
  const queryClient = useQueryClient();
  const { data: acquisitions } = useQuery(acquisitionsQuery({}));
  const { data: locations } = useQuery(inventoryLocationsQuery);

  const acquisitionOptions = [
    { value: NO_LOT_VALUE, label: 'No lot (found stock)' },
    ...(acquisitions ?? []).map((acquisition) => ({
      value: acquisition.id,
      label: `${acquisition.referenceCode} — ${acquisition.title}`
    }))
  ];
  const locationOptions = [
    { value: NO_LOCATION_VALUE, label: 'Unassigned' },
    ...(locations ?? []).map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`
    }))
  ];

  const mutation = useMutation({
    mutationFn: (values: IntakeFormValues) =>
      createInventoryItem({
        data: {
          label: values.label,
          currency: values.currency.toUpperCase(),
          acquisitionId: values.acquisitionId === NO_LOT_VALUE ? null : values.acquisitionId,
          locationId: values.locationId === NO_LOCATION_VALUE ? null : values.locationId,
          conditionCode: values.conditionCode as
            | 'new_sealed'
            | 'new_open_box'
            | 'like_new'
            | 'very_good'
            | 'good'
            | 'acceptable'
            | 'for_parts'
            | 'damaged'
            | 'unknown',
          quantity: values.quantity,
          ...(values.acquisitionCostAmount.trim() === ''
            ? {}
            : { acquisitionCostAmount: values.acquisitionCostAmount }),
          ...(values.estimatedValueAmount.trim() === ''
            ? {}
            : { estimatedValueAmount: values.estimatedValueAmount })
        }
      }),
    onSuccess: () => {
      toast.success('Item added to intake');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not add item')
  });

  const form = useAppForm({
    defaultValues: {
      label: '',
      currency: prefill?.currency ?? DEFAULT_CURRENCY,
      acquisitionId: prefill?.acquisitionId ?? NO_LOT_VALUE,
      locationId: NO_LOCATION_VALUE,
      conditionCode: 'unknown',
      quantity: '1',
      acquisitionCostAmount: '',
      estimatedValueAmount: ''
    } as IntakeFormValues,
    validators: { onSubmit: intakeSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>Add item to intake</DialogTitle>
          <DialogDescription>
            Creates one stock row in `intake` status. The same shape a receipt scan or an ingested
            purchase will use once those producers arrive.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField
              name='label'
              children={(field) => (
                <field.TextField label='Description' required placeholder='e.g. brass table lamp' />
              )}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='acquisitionId'
                children={(field) => <field.SelectField label='Lot' options={acquisitionOptions} />}
              />
              <form.AppField
                name='locationId'
                children={(field) => (
                  <field.SelectField label='Location' options={locationOptions} />
                )}
              />
            </div>
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='conditionCode'
                children={(field) => (
                  <field.SelectField label='Condition' options={itemConditionOptions} />
                )}
              />
              <form.AppField
                name='quantity'
                children={(field) => (
                  <field.TextField label='Quantity' required inputMode='decimal' />
                )}
              />
            </div>
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='acquisitionCostAmount'
                children={(field) => (
                  <field.TextField
                    label='Acquisition cost'
                    inputMode='decimal'
                    placeholder='0.00'
                    description='This item’s share of the lot’s goods cost, if known now.'
                  />
                )}
              />
              <form.AppField
                name='currency'
                children={(field) => (
                  <field.TextField label='Currency' required placeholder='USD' maxLength={3} />
                )}
              />
            </div>
            <form.AppField
              name='estimatedValueAmount'
              children={(field) => (
                <field.TextField
                  label='Estimated value'
                  inputMode='decimal'
                  placeholder='0.00'
                  description='Target resale price — not a valuation. Feeds relative-value cost allocation.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.add />
                Add item
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
