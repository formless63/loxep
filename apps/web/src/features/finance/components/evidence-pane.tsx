import * as React from 'react';
import { FileUploader } from '@/components/file-uploader';
import { DocumentPreview } from '@/components/document-preview';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { formatBytes } from '@/lib/format';
import { toastError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { uploadDocument } from '@/features/documents/api/upload';

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
 */
export default function EvidencePane({
  attachments,
  onAttachmentsChange
}: {
  attachments: EvidenceAttachment[];
  onAttachmentsChange: React.Dispatch<React.SetStateAction<EvidenceAttachment[]>>;
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

  return (
    <div className='flex flex-col gap-4'>
      <div>
        <h2 className='text-sm font-medium'>Evidence</h2>
        <p className='text-muted-foreground text-xs'>
          Drop receipts, invoices, or packing slips here, or click to choose. Each file uploads
          immediately; nothing is linked to this expense until you save.
        </p>
      </div>
      <FileUploader
        value={pendingFiles}
        onValueChange={setPendingFiles}
        onUpload={handleUpload}
        multiple
        maxFiles={MAX_ATTACHMENTS}
        accept={ACCEPTED_ATTACHMENT_TYPES}
        maxSize={DEFAULT_MAX_ATTACHMENT_BYTES}
      />
      {attachments.length > 0 && (
        <ul className='flex flex-col gap-1'>
          {attachments.map((attachment) => {
            const StatusIcon = attachmentStatusIcon(attachment.status);
            const isSelected = attachment.key === selectedKey;
            const name = attachment.originalFilename ?? attachment.file.name;
            return (
              <li
                key={attachment.key}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2 text-sm',
                  isSelected && 'border-primary bg-accent'
                )}
              >
                <button
                  type='button'
                  className='flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default'
                  disabled={attachment.status !== 'uploaded'}
                  onClick={() => setSelectedKey(attachment.key)}
                >
                  <StatusIcon
                    className={cn(
                      'size-4 shrink-0',
                      attachment.status === 'uploading' && 'text-muted-foreground animate-spin',
                      attachment.status === 'error' && 'text-destructive',
                      attachment.status === 'uploaded' && 'text-primary'
                    )}
                    aria-hidden='true'
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate font-medium'>{name}</span>
                    {attachment.status === 'error' && (
                      <span className='text-destructive block text-xs'>
                        {attachment.errorMessage}
                      </span>
                    )}
                    {attachment.status === 'uploading' && (
                      <span className='text-muted-foreground block text-xs'>Uploading…</span>
                    )}
                    {attachment.status === 'uploaded' && (
                      <span className='text-muted-foreground block text-xs'>
                        {formatBytes(attachment.sizeBytes ?? attachment.file.size)} · Uploaded
                      </span>
                    )}
                  </span>
                </button>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={`Remove ${name}`}
                  onClick={() => handleRemove(attachment.key)}
                >
                  <Icons.close className='text-muted-foreground' />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {selected && (
        <DocumentPreview
          mimeType={selected.mimeType ?? null}
          servingUrl={selected.servingUrl ?? null}
          alt={selected.originalFilename ?? selected.file.name}
          className='min-h-64'
        />
      )}
    </div>
  );
}
