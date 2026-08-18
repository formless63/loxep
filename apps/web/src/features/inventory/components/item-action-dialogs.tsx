import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import {
  moveItemToLocation,
  setItemCondition,
  transferItemEntity
} from '@/server/inventory-functions';
import { inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { itemConditionOptions } from '@/features/inventory/constants';

/**
 * A8 (loxep-wx3) — `ItemsService.moveToLocation`/`setCondition`/
 * `transferEntity` had zero callers. `correctCostBasis` (the ONLY way a
 * locked basis changes, audited) is deliberately NOT mounted — see this
 * pass's own report. Quantity fields are left blank for "the whole unit",
 * matching the service's own `quantity?: string` optional-means-whole-item
 * convention.
 */
export function MoveItemLocationDialog({
  open,
  onOpenChange,
  inventoryItemId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventoryItemId: string;
}) {
  const queryClient = useQueryClient();
  const { data: locations } = useQuery({ ...inventoryLocationsQuery, enabled: open });

  const schema = z.object({
    toLocationId: z.string().min(1, 'Pick a location'),
    quantity: z
      .string()
      .trim()
      .regex(/^$|^\d+(\.\d+)?$/, 'Leave blank for the whole item, or enter a positive quantity'),
    note: z.string().trim()
  });
  type FormValues = z.infer<typeof schema>;

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      moveItemToLocation({
        data: {
          inventoryItemId,
          toLocationId: values.toLocationId,
          quantity: values.quantity.trim() === '' ? null : values.quantity.trim(),
          note: values.note.trim() === '' ? null : values.note.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Item moved');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not move item')
  });

  const form = useAppForm({
    defaultValues: { toLocationId: '', quantity: '', note: '' } as FormValues,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const locationOptions = (locations ?? []).map((location) => ({
    value: location.id,
    label: location.name
  }));

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Move to location</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Writes a transfer-out/transfer-in pair. A partial quantity splits the row into a new one
            at the destination; leave blank to move the whole unit.
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
            <form.AppField
              name='toLocationId'
              children={(field) => (
                <field.SelectField label='Destination' required options={locationOptions} />
              )}
            />
            <form.AppField
              name='quantity'
              children={(field) => (
                <field.TextField label='Quantity' inputMode='decimal' placeholder='Whole item' />
              )}
            />
            <form.AppField name='note' children={(field) => <field.TextareaField label='Note' />} />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Move</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

const setConditionSchema = z.object({
  conditionCode: z.string().min(1),
  conditionNotes: z.string().trim()
});
type SetConditionFormValues = z.infer<typeof setConditionSchema>;

export function SetItemConditionDialog({
  open,
  onOpenChange,
  inventoryItemId,
  currentConditionCode,
  currentConditionNotes
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventoryItemId: string;
  currentConditionCode: string;
  currentConditionNotes: string | null;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: SetConditionFormValues) =>
      setItemCondition({
        data: {
          inventoryItemId,
          conditionCode: values.conditionCode as never,
          conditionNotes: values.conditionNotes.trim() === '' ? null : values.conditionNotes.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Condition updated');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not update condition')
  });

  const form = useAppForm({
    defaultValues: {
      conditionCode: currentConditionCode,
      conditionNotes: currentConditionNotes ?? ''
    } as SetConditionFormValues,
    validators: { onSubmit: setConditionSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Set condition</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Condition and grading are ordinary mutable facts about the unit.
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
            <form.AppField
              name='conditionCode'
              children={(field) => (
                <field.SelectField label='Condition' required options={itemConditionOptions} />
              )}
            />
            <form.AppField
              name='conditionNotes'
              children={(field) => <field.TextareaField label='Notes' />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

const NO_ENTITY_VALUE = '__none__';

const transferEntitySchema = z
  .object({
    toEconomicEntityId: z.string().min(1, 'Pick an entity'),
    basisTreatment: z.enum(['carryover', 'fair_market_value']),
    fairMarketValueAmount: z.string().trim(),
    quantity: z
      .string()
      .trim()
      .regex(/^$|^\d+(\.\d+)?$/),
    note: z.string().trim()
  })
  .refine(
    (value) => value.basisTreatment !== 'fair_market_value' || value.fairMarketValueAmount !== '',
    { message: 'Required for fair-market-value treatment', path: ['fairMarketValueAmount'] }
  );
type TransferEntityFormValues = z.infer<typeof transferEntitySchema>;

/**
 * "The harder thing is the right thing" (`@loxep/inventory/items.ts`'s
 * module doc): this NEVER updates `economic_entity_id` in place — it writes
 * a new item row for the receiving entity, linked by `origin_item_id`. Basis
 * treatment has no default; Phase 4 declines to make that tax determination
 * for the operator, so both options are always presented explicitly.
 */
export function TransferItemEntityDialog({
  open,
  onOpenChange,
  inventoryItemId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventoryItemId: string;
}) {
  const queryClient = useQueryClient();
  const { data: entities } = useQuery({ ...entitiesQuery, enabled: open });

  const mutation = useMutation({
    mutationFn: (values: TransferEntityFormValues) =>
      transferItemEntity({
        data: {
          inventoryItemId,
          toEconomicEntityId: values.toEconomicEntityId,
          basisTreatment: values.basisTreatment,
          fairMarketValueAmount:
            values.fairMarketValueAmount.trim() === '' ? null : values.fairMarketValueAmount.trim(),
          quantity: values.quantity.trim() === '' ? null : values.quantity.trim(),
          note: values.note.trim() === '' ? null : values.note.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Transferred to a new item row for the receiving entity');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not transfer item')
  });

  const form = useAppForm({
    defaultValues: {
      toEconomicEntityId: NO_ENTITY_VALUE,
      basisTreatment: 'carryover',
      fairMarketValueAmount: '',
      quantity: '',
      note: ''
    } as TransferEntityFormValues,
    validators: { onSubmit: transferEntitySchema },
    onSubmit: async ({ value }) => {
      if (value.toEconomicEntityId === NO_ENTITY_VALUE) {
        toast.error('Pick a receiving entity');
        return;
      }
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const entityOptions = [
    { value: NO_ENTITY_VALUE, label: 'Select an entity' },
    ...(entities ?? []).map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Transfer to entity</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Moves ownership, never in place — a new item row is created for the receiving entity;
            this row remains, depleted, with its history and basis intact.
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
            <form.AppField
              name='toEconomicEntityId'
              children={(field) => (
                <field.SelectField label='Receiving entity' required options={entityOptions} />
              )}
            />
            <form.AppField
              name='basisTreatment'
              children={(field) => (
                <field.SelectField
                  label='Basis treatment'
                  required
                  options={[
                    { value: 'carryover', label: 'Carryover — keep the original basis' },
                    {
                      value: 'fair_market_value',
                      label: 'Fair market value — restate the basis'
                    }
                  ]}
                  description='A tax determination Loxep declines to default.'
                />
              )}
            />
            <form.Field name='basisTreatment'>
              {(basisField) =>
                basisField.state.value === 'fair_market_value' && (
                  <form.AppField
                    name='fairMarketValueAmount'
                    children={(field) => (
                      <field.TextField
                        label='Fair market value amount'
                        required
                        inputMode='decimal'
                        placeholder='0.00'
                      />
                    )}
                  />
                )
              }
            </form.Field>
            <form.AppField
              name='quantity'
              children={(field) => (
                <field.TextField label='Quantity' inputMode='decimal' placeholder='Whole item' />
              )}
            />
            <form.AppField name='note' children={(field) => <field.TextareaField label='Note' />} />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Transfer</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
