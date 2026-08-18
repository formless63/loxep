import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { formatBytes, formatDateTime } from '@/lib/format';
import { toastError } from '@/lib/errors';
import { detachInventoryItemMedia, reorderInventoryItemMedia } from '@/server/inventory-functions';
import type { ItemMediaDto } from '@/server/inventory-functions';
import { uploadInventoryImage } from '@/features/inventory/api/image-upload';

function purposeIcon(mimeType: string | null) {
  if (mimeType === 'application/pdf') return Icons.fileTypePdf;
  return Icons.media;
}

/**
 * `media_links.purpose` values for an inventory item (`INVENTORY_ITEM_MEDIA_PURPOSES`,
 * `packages/db/src/schema/inventory.ts`) — the sale listing's photo set,
 * plus condition-evidence photos and supporting documents captured at
 * intake, which were uploaded and stored but had no tab to view them from
 * (loxep-759).
 */
const MEDIA_PURPOSES = [
  { value: 'gallery', label: 'Photos' },
  { value: 'condition_evidence', label: 'Condition evidence' },
  { value: 'supporting_document', label: 'Documents' }
] as const;
type MediaPurpose = (typeof MEDIA_PURPOSES)[number]['value'];

/**
 * Item media gallery (M3, loxep-dgf.3) — `media_links` rows over
 * `@loxep/inventory`'s `InventoryMediaService`, tabbed by `purpose`. Mirrors
 * `@/features/finance/components/receipt-gallery.tsx`'s shape, plus the
 * simple up/down reorder the design sanctions in place of DnD Kit.
 *
 * **Primary is the FIRST row of the `gallery` tab — a sort, never a flag.**
 * Reordering therefore only ever swaps `sort_order` between two adjacent
 * rows of the SAME purpose (`reorderInventoryItemMedia`); nothing here ever
 * writes `purpose` on an existing row.
 */
export default function ImageGallery({
  inventoryItemId,
  media
}: {
  inventoryItemId: string;
  media: ItemMediaDto[];
}) {
  const [purpose, setPurpose] = React.useState<MediaPurpose>('gallery');
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['inventory', 'item', inventoryItemId] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadInventoryImage({ file, inventoryItemId, purpose }),
    onSuccess: () => {
      toast.success('Photo added');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Failed to upload photo')
  });

  const detachMutation = useMutation({
    mutationFn: (mediaObjectId: string) =>
      detachInventoryItemMedia({ data: { inventoryItemId, mediaObjectId, purpose } }),
    onSuccess: () => {
      toast.success('Photo removed');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Failed to remove photo')
  });

  const reorderMutation = useMutation({
    mutationFn: (input: { a: ItemMediaDto; b: ItemMediaDto }) =>
      reorderInventoryItemMedia({
        data: {
          inventoryItemId,
          purpose,
          moves: [
            { mediaObjectId: input.a.mediaObjectId, sortOrder: input.b.sortOrder ?? 0 },
            { mediaObjectId: input.b.mediaObjectId, sortOrder: input.a.sortOrder ?? 0 }
          ]
        }
      }),
    onSuccess: () => void invalidate(),
    onError: (error) => toastError(error, 'Failed to reorder photos')
  });

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    uploadMutation.mutate(file);
  }

  const gallery = media.filter((item) => item.purpose === purpose);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Tabs value={purpose} onValueChange={(value) => setPurpose(value as MediaPurpose)}>
          <TabsList>
            {MEDIA_PURPOSES.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
                <Badge variant='secondary' className='ml-1'>
                  {media.filter((item) => item.purpose === option.value).length}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div>
          <input
            ref={fileInputRef}
            type='file'
            accept='image/png,image/jpeg,image/webp'
            className='hidden'
            onChange={handleFileChange}
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.upload />
            {uploadMutation.isPending ? 'Uploading…' : 'Add file'}
          </Button>
        </div>
      </div>

      {gallery.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.media />
            </EmptyMedia>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>
              {purpose === 'gallery'
                ? 'The first photo added becomes the primary listing image.'
                : 'Nothing has been uploaded under this purpose yet.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {gallery.map((item, index) => {
            const Icon = purposeIcon(item.mimeType);
            const previous = gallery[index - 1];
            const next = gallery[index + 1];
            return (
              <li
                key={item.mediaObjectId}
                className='flex items-center gap-3 rounded-lg border p-3'
              >
                <Icon className='text-muted-foreground size-8 shrink-0' />
                <div className='min-w-0 flex-1'>
                  <a
                    href={item.servingUrl}
                    target='_blank'
                    rel='noreferrer'
                    className='block truncate text-sm font-medium hover:underline'
                  >
                    {item.originalFilename ?? item.mediaObjectId}
                  </a>
                  <div className='text-muted-foreground flex flex-wrap items-center gap-1 text-xs'>
                    {index === 0 && <Badge variant='secondary'>Primary</Badge>}
                    <span>{formatBytes(item.sizeBytes)}</span>
                    <span>·</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label='Move earlier'
                    disabled={previous === undefined || reorderMutation.isPending}
                    onClick={() => previous && reorderMutation.mutate({ a: item, b: previous })}
                  >
                    <Icons.chevronUp />
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label='Move later'
                    disabled={next === undefined || reorderMutation.isPending}
                    onClick={() => next && reorderMutation.mutate({ a: item, b: next })}
                  >
                    <Icons.chevronDown />
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label='Remove photo'
                    disabled={detachMutation.isPending}
                    onClick={() => detachMutation.mutate(item.mediaObjectId)}
                  >
                    <Icons.trash />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
