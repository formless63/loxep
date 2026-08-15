import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
import { linkExpensePayee } from '@/server/trading-partner-functions';
import { expenseQuery } from '@/features/finance/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import ReceiptGallery from '@/features/finance/components/receipt-gallery';
import ExpenseLinesCard from '@/features/finance/components/expense-lines-card';
import QuickExpenseDialog, {
  type QuickExpensePrefill
} from '@/features/finance/components/quick-expense-dialog';
import {
  NO_TRADING_PARTNER_VALUE,
  PayeeComboboxField
} from '@/features/finance/components/payee-combobox-field';
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

/**
 * "Link this payee" (`expense-entry-design.md` section 2) — operator-driven
 * only, and the ONE field `@loxep/accounting` will change on a `recorded`
 * expense (`ExpensesService.linkPayee`, deliberately bypassing the draft-only
 * lock `update` enforces, the same narrow-bypass posture `reattributeDefaults`
 * already uses for entity attribution). Plain `useState`, not `useAppForm` —
 * this is a single picker plus a submit action with no schema of its own to
 * validate, matching `push-draft-invoice-dialog.tsx`'s own precedent for a
 * one-field selection dialog in this same feature.
 */
function LinkPayeeDialog({
  open,
  onOpenChange,
  expenseId,
  economicEntityId,
  currentPayeeCounterpartyId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  economicEntityId: string | null;
  currentPayeeCounterpartyId: string | null;
}) {
  const queryClient = useQueryClient();
  const [payeeCounterpartyId, setPayeeCounterpartyId] = React.useState(
    currentPayeeCounterpartyId ?? NO_TRADING_PARTNER_VALUE
  );

  React.useEffect(() => {
    if (open) setPayeeCounterpartyId(currentPayeeCounterpartyId ?? NO_TRADING_PARTNER_VALUE);
  }, [open, currentPayeeCounterpartyId]);

  const mutation = useMutation({
    mutationFn: () =>
      linkExpensePayee({
        data: {
          expenseId,
          payeeCounterpartyId:
            payeeCounterpartyId === NO_TRADING_PARTNER_VALUE ? null : payeeCounterpartyId
        }
      }),
    onSuccess: () => {
      toast.success(
        payeeCounterpartyId === NO_TRADING_PARTNER_VALUE ? 'Payee unlinked' : 'Payee linked'
      );
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to link payee')
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>Link this payee</DialogTitle>
          <DialogDescription>
            Attaches a trading partner to this expense without reopening it — works on a recorded
            expense, not just a draft. Unlinking keeps the last-known payee name as evidence.
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-6'>
          <PayeeComboboxField
            label='Payee'
            value={payeeCounterpartyId}
            onChange={setPayeeCounterpartyId}
            economicEntityId={economicEntityId}
          />
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='button' disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Icons.spinner className='animate-spin' />}
              Save
            </Button>
          </div>
        </div>
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
  const [linkPayeeOpen, setLinkPayeeOpen] = React.useState(false);
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
          <DetailRow label='Payee'>
            <span className='flex items-center gap-1.5'>
              {data.payeeCounterpartyDisplayName ?? data.payeeName ?? '—'}
              {data.status !== 'void' && (
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  className='h-5 w-5'
                  title={data.payeeCounterpartyId ? 'Change linked payee' : 'Link this payee'}
                  onClick={() => setLinkPayeeOpen(true)}
                >
                  <Icons.edit className='h-3.5 w-3.5' />
                </Button>
              )}
            </span>
          </DetailRow>
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
            {data.acquisitionId !== null && (
              <>
                {' '}
                <Link
                  to='/inventory/acquisitions/$id'
                  params={{ id: data.acquisitionId }}
                  className='text-primary hover:underline'
                >
                  View the lot
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className='pt-6'>
          <ExpenseLinesCard
            expenseId={expenseId}
            currency={data.currency}
            status={data.status}
            lines={data.lines}
            summary={data.lineSummary}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className='pt-6'>
          <ReceiptGallery expenseId={expenseId} receipts={data.receipts} />
        </CardContent>
      </Card>

      <LinkPayeeDialog
        open={linkPayeeOpen}
        onOpenChange={setLinkPayeeOpen}
        expenseId={expenseId}
        economicEntityId={data.economicEntityId}
        currentPayeeCounterpartyId={data.payeeCounterpartyId}
      />
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
