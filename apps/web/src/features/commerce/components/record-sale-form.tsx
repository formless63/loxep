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
import {
  recordManualListingSale,
  type RecordManualSaleResultDto
} from '@/server/commerce-functions';

const recordSaleSchema = z.object({
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive quantity, e.g. 1'),
  unitPrice: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 45.00')
});

type RecordSaleFormValues = z.infer<typeof recordSaleSchema>;

/**
 * "Record sale" — design open question 7, resolved PROVISIONALLY (see
 * `flipping-lifecycle-design.md` section 4a's gap and `@loxep/commerce/src/manual-sales.ts`).
 * Writes a manual `orders` + `order_lines` row and depletes the linked
 * inventory unit. Only ever shown for `provider = 'manual'` listings that
 * are not already `sold_out`/`ended` — the caller (`ListingDetail`) enforces
 * that.
 *
 * There is no `/commerce/orders` route yet (see the roadmap), so
 * `orderId`/`orderLineId` have nowhere to link to today — `onRecorded`
 * hands the full result (including the `oversell` flag) back to
 * `ListingDetail`, which already renders the created line in its Sales
 * panel and is where the oversell warning is kept visible non-transiently,
 * past the toast.
 */
export default function RecordSaleForm({
  open,
  onOpenChange,
  channelListingId,
  defaultUnitPrice,
  onRecorded
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelListingId: string;
  defaultUnitPrice?: string | null;
  onRecorded?: (result: RecordManualSaleResultDto) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: RecordSaleFormValues) =>
      recordManualListingSale({
        data: { channelListingId, quantity: values.quantity, unitPrice: values.unitPrice }
      }),
    onSuccess: (result) => {
      toast.success(result.oversell ? 'Sale recorded — flagged as an oversell' : 'Sale recorded');
      void queryClient.invalidateQueries({ queryKey: ['commerce'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onRecorded?.(result);
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not record the sale')
  });

  const form = useAppForm({
    defaultValues: {
      quantity: '1',
      unitPrice: defaultUnitPrice ?? ''
    } as RecordSaleFormValues,
    validators: { onSubmit: recordSaleSchema },
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
          <ResponsiveDialogTitle>Record sale</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Records a manual order for this listing and depletes the linked stock unit. PROVISIONAL:
            manual orders were unrecordable until this milestone — see design open question 7.
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
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='quantity'
                children={(field) => (
                  <field.TextField label='Quantity' required inputMode='decimal' />
                )}
              />
              <form.AppField
                name='unitPrice'
                children={(field) => (
                  <field.TextField
                    label='Unit price'
                    required
                    inputMode='decimal'
                    placeholder='0.00'
                  />
                )}
              />
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.check />
                Record sale
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
