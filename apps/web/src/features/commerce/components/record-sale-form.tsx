import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { recordManualListingSale } from '@/server/commerce-functions';

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
 */
export default function RecordSaleForm({
  open,
  onOpenChange,
  channelListingId,
  defaultUnitPrice
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelListingId: string;
  defaultUnitPrice?: string | null;
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>Record sale</DialogTitle>
          <DialogDescription>
            Records a manual order for this listing and depletes the linked stock unit. PROVISIONAL:
            manual orders were unrecordable until this milestone — see design open question 7.
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
      </DialogContent>
    </Dialog>
  );
}
