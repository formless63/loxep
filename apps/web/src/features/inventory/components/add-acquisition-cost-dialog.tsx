import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { addAcquisitionCost } from '@/server/inventory-functions';

const NO_ITEM_SCOPE_VALUE = '__lot__';

const addCostSchema = z.object({
  costType: z.string().trim().min(1, 'A cost type is required, e.g. shipping'),
  costClass: z.enum(['goods', 'ancillary']),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  inventoryItemId: z.string(),
  capitalize: z.enum(['true', 'false']),
  incurredAt: z.string(),
  vendorName: z.string(),
  description: z.string()
});

type AddCostFormValues = z.infer<typeof addCostSchema>;

/**
 * A7 (loxep-wx3) — `addAcquisitionCost` (`@/server/inventory-functions.ts:1362`)
 * had no importer anywhere; the only entry path into the cost pool
 * (`promoteExpenseToAcquisitionCost`) hard-codes `costType: 'goods'`, leaving
 * shipping/buyer's-premium/sales-tax unenterable and the "Allocate costs"
 * button above a pool the operator could never fill. This mounts the
 * existing, already-validated server function directly — no new domain
 * logic. Cost class is `goods` (capitalized into the item's landed cost
 * basis, e.g. the hammer price) vs. `ancillary` (shipping, buyer's premium,
 * sales tax — capitalized by default too, but distinguished in the landed
 * cost breakdown); scope is the lot as a whole (default — allocated across
 * items later) or one item directly (bypasses allocation for that item).
 */
export default function AddAcquisitionCostDialog({
  open,
  onOpenChange,
  acquisitionId,
  defaultCurrency,
  items
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  acquisitionId: string;
  defaultCurrency: string;
  items: { id: string; itemCode: string; label: string }[];
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: AddCostFormValues) =>
      addAcquisitionCost({
        data: {
          acquisitionId,
          costType: values.costType.trim(),
          costClass: values.costClass,
          amount: values.amount.trim(),
          currency: values.currency.toUpperCase(),
          inventoryItemId:
            values.inventoryItemId === NO_ITEM_SCOPE_VALUE ? null : values.inventoryItemId,
          capitalize: values.capitalize === 'true',
          incurredAt: values.incurredAt.trim() === '' ? null : values.incurredAt.trim(),
          vendorName: values.vendorName.trim() === '' ? null : values.vendorName.trim(),
          description: values.description.trim() === '' ? null : values.description.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Cost added');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not add cost')
  });

  const form = useAppForm({
    defaultValues: {
      costType: '',
      costClass: 'goods',
      amount: '',
      currency: defaultCurrency,
      inventoryItemId: NO_ITEM_SCOPE_VALUE,
      capitalize: 'true',
      incurredAt: '',
      vendorName: '',
      description: ''
    } as AddCostFormValues,
    validators: { onSubmit: addCostSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const itemOptions = [
    { value: NO_ITEM_SCOPE_VALUE, label: 'Whole lot (allocated later)' },
    ...items.map((item) => ({ value: item.id, label: `${item.itemCode} — ${item.label}` }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add cost</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A component of this lot's landed cost — shipping, buyer's premium, sales tax, or the
            goods themselves. Lot-scoped costs join the pool "Allocate costs" spreads across items.
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
              name='costType'
              children={(field) => (
                <field.TextField
                  label='Cost type'
                  required
                  placeholder='e.g. shipping, buyers_premium, sales_tax, goods'
                />
              )}
            />
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='costClass'
                children={(field) => (
                  <field.SelectField
                    label='Class'
                    required
                    options={[
                      { value: 'goods', label: 'Goods (the item itself)' },
                      { value: 'ancillary', label: 'Ancillary (shipping, fees, tax, …)' }
                    ]}
                  />
                )}
              />
              <form.AppField
                name='capitalize'
                children={(field) => (
                  <field.SelectField
                    label='Capitalize'
                    required
                    options={[
                      { value: 'true', label: 'Yes — part of landed cost basis' },
                      { value: 'false', label: 'No — real spend, excluded from basis' }
                    ]}
                  />
                )}
              />
            </div>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='amount'
                children={(field) => (
                  <field.TextField label='Amount' required inputMode='decimal' placeholder='0.00' />
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
              name='inventoryItemId'
              children={(field) => (
                <field.SelectField
                  label='Scope'
                  required
                  options={itemOptions}
                  description='An item-scoped cost bypasses allocation for that item.'
                />
              )}
            />
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='vendorName'
                children={(field) => <field.TextField label='Vendor' placeholder='optional' />}
              />
              <form.AppField
                name='incurredAt'
                children={(field) => <field.TextField label='Incurred on' type='date' />}
              />
            </div>
            <form.AppField
              name='description'
              children={(field) => <field.TextareaField label='Description' />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.add />
                Add cost
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
