import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileUploader } from '@/components/file-uploader';
import { DocumentPreview, type DocumentPreviewOverlayLine } from '@/components/document-preview';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { formatBytes } from '@/lib/format';
import { toastError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { uploadDocument } from '@/features/documents/api/upload';
import { documentQuery } from '@/features/documents/api/queries';

/**
 * Mirrors `documentsMediaLimitsSetting`'s shipped default
 * (`@loxep/domain/settings-defaults.ts`) — a client-side UX hint only, so
 * `react-dropzone` can reject an obviously-oversized file before spending a
 * round trip. `/api/documents/upload` (`@/server/documents-media.ts`) is the
 * authoritative, operator-configurable check; this constant can drift from
 * it (an operator raising the setting) without breaking anything — the
 * server still enforces its own current value either way.
 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_ATTACHMENT_TYPES: Record<string, string[]> = {
  'image/png': [],
  'image/jpeg': [],
  'image/webp': [],
  'application/pdf': []
};
const MAX_ATTACHMENTS = 20;

export type EvidenceAttachmentStatus = 'uploading' | 'uploaded' | 'error';

export interface EvidenceAttachment {
  /** Client-only identity — stable across the upload's lifetime, never sent to the server. */
  key: string;
  file: File;
  status: EvidenceAttachmentStatus;
  documentId?: string;
  mediaObjectId?: string;
  mimeType?: string | null;
  originalFilename?: string | null;
  sizeBytes?: number;
  servingUrl?: string | null;
  errorMessage?: string;
}

function attachmentStatusIcon(status: EvidenceAttachmentStatus) {
  if (status === 'uploading') return Icons.spinner;
  if (status === 'error') return Icons.circleX;
  return Icons.circleCheck;
}

/**
 * The evidence pane (loxep-cd3.2, M2 — `expense-entry-design.md` section 1).
 * Multi-file drag-and-drop over the SHARED `FileUploader`
 * (`@/components/file-uploader.tsx`, react-dropzone 20.1.0) — the design's
 * explicit rule is that no new dropzone is written, only configured via
 * props (`multiple`, `maxFiles`, `accept`, `maxSize`), never edited in place.
 * `compact` (added loxep-zk5) is one more such prop: once
 * `attachments.length > 0` the dropzone collapses to a slim "Drop or click
 * to add more" strip above the attachment list — the SAME full drag/click/
 * keyboard target, just visually out of the way once it is no longer the
 * only thing on the pane, so the reclaimed height goes to the preview below.
 *

 * Each dropped file posts IMMEDIATELY to the EXISTING
 * `POST /api/documents/upload` (`@/features/documents/api/upload.ts`'s
 * `uploadDocument`) — the same pipeline `/finance/import` uses, entered from
 * the other direction, per the design's "one media object, two references,
 * zero copies" decision. There is no expense yet at drop time, so evidence
 * can land before anything is typed; linking happens once, at save
 * (`createExpenseWithEvidence`, `@/server/expense-functions.ts`).
 *
 * A storage-backend 409 (`StorageBackendError` surfaced by
 * `handleDocumentUpload`) is handled honestly: the real server message is
 * shown inline on the failed attachment, not swallowed into a generic
 * "upload failed". Removing an attachment before save is a client-side
 * decision not to link it, never a delete — the uploaded `documents` row
 * stays `pending` and is reachable through `/finance/import`, exactly like
 * abandoning the whole page (the design's own "nothing is orphaned, nothing
 * is half-confirmed, because nothing was written" rule).
 *
 * **The highlight overlay (loxep-cd3.5, M5).** For the currently-selected,
 * uploaded attachment, this pane polls `fetchDocument` (`documentQuery`,
 * `@/features/documents/api/queries.ts`) — the SAME read `/finance/import`'s
 * review panel uses — while the document's OCR extraction is still running
 * (`status === 'pending'`), and stops once it settles. When the selected
 * document carries candidates with a `sourceRegion` (an `ocr_tesseract` run
 * that found lines; `ocr_tesseract` is the default since the 2026-08-17
 * owner ruling, and the `manual` parser never emits regions), `<DocumentPreview>`
 * renders them as a draggable overlay — this pane is a drag SOURCE only; the
 * drop TARGETS (the form's fields and its "Line items" zone) live on
 * `new-expense-page.tsx`, which supplies `renderLineActions` so each
 * detected line's keyboard/click equivalent can reach fields this pane
 * itself knows nothing about.
 */
export default function EvidencePane({
  attachments,
  onAttachmentsChange,
  renderLineActions,
  hoveredLineId,
  onHoveredLineChange,
  className
}: {
  attachments: EvidenceAttachment[];
  onAttachmentsChange: React.Dispatch<React.SetStateAction<EvidenceAttachment[]>>;
  /** The keyboard/click equivalent per detected line — see `document-preview.tsx`'s own accessibility doc. Omit to render the overlay read-only (no menu, drag still works for a mouse). */
  renderLineActions?: (line: DocumentPreviewOverlayLine) => React.ReactNode;
  hoveredLineId?: string | null;
  onHoveredLineChange?: (id: string | null) => void;
  /** loxep-45k (rule M5): lets the two-pane page toggle this pane's visibility below 768px without unmounting it (state — pending uploads, selection — survives switching panes). */
  className?: string;
}) {
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);

  async function handleUpload(files: File[]) {
    await Promise.all(
      files.map(async (file) => {
        const key = crypto.randomUUID();
        onAttachmentsChange((prev) => [...prev, { key, file, status: 'uploading' }]);
        try {
          const result = await uploadDocument({ file, documentKind: 'receipt' });
          onAttachmentsChange((prev) =>
            prev.map((attachment) =>
              attachment.key === key
                ? {
                    ...attachment,
                    status: 'uploaded' as const,
                    documentId: result.documentId,
                    mediaObjectId: result.mediaObjectId,
                    mimeType: result.mimeType,
                    originalFilename: result.originalFilename,
                    sizeBytes: result.sizeBytes,
                    servingUrl: result.servingUrl
                  }
                : attachment
            )
          );
          setSelectedKey((current) => current ?? key);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to upload';
          onAttachmentsChange((prev) =>
            prev.map((attachment) =>
              attachment.key === key
                ? { ...attachment, status: 'error' as const, errorMessage: message }
                : attachment
            )
          );
          toastError(error, `Could not attach ${file.name}`);
        }
      })
    );
    // Resolves regardless of per-file outcome, so the dropzone's own
    // controlled `pendingFiles` list always clears after a batch — this
    // pane's `attachments` state (lifted to the parent page) is the single
    // source of truth for what is shown below, uploading or not.
  }

  function handleRemove(key: string) {
    onAttachmentsChange((prev) => prev.filter((attachment) => attachment.key !== key));
    setSelectedKey((current) => (current === key ? null : current));
  }

  const selected = attachments.find((attachment) => attachment.key === selectedKey) ?? null;

  // Polls only while extraction is genuinely in flight, keyed on `parsedAt`
  // — NEVER on `status`: a parse that yields zero candidates (a text-layer
  // PDF, a photo Tesseract finds no lines in) deliberately leaves
  // `status = 'pending'`, and keying the poll on status made this an
  // infinite 2s loop over a long-finished document (found live,
  // 2026-08-17). `parsedAt` flips exactly once, when the extraction task
  // records its result, whatever it found. `enabled` guards against firing
  // for an attachment still mid-upload (no `documentId` yet).
  const documentQueryResult = useQuery({
    ...documentQuery(selected?.documentId ?? ''),
    enabled: selected?.documentId !== undefined,
    refetchInterval: (query) =>
      query.state.data !== undefined && query.state.data.parsedAt === null ? 2000 : false
  });
  const selectedDocument =
    selected?.documentId !== undefined ? documentQueryResult.data : undefined;
  const overlayLines: DocumentPreviewOverlayLine[] =
    selectedDocument?.candidates
      .filter((candidate) => candidate.sourceRegion !== null)
      .map((candidate) => ({
        id: candidate.id,
        documentId: candidate.documentId,
        lineNumber: candidate.lineNumber,
        text: candidate.description ?? '',
        region: candidate.sourceRegion as NonNullable<typeof candidate.sourceRegion>
      })) ?? [];

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* One condensed row (owner directive 2026-08-18): the pane title,
          the drop target, and the attached-file chips share a line so every
          reclaimed pixel goes to the preview below. The full guidance
          ("uploads immediately; nothing links until save") lives on the
          chips' own tooltips and the uploader's zero-state copy. */}
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='text-sm font-medium'>Evidence</h2>
        <div className={cn('min-w-40', attachments.length > 0 ? 'flex-none' : 'flex-1')}>
          <FileUploader
            value={pendingFiles}
            onValueChange={setPendingFiles}
            onUpload={handleUpload}
            multiple
            maxFiles={MAX_ATTACHMENTS}
            accept={ACCEPTED_ATTACHMENT_TYPES}
            maxSize={DEFAULT_MAX_ATTACHMENT_BYTES}
            compact={attachments.length > 0}
          />
        </div>
        {attachments.map((attachment) => {
          const StatusIcon = attachmentStatusIcon(attachment.status);
          const isSelected = attachment.key === selectedKey;
          const name = attachment.originalFilename ?? attachment.file.name;
          const detail =
            attachment.status === 'error'
              ? attachment.errorMessage
              : attachment.status === 'uploading'
                ? 'Uploading…'
                : `${formatBytes(attachment.sizeBytes ?? attachment.file.size)} · uploaded — linked to this expense when you save`;
          return (
            <span
              key={attachment.key}
              title={`${name}${detail ? ` — ${detail}` : ''}`}
              className={cn(
                'flex items-center gap-1.5 rounded-md border py-1 pr-1 pl-2 text-xs',
                isSelected && 'border-primary bg-accent'
              )}
            >
              <button
                type='button'
                className='flex min-w-0 items-center gap-1.5 disabled:cursor-default'
                disabled={attachment.status !== 'uploaded'}
                onClick={() => setSelectedKey(attachment.key)}
              >
                <StatusIcon
                  className={cn(
                    'size-3.5 shrink-0',
                    attachment.status === 'uploading' && 'text-muted-foreground animate-spin',
                    attachment.status === 'error' && 'text-destructive',
                    attachment.status === 'uploaded' && 'text-primary'
                  )}
                  aria-hidden='true'
                />
                <span className='max-w-44 truncate font-medium'>{name}</span>
              </button>
              <Button
                type='button'
                variant='ghost'
                size='icon-xs'
                aria-label={`Remove ${name}`}
                onClick={() => handleRemove(attachment.key)}
              >
                <Icons.close className='text-muted-foreground' />
              </Button>
            </span>
          );
        })}
      </div>
      {selected && (
        <DocumentPreview
          mimeType={selected.mimeType ?? null}
          servingUrl={selected.servingUrl ?? null}
          alt={selected.originalFilename ?? selected.file.name}
          // loxep-zk5 follow-up: width alone never made a PDF readable —
          // Chrome fits the page to the iframe's HEIGHT. The pane is now
          // viewport-bound on md+ (`new-expense-page.tsx`), so the preview
          // flex-fills whatever height the dropzone strip and attachment
          // list leave; below md (the stacked mobile toggle) a dvh minimum
          // keeps it tall enough to read.
          className='min-h-[60dvh] md:min-h-0 md:flex-1'
          overlay={
            overlayLines.length > 0
              ? {
                  lines: overlayLines,
                  draggable: true,
                  hoveredId: hoveredLineId,
                  onHoverChange: onHoveredLineChange,
                  renderActions: renderLineActions
                }
              : undefined
          }
        />
      )}
      {selected?.documentId !== undefined &&
        overlayLines.length === 0 &&
        (selectedDocument?.parsedAt == null ? (
          selectedDocument?.status === 'pending' && (
            <p className='text-muted-foreground text-xs'>
              Text extraction runs shortly after upload — detected lines will appear here.
            </p>
          )
        ) : (
          <p className='text-muted-foreground text-xs'>
            Text extracted and searchable — no boxed line items were detected in this file, so there
            is nothing to drag. PDFs with a text layer extract words but not box positions.
          </p>
        ))}
    </div>
  );
}
