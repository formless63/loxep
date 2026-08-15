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
import { SNIPPET_MATCH_START, SNIPPET_MATCH_STOP, detachReceipt } from '@/server/expense-functions';
import type { ReceiptDto } from '@/server/expense-functions';
import { uploadReceipt } from '@/features/finance/api/receipt-upload';
import { receiptPurposeLabel } from '@/features/finance/constants';

/**
 * Renders a `ts_headline` snippet WITHOUT `dangerouslySetInnerHTML` —
 * `parsed_text` is OCR/PDF text from an operator-uploaded document, so it is
 * untrusted as far as HTML rendering goes. The server wraps each match in
 * `SNIPPET_MATCH_START`/`SNIPPET_MATCH_STOP` (control characters, never
 * `<b>`/`</b>`) instead of asking Postgres for HTML; this function splits on
 * those markers and renders each side as plain React text (escaped by React
 * itself) with a real `<b>` element around the matched span.
 */
function renderSnippet(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const startIndex = rest.indexOf(SNIPPET_MATCH_START);
    if (startIndex === -1) {
      nodes.push(rest);
      return nodes;
    }
    nodes.push(rest.slice(0, startIndex));
    const afterStart = rest.slice(startIndex + SNIPPET_MATCH_START.length);
    const stopIndex = afterStart.indexOf(SNIPPET_MATCH_STOP);
    if (stopIndex === -1) {
      // Malformed (should not happen — every StartSel from ts_headline has a
      // matching StopSel); render the remainder as plain text rather than
      // dropping it.
      nodes.push(afterStart);
      return nodes;
    }
    // eslint-disable-next-line react/no-array-index-key -- a stable order over an immutable server-rendered string; no reordering ever happens.
    nodes.push(<b key={key++}>{afterStart.slice(0, stopIndex)}</b>);
    rest = afterStart.slice(stopIndex + SNIPPET_MATCH_STOP.length);
  }
}

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
                  {/*
                    Design section 5: "Text extracted <date> · N words" plus a
                    matched snippet ONLY when arriving from a search — NEVER
                    the raw parsedText dump (OCR text is ugly and showing it
                    whole invites the operator to trust it as a transcript).
                    `textExtractedAt`/`wordCount` are both null when no
                    `documents` row exists at all (an old-route receipt, or
                    one uploaded before OCR was enabled) — that case renders
                    nothing here, which is the honest "no claim either way".
                  */}
                  {receipt.textExtractedAt !== null && (
                    <p className='text-muted-foreground mt-1 text-xs'>
                      <Icons.post className='mr-1 inline-block size-3 align-text-bottom' />
                      Text extracted {formatDateTime(receipt.textExtractedAt)}
                      {receipt.wordCount !== null ? ` · ${receipt.wordCount} words` : ''}
                    </p>
                  )}
                  {receipt.snippet !== null && (
                    <p className='bg-muted/50 mt-1 rounded px-2 py-1 text-xs italic [&_b]:not-italic [&_b]:font-semibold'>
                      {renderSnippet(receipt.snippet)}
                    </p>
                  )}
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
