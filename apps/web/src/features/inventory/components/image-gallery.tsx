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
 * Item image gallery (M3, loxep-dgf.3) — `media_links` rows over
 * `@loxep/inventory`'s `InventoryMediaService`, scoped to `purpose:
 * 'gallery'` (condition-evidence/supporting-document photos are not shown
 * here; this is the sale listing's photo set). Mirrors
 * `@/features/finance/components/receipt-gallery.tsx`'s shape, plus the
 * simple up/down reorder the design sanctions in place of DnD Kit.
 *
 * **Primary is the FIRST row — a sort, never a flag.** Reordering therefore
 * only ever swaps `sort_order` between two adjacent rows
 * (`reorderInventoryItemMedia`); nothing here ever writes `purpose`.
 */
export default function ImageGallery({
  inventoryItemId,
  media
}: {
  inventoryItemId: string;
  media: ItemMediaDto[];
}) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['inventory', 'item', inventoryItemId] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadInventoryImage({ file, inventoryItemId, purpose: 'gallery' }),
    onSuccess: () => {
      toast.success('Photo added');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Failed to upload photo')
  });

  const detachMutation = useMutation({
    mutationFn: (mediaObjectId: string) =>
      detachInventoryItemMedia({ data: { inventoryItemId, mediaObjectId, purpose: 'gallery' } }),
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
          purpose: 'gallery',
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

  const gallery = media.filter((item) => item.purpose === 'gallery');

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-between'>
        <h3 className='text-sm font-medium'>Photos</h3>
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
            {uploadMutation.isPending ? 'Uploading…' : 'Add photo'}
          </Button>
        </div>
      </div>

      {gallery.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.media />
            </EmptyMedia>
            <EmptyTitle>No photos yet</EmptyTitle>
            <EmptyDescription>
              The first photo added becomes the primary listing image.
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
