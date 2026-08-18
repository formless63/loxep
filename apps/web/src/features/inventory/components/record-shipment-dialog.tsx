import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { useAppForm } from '@/lib/form';
import { formatQuantity } from '@/lib/format';
import { recordShipment } from '@/server/inventory-functions';
import { shipmentsForOrderQuery } from '@/features/inventory/api/queries';

const decimalInput = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive decimal, e.g. 8.50');

const shipmentFormSchema = z.object({
  carrierName: z.string().trim(),
  carrierCode: z.string().trim(),
  serviceCode: z.string().trim(),
  trackingNumber: z.string().trim(),
  trackingUrl: z.string().trim(),
  postageAmount: decimalInput,
  insuranceAmount: decimalInput,
  surchargeAmount: decimalInput,
  orderLineIds: z.array(z.string())
});

type ShipmentFormValues = z.infer<typeof shipmentFormSchema>;

export interface RecordShipmentOrderLine {
  id: string;
  title: string | null;
  quantity: string;
}

/**
 * `ShipmentsService.record` (loxep-7fs, A14) — `ShipmentsService` was dead
 * in its entirety. `orderLineIds` (checked at the line's own full order
 * quantity) become `shipment_items` rows, which is what lets
 * `@loxep/inventory/profitability.ts`'s `gatherShipping` actually allocate
 * this shipment's net cost per item — a shipment recorded with no items
 * contributes only its own row, never a per-item allocation.
 */
export default function RecordShipmentDialog({
  open,
  onOpenChange,
  orderId,
  currency,
  lines
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  currency: string;
  lines: RecordShipmentOrderLine[];
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: ShipmentFormValues) =>
      recordShipment({
        data: {
          shipmentKind: 'outbound_sale',
          orderId,
          currency,
          carrierName: values.carrierName.trim() === '' ? null : values.carrierName.trim(),
          carrierCode: values.carrierCode.trim() === '' ? null : values.carrierCode.trim(),
          serviceCode: values.serviceCode.trim() === '' ? null : values.serviceCode.trim(),
          trackingNumber: values.trackingNumber.trim() === '' ? null : values.trackingNumber.trim(),
          trackingUrl: values.trackingUrl.trim() === '' ? null : values.trackingUrl.trim(),
          postageAmount: values.postageAmount,
          insuranceAmount: values.insuranceAmount,
          surchargeAmount: values.surchargeAmount,
          orderLineIds: values.orderLineIds
        }
      }),
    onSuccess: () => {
      toast.success('Shipment recorded');
      void queryClient.invalidateQueries({ queryKey: shipmentsForOrderQuery(orderId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to record shipment');
    }
  });

  const form = useAppForm({
    defaultValues: {
      carrierName: '',
      carrierCode: '',
      serviceCode: '',
      trackingNumber: '',
      trackingUrl: '',
      postageAmount: '0',
      insuranceAmount: '0',
      surchargeAmount: '0',
      orderLineIds: [] as string[]
    } as ShipmentFormValues,
    validators: { onSubmit: shipmentFormSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Record a shipment</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Outbound carrier reality — what the carrier and we actually did, distinct from what the
            channel reported.
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
                name='carrierName'
                children={(field) => <field.TextField label='Carrier' placeholder='e.g. USPS' />}
              />
              <form.AppField
                name='serviceCode'
                children={(field) => (
                  <field.TextField label='Service' placeholder='e.g. Priority Mail' />
                )}
              />
            </div>
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              <form.AppField
                name='trackingNumber'
                children={(field) => <field.TextField label='Tracking number' />}
              />
              <form.AppField
                name='carrierCode'
                children={(field) => (
                  <field.TextField label='Carrier code' placeholder='e.g. usps' />
                )}
              />
            </div>
            <form.AppField
              name='trackingUrl'
              children={(field) => <field.TextField label='Tracking URL' />}
            />
            <div className='grid grid-cols-1 gap-6 md:grid-cols-3'>
              <form.AppField
                name='postageAmount'
                children={(field) => <field.TextField label={`Postage (${currency})`} required />}
              />
              <form.AppField
                name='insuranceAmount'
                children={(field) => <field.TextField label={`Insurance (${currency})`} required />}
              />
              <form.AppField
                name='surchargeAmount'
                children={(field) => <field.TextField label={`Surcharge (${currency})`} required />}
              />
            </div>

            {lines.length > 0 && (
              <form.Field name='orderLineIds' mode='array'>
                {(field) => (
                  <Field>
                    <FieldLabel>Order lines in this shipment</FieldLabel>
                    <div className='space-y-2 rounded-md border p-3'>
                      {lines.map((line) => {
                        const checked = field.state.value.includes(line.id);
                        return (
                          <label
                            key={line.id}
                            className='flex items-center gap-2 text-sm'
                            htmlFor={`shipment-line-${line.id}`}
                          >
                            <Checkbox
                              id={`shipment-line-${line.id}`}
                              checked={checked}
                              onCheckedChange={(next) => {
                                if (next === true) {
                                  if (!checked) field.pushValue(line.id);
                                } else {
                                  const index = field.state.value.indexOf(line.id);
                                  if (index >= 0) field.removeValue(index);
                                }
                              }}
                            />
                            <span>
                              {line.title ?? line.id}
                              <span className='text-muted-foreground'>
                                {' '}
                                &middot; qty {formatQuantity(Number(line.quantity))}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <FieldDescription>
                      Each checked line is attached at its full order quantity — this is what lets
                      the profitability engine allocate this shipment&rsquo;s cost per item.
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>
            )}
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Record shipment
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
