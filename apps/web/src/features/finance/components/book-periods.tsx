import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { FieldGroup } from '@/components/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatDate } from '@/lib/format';
import { bookDetailQuery } from '@/features/finance/api/books-queries';
import type { FiscalPeriodDto } from '@/server/books-functions';
import { generateFiscalYear, setPeriodStatus } from '@/server/books-functions';

const PERIOD_TONE = {
  open: 'success',
  soft_closed: 'warning',
  closed: 'outline',
  locked: 'secondary'
} as const;

function periodTone(status: string) {
  return PERIOD_TONE[status as keyof typeof PERIOD_TONE] ?? 'outline';
}

function periodLabel(status: string): string {
  return status.replace('_', ' ');
}

const generateYearSchema = z.object({
  fiscalYear: z.string().regex(/^\d{4}$/, 'A four-digit year, e.g. 2026')
});

function GenerateFiscalYearDialog({
  open,
  onOpenChange,
  accountingBookId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (fiscalYear: number) =>
      generateFiscalYear({ data: { accountingBookId, fiscalYear } }),
    onSuccess: (result) => {
      toast.success(
        result.created === 0
          ? 'That fiscal year already had its periods'
          : `${result.created} periods generated`
      );
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(accountingBookId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to generate fiscal year')
  });

  const form = useAppForm({
    defaultValues: { fiscalYear: String(new Date().getUTCFullYear()) },
    validators: { onSubmit: generateYearSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(Number(value.fiscalYear));
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Generate fiscal year</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Twelve monthly periods, anchored on the book&rsquo;s fiscal-year start. Re-running a
            year that already has periods creates nothing — this is idempotent, not additive.
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
              name='fiscalYear'
              children={(field) => (
                <field.TextField
                  label='Fiscal year'
                  required
                  inputMode='numeric'
                  placeholder='2026'
                  description='Labelled by the calendar year the year STARTS in.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Generate</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * Close is consequential — it stops ordinary posting into the period — so
 * this is a confirm dialog rather than an inline button, and it offers the
 * three closing targets `setStatus` accepts rather than hardcoding
 * `soft_closed`. There is deliberately no backdating affordance here: the
 * design records whether `allowBackdated` should be admin-only or member-
 * reachable as an OPEN question (`periods.ts`'s module doc), so this surface
 * only ever calls `setPeriodStatus` without it, which means a soft-closed
 * period simply refuses ordinary posting until reopened.
 */
function ClosePeriodDialog({
  open,
  onOpenChange,
  accountingBookId,
  period
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
  period: FiscalPeriodDto;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = React.useState<'soft_closed' | 'closed' | 'locked'>('soft_closed');

  const mutation = useMutation({
    mutationFn: () => setPeriodStatus({ data: { fiscalPeriodId: period.id, status: target } }),
    onSuccess: () => {
      toast.success(`${period.periodCode} is now ${periodLabel(target)}`);
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(accountingBookId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to close period')
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {period.periodCode}?</AlertDialogTitle>
          <AlertDialogDescription>
            Soft closed blocks ordinary posting but still permits an explicitly authorized backdated
            entry (not offered on this surface). Closed and locked both block every posting; locked
            additionally refuses reopening from the application.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className='flex flex-col gap-1.5'>
          {(['soft_closed', 'closed', 'locked'] as const).map((status) => (
            <label key={status} className='flex items-center gap-2 text-sm'>
              <input
                type='radio'
                name='close-target'
                checked={target === status}
                onChange={() => setTarget(status)}
              />
              {periodLabel(status)}
            </label>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Close period
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReopenPeriodDialog({
  open,
  onOpenChange,
  accountingBookId,
  period
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
  period: FiscalPeriodDto;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => setPeriodStatus({ data: { fiscalPeriodId: period.id, status: 'open' } }),
    onSuccess: () => {
      toast.success(`${period.periodCode} reopened`);
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(accountingBookId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to reopen period')
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reopen {period.periodCode}?</AlertDialogTitle>
          <AlertDialogDescription>
            An explicit, audited action — ordinary posting resumes immediately. Locked periods never
            reach this dialog: no application path reopens one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Reopen period
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function BookPeriods({
  accountingBookId,
  periods
}: {
  accountingBookId: string;
  periods: FiscalPeriodDto[];
}) {
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [closingPeriod, setClosingPeriod] = React.useState<FiscalPeriodDto | null>(null);
  const [reopeningPeriod, setReopeningPeriod] = React.useState<FiscalPeriodDto | null>(null);

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-2'>
        <div>
          <CardTitle>Fiscal periods</CardTitle>
          <CardDescription>
            Periods gate posting; nothing is auto-created on demand. Generate a year at a time, then
            close or reopen individual periods as the calendar moves.
          </CardDescription>
        </div>
        <Button size='sm' onClick={() => setGenerateOpen(true)}>
          <Icons.calendar />
          Generate fiscal year
        </Button>
      </CardHeader>
      <CardContent>
        {periods.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.calendar />
              </EmptyMedia>
              <EmptyTitle>No fiscal periods yet</EmptyTitle>
              <EmptyDescription>
                Generate the book&rsquo;s first fiscal year to open a window postings can land in.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Range</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className='text-right'>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.map((period) => (
                <TableRow key={period.id}>
                  <TableCell className='font-medium'>{period.periodCode}</TableCell>
                  <TableCell className='text-muted-foreground'>
                    {formatDate(period.startsOn)} – {formatDate(period.endsOn)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={periodTone(period.status)}>{periodLabel(period.status)}</Badge>
                  </TableCell>
                  <TableCell className='text-right'>
                    {period.status === 'open' && (
                      <Button size='sm' variant='outline' onClick={() => setClosingPeriod(period)}>
                        Close
                      </Button>
                    )}
                    {(period.status === 'soft_closed' || period.status === 'closed') && (
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => setReopeningPeriod(period)}
                      >
                        Reopen
                      </Button>
                    )}
                    {period.status === 'locked' && (
                      <span className='text-muted-foreground inline-flex items-center gap-1 text-xs'>
                        <Icons.lock />
                        Locked
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <GenerateFiscalYearDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        accountingBookId={accountingBookId}
      />
      {closingPeriod && (
        <ClosePeriodDialog
          open={closingPeriod !== null}
          onOpenChange={(next) => {
            if (!next) setClosingPeriod(null);
          }}
          accountingBookId={accountingBookId}
          period={closingPeriod}
        />
      )}
      {reopeningPeriod && (
        <ReopenPeriodDialog
          open={reopeningPeriod !== null}
          onOpenChange={(next) => {
            if (!next) setReopeningPeriod(null);
          }}
          accountingBookId={accountingBookId}
          period={reopeningPeriod}
        />
      )}
    </Card>
  );
}
