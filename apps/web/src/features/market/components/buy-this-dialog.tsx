import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
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
import { itemEventsQuery } from '@/features/market/api/queries';
import {
  readOpportunityPayload,
  type MarketEventDto,
  type MarketItemDetailDto,
  type OpportunityPayloadDto
} from '@/server/market-functions';
import { createAcquisitionFromMarketItem } from '@/server/inventory-functions';

const buySchema = z.object({
  label: z.string().trim().min(1, 'A description is required'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  goodsCostAmount: z.string(),
  vendorName: z.string()
});

type BuyFormValues = z.infer<typeof buySchema>;

function findLatestOpportunity(
  events: MarketEventDto[] | undefined
): { event: MarketEventDto; payload: OpportunityPayloadDto } | null {
  for (const event of events ?? []) {
    const payload = readOpportunityPayload(event.payload);
    if (payload !== null) return { event, payload };
  }
  return null;
}

/**
 * "I bought this" — the `/market` → `/inventory` handoff (loxep-dgf.2, the
 * design's "the weave" section). Prefilled from the watched item: title into
 * `label`, the last observed price into the goods cost, the seller into
 * `vendorName`, the listing URL becomes `externalReference`. The score is
 * read off the most recent rule-stamped event (`payload.opportunity`) and
 * snapshotted at submit time — never joined live later, per the design's
 * explicit rule.
 *
 * Submitting is blocked on the same missing `@loxep/inventory` dependency as
 * every write in `@/server/inventory-functions.ts` (see its top doc) — the
 * link TABLE (`acquisition_opportunity_links`) already exists from Phase 4,
 * so this is not the "link table doesn't exist" fallback case, only the
 * package-wiring one.
 */
export default function BuyThisDialog({
  open,
  onOpenChange,
  item
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: MarketItemDetailDto;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: eventsPage } = useQuery(itemEventsQuery(item.id, 0, 'desc'));

  const latestOpportunity = findLatestOpportunity(eventsPage?.events);

  const observation = item.latestObservation;

  const mutation = useMutation({
    mutationFn: (values: BuyFormValues) =>
      createAcquisitionFromMarketItem({
        data: {
          marketplaceItemId: item.id,
          marketEventId: latestOpportunity?.event.id ?? null,
          label: values.label,
          currency: values.currency.toUpperCase(),
          goodsCostAmount: values.goodsCostAmount.trim() === '' ? null : values.goodsCostAmount,
          vendorName: values.vendorName.trim() === '' ? null : values.vendorName.trim(),
          externalReference: item.canonicalUrl,
          scoreAtLink: latestOpportunity !== null ? String(latestOpportunity.payload.score) : null,
          targetPriceAmount: observation?.price ?? null
        }
      }),
    onSuccess: async (result) => {
      toast.success(`Recorded as ${result.acquisitionReferenceCode}`);
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      await navigate({
        to: '/inventory/acquisitions/$id',
        params: { id: result.acquisitionId }
      });
    },
    onError: (error) => toastError(error, 'Could not record the purchase')
  });

  const form = useAppForm({
    defaultValues: {
      label: item.title ?? item.externalItemId,
      currency: observation?.currency ?? 'USD',
      goodsCostAmount: observation?.price ?? '',
      vendorName: item.sellerExternalId ?? ''
    } as BuyFormValues,
    validators: { onSubmit: buySchema },
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
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>I bought this</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Opens an acquisition and an intake item prefilled from the listing. The score behind
            this item, if any, is frozen at today's value — editing a rule later never rewrites how
            good this decision looked.
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
              name='label'
              children={(field) => <field.TextField label='Description' required />}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='goodsCostAmount'
                children={(field) => (
                  <field.TextField label='Price paid' inputMode='decimal' placeholder='0.00' />
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
              name='vendorName'
              children={(field) => <field.TextField label='Seller' />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.add />
                Record purchase
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
