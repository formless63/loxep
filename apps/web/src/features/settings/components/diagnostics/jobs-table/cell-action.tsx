import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { discardJob, retryJob, type JobDiagnosticRowDto } from '@/server/diagnostics-functions';
import { jobDiagnosticsQuery, jobStatsQuery } from '@/features/settings/api/diagnostics-queries';

/**
 * Retry / Discard — see `@/server/diagnostics-functions`'s module doc for
 * exactly what each does against `graphile_worker`. Discard is destructive
 * (the row disappears for good), so it gets the house `AlertDialog` confirm;
 * Retry is non-destructive (the job simply runs again) and fires directly,
 * matching how `connections-table`'s enable/disable button behaves.
 */
export function CellAction({ data }: { data: JobDiagnosticRowDto }) {
  const queryClient = useQueryClient();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: jobDiagnosticsQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: jobStatsQuery.queryKey });
  };

  const retryMutation = useMutation({
    mutationFn: () => retryJob({ data: { jobId: data.id } }),
    onSuccess: (result) => {
      if (result.retried) {
        toast.success(`Job ${data.id} scheduled to run again`);
      } else {
        toast.error(`Job ${data.id} is locked by a worker right now — try again shortly`);
      }
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to retry job')
  });

  const discardMutation = useMutation({
    mutationFn: () => discardJob({ data: { jobId: data.id } }),
    onSuccess: (result) => {
      setConfirmingDiscard(false);
      if (result.discarded) {
        toast.success(`Job ${data.id} discarded`);
      } else {
        toast.error(`Job ${data.id} is locked by a worker right now — try again shortly`);
      }
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to discard job')
  });

  return (
    <div className='flex items-center justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={retryMutation.isPending}
        onClick={() => retryMutation.mutate()}
      >
        <Icons.refresh />
        Retry
      </Button>
      <Button
        size='sm'
        variant='ghost'
        className='text-destructive hover:text-destructive'
        disabled={discardMutation.isPending}
        onClick={() => setConfirmingDiscard(true)}
      >
        <Icons.trash />
        Discard
      </Button>

      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this job?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the queued job row for{' '}
              <span className='font-mono'>{data.taskIdentifier}</span>. It will not run again unless
              something re-enqueues it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={discardMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                discardMutation.mutate();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
