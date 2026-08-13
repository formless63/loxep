import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { DimensionsFields } from '@/features/inventory/components/dimensions-fields';
import PartOutDialog from '@/features/inventory/components/part-out-dialog';
import { itemSaleModeLabel, settableSaleModeOptions } from '@/features/inventory/constants';
import { setInventoryItemSaleMode, updateInventoryItem } from '@/server/inventory-functions';
import type { InventoryItemDetailDto } from '@/server/inventory-functions';

const decimalOrEmpty = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d+(\.\d{1,6})?$/.test(value), {
    message: 'Enter a positive decimal, e.g. 850 or 850.5'
  });

const enrichmentSchema = z
  .object({
    description: z.string(),
    packageWeightGrams: decimalOrEmpty,
    packageLengthMm: decimalOrEmpty,
    packageWidthMm: decimalOrEmpty,
    packageHeightMm: decimalOrEmpty
  })
  .refine(
    (value) => {
      const filled = [value.packageLengthMm, value.packageWidthMm, value.packageHeightMm].filter(
        (dimension) => dimension.trim() !== ''
      ).length;
      return filled === 0 || filled === 3;
    },
    {
      message:
        'Enter length, width, and height together, or leave all three blank — two of three is not partial information.',
      path: ['packageLengthMm']
    }
  );

/**
 * The M3 enrichment panel (loxep-dgf.3): description, package
 * dimensions/weight, and the `sale_mode` declaration, over
 * `itemsService.update()` / `.setSaleMode()`. The part-out trigger lives
 * here too, since it is the operation that RETIRES `sale_mode` editing —
 * once an item is `parted_out` this panel shows the fact rather than an
 * editable select (`ItemsService.setSaleMode` refuses the change anyway;
 * this is the UI saying so up front rather than presenting a control the
 * service will reject).
 */
export default function ItemEnrichmentPanel({ item }: { item: InventoryItemDetailDto }) {
  const queryClient = useQueryClient();
  const [partOutOpen, setPartOutOpen] = React.useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['inventory', 'item', item.id] });

  const updateMutation = useMutation({
    mutationFn: (input: {
      description: string;
      packageWeightGrams: string;
      packageLengthMm: string;
      packageWidthMm: string;
      packageHeightMm: string;
    }) =>
      updateInventoryItem({
        data: {
          id: item.id,
          description: input.description.trim() === '' ? null : input.description.trim(),
          packageWeightGrams:
            input.packageWeightGrams.trim() === '' ? null : input.packageWeightGrams,
          packageLengthMm: input.packageLengthMm.trim() === '' ? null : input.packageLengthMm,
          packageWidthMm: input.packageWidthMm.trim() === '' ? null : input.packageWidthMm,
          packageHeightMm: input.packageHeightMm.trim() === '' ? null : input.packageHeightMm
        }
      }),
    onSuccess: () => {
      toast.success('Item updated');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Could not update this item')
  });

  const saleModeMutation = useMutation({
    mutationFn: (saleMode: (typeof settableSaleModeOptions)[number]['value']) =>
      setInventoryItemSaleMode({ data: { id: item.id, saleMode } }),
    onSuccess: () => {
      toast.success('Sale mode updated');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Could not update sale mode')
  });

  const form = useAppForm({
    defaultValues: {
      description: item.description ?? '',
      packageWeightGrams: item.packageWeightGrams ?? '',
      packageLengthMm: item.packageLengthMm ?? '',
      packageWidthMm: item.packageWidthMm ?? '',
      packageHeightMm: item.packageHeightMm ?? ''
    },
    validators: { onSubmit: enrichmentSchema },
    onSubmit: async ({ value }) => {
      try {
        await updateMutation.mutateAsync(value);
      } catch {
        // Reported through updateMutation.onError's toast.
      }
    }
  });

  const saleModeForm = useAppForm({
    defaultValues: { saleMode: item.saleMode },
    onSubmit: async ({ value }) => {
      if (value.saleMode === item.saleMode) return;
      try {
        await saleModeMutation.mutateAsync(
          value.saleMode as (typeof settableSaleModeOptions)[number]['value']
        );
      } catch {
        // Reported through saleModeMutation.onError's toast.
      }
    }
  });

  const partedOut = item.saleMode === 'parted_out';

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Enrichment</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-6'>
        <div className='flex flex-col gap-2'>
          <span className='text-muted-foreground text-xs'>How this is sold</span>
          {partedOut ? (
            <div className='flex items-center gap-2'>
              <Badge variant='outline'>{itemSaleModeLabel('parted_out')}</Badge>
              <span className='text-muted-foreground text-sm'>
                Written by the part-out operation — not editable.
              </span>
            </div>
          ) : (
            <form
              className='flex items-end gap-3'
              onSubmit={(event) => {
                event.preventDefault();
                saleModeForm.handleSubmit();
              }}
            >
              <div className='w-56'>
                <saleModeForm.AppField
                  name='saleMode'
                  children={(field) => (
                    <field.SelectField label='Sale mode' options={settableSaleModeOptions} />
                  )}
                />
              </div>
              <saleModeForm.AppForm>
                <saleModeForm.SubmitButton variant='outline' size='sm'>
                  Save
                </saleModeForm.SubmitButton>
              </saleModeForm.AppForm>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={Number(item.quantityOnHand) <= 0}
                onClick={() => setPartOutOpen(true)}
              >
                Part out…
              </Button>
            </form>
          )}
        </div>

        <form
          className='flex flex-col gap-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <form.AppField
            name='description'
            children={(field) => (
              <field.TextareaField
                label='Description'
                placeholder='Internal authoring source — plain text or Markdown, not listing HTML.'
                rows={4}
              />
            )}
          />
          <DimensionsFields form={form} />
          <div>
            <form.AppForm>
              <form.SubmitButton size='sm'>Save enrichment</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </CardContent>

      <PartOutDialog
        open={partOutOpen}
        onOpenChange={setPartOutOpen}
        inventoryItemId={item.id}
        itemCode={item.itemCode}
      />
    </Card>
  );
}
