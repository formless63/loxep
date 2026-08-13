import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatDate, formatMoney } from '@/lib/format';
import { submitExpense, voidExpense } from '@/server/expense-functions';
import { expenseQuery } from '@/features/finance/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import ReceiptGallery from '@/features/finance/components/receipt-gallery';
import QuickExpenseDialog, {
  type QuickExpensePrefill
} from '@/features/finance/components/quick-expense-dialog';
import {
  expenseStatusLabel,
  expenseStatusTone,
  paymentMethodLabel
} from '@/features/finance/constants';

const voidSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required')
});

function VoidExpenseDialog({
  open,
  onOpenChange,
  expenseId,
  referenceCode,
  onVoided
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  referenceCode: string;
  onVoided: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (reason: string) => voidExpense({ data: { expenseId, reason } }),
    onSuccess: () => {
      toast.success(`${referenceCode} voided`);
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      onOpenChange(false);
      onVoided();
    },
    onError: (error) => toastError(error, 'Failed to void expense')
  });

  const form = useAppForm({
    defaultValues: { reason: '' },
    validators: { onSubmit: voidSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value.reason);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>Void {referenceCode}</DialogTitle>
          <DialogDescription>
            The row is kept as evidence, never deleted. This is the only correction path — the
            corrected fact is recorded fresh right after.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField
              name='reason'
              children={(field) => (
                <field.TextareaField
                  label='Reason'
                  required
                  placeholder='e.g. wrong amount entered'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton variant='destructive'>Void expense</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

export default function ExpenseDetail({ expenseId }: { expenseId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(expenseQuery(expenseId));
  const { data: entities } = useQuery(entitiesQuery);
  const queryClient = useQueryClient();

  const [voidOpen, setVoidOpen] = React.useState(false);
  const [reRecordOpen, setReRecordOpen] = React.useState(false);
  const [reRecordPrefill, setReRecordPrefill] = React.useState<QuickExpensePrefill | undefined>(
    undefined
  );

  const submitMutation = useMutation({
    mutationFn: () => submitExpense({ data: { expenseId } }),
    onSuccess: () => {
      toast.success('Expense recorded');
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to record expense')
  });

  if (isPending || entities === undefined) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load expense' onRetry={() => refetch()} />
    );
  }

  const entityName =
    data.economicEntityId === null
      ? 'Unattributed'
      : (entities.find((entity) => entity.id === data.economicEntityId)?.name ??
        data.economicEntityId);

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='flex items-center gap-2 text-xl'>
              {data.referenceCode}
              <Badge variant={expenseStatusTone(data.status)}>
                {data.status === 'recorded' && <Icons.lock />}
                {expenseStatusLabel(data.status)}
              </Badge>
            </CardTitle>
          </div>
          <div className='flex gap-2'>
            {data.status === 'draft' && (
              <Button
                size='sm'
                variant='outline'
                disabled={submitMutation.isPending}
                onClick={() => submitMutation.mutate()}
              >
                Record now
              </Button>
            )}
            {data.status === 'recorded' && (
              <Button size='sm' variant='outline' onClick={() => setVoidOpen(true)}>
                <Icons.circleX />
                Void &amp; re-record
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-3'>
          <DetailRow label='Amount'>
            <span className='font-medium tabular-nums'>
              {formatMoney(data.amount, data.currency)}
            </span>
          </DetailRow>
          <DetailRow label='Date'>{formatDate(data.expenseDate)}</DetailRow>
          <DetailRow label='Category'>
            <Badge variant='outline'>{data.category}</Badge>
          </DetailRow>
          <DetailRow label='Payee'>{data.payeeName ?? '—'}</DetailRow>
          <DetailRow label='Payment'>{paymentMethodLabel(data.paymentMethod)}</DetailRow>
          <DetailRow label='Entity'>{entityName}</DetailRow>
          <DetailRow label='Tax amount'>{formatMoney(data.taxAmount, data.currency)}</DetailRow>
          <DetailRow label='Allocated'>
            {formatMoney(data.allocatedAmount, data.currency)}
            {!data.fullyAllocated && (
              <span className='text-muted-foreground'>
                {' '}
                ({formatMoney(data.unallocatedAmount, data.currency)} unallocated)
              </span>
            )}
          </DetailRow>
          {data.notes && <DetailRow label='Notes'>{data.notes}</DetailRow>}
        </CardContent>
      </Card>

      {data.acquisitionCostId !== null && (
        <Alert>
          <Icons.info />
          <AlertTitle>Linked to a lot's cost</AlertTitle>
          <AlertDescription>
            This expense carries an <code>acquisition_cost_id</code>. Promoting spend to an
            acquisition (goods bought for resale become cost basis, never an expense) is the
            acquisition seam — the /inventory workspace's intake flow, arriving in a later
            milestone.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className='pt-6'>
          <ReceiptGallery expenseId={expenseId} receipts={data.receipts} />
        </CardContent>
      </Card>

      <VoidExpenseDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        expenseId={expenseId}
        referenceCode={data.referenceCode}
        onVoided={() => {
          setReRecordPrefill({
            amount: data.amount,
            category: data.category,
            payeeName: data.payeeName,
            paymentMethod: data.paymentMethod,
            currency: data.currency,
            economicEntityId: data.economicEntityId,
            correctingReferenceCode: data.referenceCode
          });
          setReRecordOpen(true);
        }}
      />
      {reRecordOpen && (
        <QuickExpenseDialog
          open={reRecordOpen}
          onOpenChange={setReRecordOpen}
          entities={entities}
          prefill={reRecordPrefill}
        />
      )}
    </div>
  );
}
