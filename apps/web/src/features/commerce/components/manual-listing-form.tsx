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
import { inventoryItemsQuery } from '@/features/inventory/api/queries';
import { manualListingChannelOptions } from '@/features/commerce/constants';
import { createManualChannelListing } from '@/server/commerce-functions';

const DEFAULT_CURRENCY = 'USD';

const manualListingSchema = z.object({
  inventoryItemId: z.string().min(1, 'Pick an item'),
  channel: z.string().min(1),
  status: z.enum(['draft', 'active']),
  listingTitle: z.string(),
  price: z.string(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  listingUrl: z.string()
});

type ManualListingFormValues = z.infer<typeof manualListingSchema>;

export interface ManualListingFormPrefill {
  inventoryItemId: string;
  itemLabel: string;
  itemCode: string;
  currency?: string;
  estimatedValueAmount?: string | null;
}

/**
 * Create a manual/offline channel listing for an inventory item (design 4a,
 * loxep-dgf.6). When `prefill` names a specific item (opened from
 * `/inventory/stock/:id`'s listings panel), the item field is locked; opened
 * from `/commerce/listings` it is a picker over available/listed stock —
 * the same `SelectField` shape `IntakeForm` uses for its lot/location
 * pickers.
 *
 * The mapping preview (design 4b): title and price default from the item's
 * `label`/`estimatedValueAmount` — the same fields
 * `@loxep/commerce/src/listing-draft.ts`'s pure `mapItemToDraftListing`
 * maps, shown here as ordinary editable defaults rather than a separate
 * read-only preview call (that package is not yet an `apps/web` dependency —
 * see `@/server/commerce-functions.ts`'s file header).
 */
export default function ManualListingForm({
  open,
  onOpenChange,
  prefill
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: ManualListingFormPrefill;
}) {
  const queryClient = useQueryClient();
  const needsPicker = prefill === undefined;
  const { data: items } = useQuery({
    ...inventoryItemsQuery({ status: 'available' }),
    enabled: needsPicker && open
  });
  const itemOptions = (items ?? []).map((item) => ({
    value: item.id,
    label: `${item.itemCode} — ${item.label}`
  }));

  const mutation = useMutation({
    mutationFn: (values: ManualListingFormValues) =>
      createManualChannelListing({
        data: {
          inventoryItemId: values.inventoryItemId,
          channel: values.channel as
            | 'facebook_marketplace'
            | 'craigslist'
            | 'offerup'
            | 'in_person'
            | 'local_pickup'
            | 'consignment_shop'
            | 'other',
          status: values.status,
          listingTitle: values.listingTitle.trim() === '' ? null : values.listingTitle,
          listingUrl: values.listingUrl.trim() === '' ? null : values.listingUrl,
          price: values.price.trim() === '' ? null : values.price,
          currency: values.currency.toUpperCase()
        }
      }),
    onSuccess: (result) => {
      toast.success(`Listed as ${result.listingCode}`);
      void queryClient.invalidateQueries({ queryKey: ['commerce'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not create the listing')
  });

  const form = useAppForm({
    defaultValues: {
      inventoryItemId: prefill?.inventoryItemId ?? '',
      channel: 'facebook_marketplace',
      status: 'draft',
      listingTitle: prefill?.itemLabel ?? '',
      price: prefill?.estimatedValueAmount ?? '',
      currency: prefill?.currency ?? DEFAULT_CURRENCY,
      listingUrl: ''
    } as ManualListingFormValues,
    validators: { onSubmit: manualListingSchema },
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
          <DialogTitle>Create manual listing</DialogTitle>
          <DialogDescription>
            {prefill
              ? `Lists ${prefill.itemCode} — ${prefill.itemLabel} on an offline channel. There is nothing to publish: the listing IS the record.`
              : 'Pick an available item and list it on an offline channel. There is nothing to publish: the listing IS the record.'}
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
            {needsPicker && (
              <form.AppField
                name='inventoryItemId'
                children={(field) => <field.SelectField label='Item' options={itemOptions} />}
              />
            )}
            <form.AppField
              name='channel'
              children={(field) => (
                <field.SelectField label='Channel' options={manualListingChannelOptions} />
              )}
            />
            <form.AppField
              name='listingTitle'
              children={(field) => (
                <field.TextField
                  label='Listing title'
                  placeholder='e.g. Vintage brass table lamp'
                />
              )}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='price'
                children={(field) => (
                  <field.TextField label='Price' inputMode='decimal' placeholder='0.00' />
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
              name='status'
              children={(field) => (
                <field.SelectField
                  label='Status'
                  options={[
                    { value: 'draft', label: 'Draft — not posted yet' },
                    { value: 'active', label: 'Active — already posted' }
                  ]}
                />
              )}
            />
            <form.AppField
              name='listingUrl'
              children={(field) => (
                <field.TextField
                  label='Listing URL'
                  placeholder='https://…'
                  description='Paste the live listing URL, if there is one.'
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
                Create listing
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
