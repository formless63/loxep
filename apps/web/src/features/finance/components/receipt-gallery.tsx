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
import { detachReceipt } from '@/server/expense-functions';
import type { ReceiptDto } from '@/server/expense-functions';
import { uploadReceipt } from '@/features/finance/api/receipt-upload';
import { receiptPurposeLabel } from '@/features/finance/constants';

function purposeIcon(mimeType: string | null) {
  if (mimeType === 'application/pdf') return Icons.fileTypePdf;
  return Icons.media;
}

/**
 * Attached receipts/invoices/supporting documents for one expense
 * (loxep-dgf.1) — `media_links` rows over `@loxep/accounting`'s
 * `ReceiptsService`. One media object can cover several resources (Phase 5's
 * own "a receipt photo covers a lot AND each item unpacked from it" case),
 * so detaching here only removes THIS expense's link, never the object.
 */
export default function ReceiptGallery({
  expenseId,
  receipts
}: {
  expenseId: string;
  receipts: ReceiptDto[];
}) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadReceipt({ file, expenseId }),
    onSuccess: () => {
      toast.success('Receipt attached');
      void queryClient.invalidateQueries({ queryKey: ['finance', 'expense', expenseId] });
    },
    onError: (error) => toastError(error, 'Failed to upload receipt')
  });

  const detachMutation = useMutation({
    mutationFn: (input: { mediaObjectId: string; purpose: ReceiptDto['purpose'] }) =>
      detachReceipt({
        data: {
          expenseId,
          mediaObjectId: input.mediaObjectId,
          purpose: input.purpose as 'receipt' | 'invoice' | 'supporting_document'
        }
      }),
    onSuccess: () => {
      toast.success('Receipt removed');
      void queryClient.invalidateQueries({ queryKey: ['finance', 'expense', expenseId] });
    },
    onError: (error) => toastError(error, 'Failed to remove receipt')
  });

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    uploadMutation.mutate(file);
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-between'>
        <h3 className='text-sm font-medium'>Receipts</h3>
        <div>
          <input
            ref={fileInputRef}
            type='file'
            accept='image/png,image/jpeg,image/webp,application/pdf'
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
            {uploadMutation.isPending ? 'Uploading…' : 'Add receipt'}
          </Button>
        </div>
      </div>

      {receipts.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.fees />
            </EmptyMedia>
            <EmptyTitle>No receipts attached</EmptyTitle>
            <EmptyDescription>
              Attach a photo or PDF of the receipt, invoice, or supporting document.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {receipts.map((receipt) => {
            const Icon = purposeIcon(receipt.mimeType);
            return (
              <li
                key={receipt.mediaObjectId}
                className='flex items-center gap-3 rounded-lg border p-3'
              >
                <Icon className='text-muted-foreground size-8 shrink-0' />
                <div className='min-w-0 flex-1'>
                  {receipt.servingUrl === null ? (
                    <span className='block truncate text-sm font-medium'>
                      {receipt.originalFilename ?? receipt.mediaObjectId}
                    </span>
                  ) : (
                    <a
                      href={receipt.servingUrl}
                      target='_blank'
                      rel='noreferrer'
                      className='block truncate text-sm font-medium hover:underline'
                    >
                      {receipt.originalFilename ?? receipt.mediaObjectId}
                    </a>
                  )}
                  <div className='text-muted-foreground flex flex-wrap items-center gap-1 text-xs'>
                    <Badge variant='outline'>{receiptPurposeLabel(receipt.purpose)}</Badge>
                    <span>{formatBytes(receipt.sizeBytes)}</span>
                    <span>·</span>
                    <span>{formatDateTime(receipt.createdAt)}</span>
                  </div>
                </div>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label='Remove receipt'
                  disabled={detachMutation.isPending}
                  onClick={() =>
                    detachMutation.mutate({
                      mediaObjectId: receipt.mediaObjectId,
                      purpose: receipt.purpose
                    })
                  }
                >
                  <Icons.trash />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
