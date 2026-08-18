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
import { linkChannelListingMarketplaceItem } from '@/server/commerce-functions';
import { channelListingQuery } from '@/features/commerce/api/queries';

const linkFormSchema = z.object({
  marketplaceItemId: z
    .string()
    .trim()
    .refine((value) => value === '' || z.uuid().safeParse(value).success, 'Enter a valid item id')
});

/**
 * `CatalogService.linkMarketplaceItem` (loxep-7fs, A22) — the only designed
 * bridge from `/market` observations to the catalog (`suggestChannelLinks`
 * proposes SKU matches from a provider sync; this is the manual confirm/
 * clear path for a listing where nothing matched, or the match was wrong).
 * `channel_listings.marketplace_item_id` is opportunistic and nullable — this
 * writes it directly, matching the design's "matching is a suggestion, never
 * an auto-link" rule: nothing here guesses, the operator supplies the id.
 */
export default function LinkMarketplaceItemDialog({
  open,
  onOpenChange,
  channelListingId,
  currentMarketplaceItemId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelListingId: string;
  currentMarketplaceItemId: string | null;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (marketplaceItemId: string | null) =>
      linkChannelListingMarketplaceItem({ data: { channelListingId, marketplaceItemId } }),
    onSuccess: () => {
      toast.success('Market listing link updated');
      void queryClient.invalidateQueries({
        queryKey: channelListingQuery(channelListingId).queryKey
      });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update market listing link');
    }
  });

  const form = useAppForm({
    defaultValues: { marketplaceItemId: currentMarketplaceItemId ?? '' },
    validators: { onSubmit: linkFormSchema },
    onSubmit: ({ value }) => {
      const trimmed = value.marketplaceItemId.trim();
      mutation.mutate(trimmed === '' ? null : trimmed);
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Link to observed market listing</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            An opportunistic, nullable link to an observed public listing on `/market` — a
            discovery, not an identity. Leave blank to clear it.
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
            <form.AppField
              name='marketplaceItemId'
              children={(field) => (
                <field.TextField
                  label='Market item id'
                  placeholder='Paste a marketplace item id, or leave blank to clear'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Save
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
