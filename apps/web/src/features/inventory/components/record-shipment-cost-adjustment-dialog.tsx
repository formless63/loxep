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
import { useAppForm } from '@/lib/form';
import { recordShipmentCostAdjustment } from '@/server/inventory-functions';
import { shipmentsForOrderQuery } from '@/features/inventory/api/queries';

const decimalInput = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive decimal, e.g. 4.25');

const adjustmentFormSchema = z.object({
  adjustmentAmount: z.union([decimalInput, z.literal('')]),
  refundAmount: z.union([decimalInput, z.literal('')]),
  note: z.string().trim()
});

type AdjustmentFormValues = z.infer<typeof adjustmentFormSchema>;

/**
 * `ShipmentsService.recordCostAdjustment` (loxep-7fs, A14) — the ONLY way to
 * enter a carrier post-audit reweigh charge or a label refund arriving
 * after the shipment was first recorded. Both amounts ACCUMULATE onto the
 * shipment's existing `adjustment_amount`/`refund_amount`; they never
 * replace it.
 */
export default function RecordShipmentCostAdjustmentDialog({
  open,
  onOpenChange,
  shipmentId,
  orderId,
  currency
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: string;
  orderId: string;
  currency: string | null;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: AdjustmentFormValues) =>
      recordShipmentCostAdjustment({
        data: {
          shipmentId,
          ...(values.adjustmentAmount !== '' ? { adjustmentAmount: values.adjustmentAmount } : {}),
          ...(values.refundAmount !== '' ? { refundAmount: values.refundAmount } : {}),
          note: values.note.trim() === '' ? null : values.note.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Cost adjustment recorded');
      void queryClient.invalidateQueries({ queryKey: shipmentsForOrderQuery(orderId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to record adjustment');
    }
  });

  const form = useAppForm({
    defaultValues: { adjustmentAmount: '', refundAmount: '', note: '' } as AdjustmentFormValues,
    validators: {
      onSubmit: adjustmentFormSchema.refine(
        (value) => value.adjustmentAmount !== '' || value.refundAmount !== '',
        {
          message: 'Enter an adjustment or a refund amount',
          path: ['adjustmentAmount']
        }
      )
    },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Record a cost adjustment</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A carrier post-audit reweigh charge or a label refund — one of the most reliably
            underestimated costs in resale. Accumulates onto the shipment; never replaces it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          className='space-y-6'
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              <form.AppField
                name='adjustmentAmount'
                children={(field) => (
                  <field.TextField
                    label={`Additional charge${currency ? ` (${currency})` : ''}`}
                    placeholder='e.g. 4.25'
                  />
                )}
              />
              <form.AppField
                name='refundAmount'
                children={(field) => (
                  <field.TextField
                    label={`Refund${currency ? ` (${currency})` : ''}`}
                    placeholder='e.g. 2.00'
                  />
                )}
              />
            </div>
            <form.AppField
              name='note'
              children={(field) => (
                <field.TextField label='Note' placeholder='e.g. Carrier reweigh, 2026-08-18' />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Record adjustment
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
