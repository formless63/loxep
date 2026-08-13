import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { uploadDocument } from '@/features/documents/api/upload';

/**
 * Receipt/invoice upload — the entry point for the manual-transcription
 * path. Uploading creates the `documents` row immediately (there is nothing
 * to attach it to first); the operator transcribes lines by hand on the
 * review panel `onUploaded` switches to.
 */
export default function ReceiptUploadPanel({
  onUploaded
}: {
  onUploaded: (documentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (file: File) => uploadDocument({ file, documentKind: 'receipt' }),
    onSuccess: (result) => {
      toast.success('Receipt uploaded — transcribe its lines on the review panel');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      onUploaded(result.documentId);
    },
    onError: (error) => toastError(error, 'Failed to upload the document')
  });

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    mutation.mutate(file);
  }

  return (
    <div className='space-y-3'>
      <p className='text-muted-foreground text-sm'>
        A receipt or invoice photo (PNG, JPEG, WEBP, or PDF, up to 10MB). No parser reads it
        automatically this milestone (manual-assisted only) — you transcribe the lines by hand on
        the review panel, side by side with the image.
      </p>
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
        onClick={() => fileInputRef.current?.click()}
        disabled={mutation.isPending}
      >
        <Icons.upload />
        Upload receipt or invoice
      </Button>
      {mutation.isPending && <Badge variant='outline'>Uploading…</Badge>}
    </div>
  );
}
