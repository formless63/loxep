import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatDate, formatMoney } from '@/lib/format';
import {
  promoteExpenseToAcquisitionCost,
  submitExpense,
  updateExpense,
  voidExpense
} from '@/server/expense-functions';
import { linkExpensePayee } from '@/server/trading-partner-functions';
import { expenseQuery } from '@/features/finance/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import ReceiptGallery from '@/features/finance/components/receipt-gallery';
import ExpenseLinesCard from '@/features/finance/components/expense-lines-card';
import ExpenseAllocationsCard from '@/features/finance/components/expense-allocations-card';
import {
  NO_TRADING_PARTNER_VALUE,
  PayeeComboboxField
} from '@/features/finance/components/payee-combobox-field';
import { CategoryComboboxField } from '@/features/finance/components/category-combobox-field';
import {
  expenseStatusLabel,
  expenseStatusTone,
  paymentMethodLabel,
  paymentMethodOptions
} from '@/features/finance/constants';
import AcquisitionLotPickerDialog, {
  type AcquisitionLotTarget
} from '@/features/documents/components/acquisition-lot-picker';

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
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Void {referenceCode}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The row is kept as evidence, never deleted. This is the only correction path — the
            corrected fact is recorded fresh right after.
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
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

const promoteSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required')
});

/**
 * "Promote to acquisition cost" (loxep-ytu; `flipping-lifecycle-design.md`'s
 * open question 2) — the void-and-promote correction path alongside
 * `VoidExpenseDialog`'s plain void-and-re-record above: the operator
 * realizes a recorded expense was really money spent on goods for resale.
 * TWO steps, chained the same way `VoidExpenseDialog`'s own `onVoided` chains
 * onward (that one now navigates to `/finance/expenses/new` post-void, per
 * the OWNER REVERSAL above — this dialog stays in-place instead, since a
 * lot pick + reason is still a dialog-sized action): choosing a lot first
 * (the SAME `AcquisitionLotPickerDialog` the document-review panel uses —
 * create-new or attach-existing, resolving an identity only, no write),
 * THEN this dialog's own reason field, which is what actually submits.
 */
function PromoteToAcquisitionDialog({
  open,
  onOpenChange,
  expenseId,
  referenceCode,
  target,
  onPromoted
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  referenceCode: string;
  target: AcquisitionLotTarget;
  onPromoted: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (reason: string) =>
      promoteExpenseToAcquisitionCost({
        data: { expenseId, reason, acquisitionId: target.id }
      }),
    onSuccess: (result) => {
      toast.success(`${referenceCode} promoted onto ${result.acquisitionReferenceCode}`);
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      onPromoted();
    },
    onError: (error) => toastError(error, 'Failed to promote expense')
  });

  const form = useAppForm({
    defaultValues: { reason: '' },
    validators: { onSubmit: promoteSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value.reason);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Promote {referenceCode} to {target.referenceCode}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Voids this expense and records its value as a capitalized cost on {target.title}. The
            row is kept as evidence, never deleted — this is the acquisition seam's correction path
            for spend that turns out to have bought goods for resale.
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
              name='reason'
              children={(field) => (
                <field.TextareaField
                  label='Reason'
                  required
                  placeholder='e.g. this was actually a lot of goods to resell'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton variant='destructive'>
                Promote to acquisition cost
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
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
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <LinkPayeeContent
          key={`${expenseId}:${currentPayeeCounterpartyId ?? NO_TRADING_PARTNER_VALUE}`}
          onOpenChange={onOpenChange}
          expenseId={expenseId}
          economicEntityId={economicEntityId}
          currentPayeeCounterpartyId={currentPayeeCounterpartyId}
        />
      )}
    </ResponsiveDialog>
  );
}

function LinkPayeeContent({
  onOpenChange,
  expenseId,
  economicEntityId,
  currentPayeeCounterpartyId
}: {
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  economicEntityId: string | null;
  currentPayeeCounterpartyId: string | null;
}) {
  const queryClient = useQueryClient();
  const [payeeCounterpartyId, setPayeeCounterpartyId] = React.useState(
    currentPayeeCounterpartyId ?? NO_TRADING_PARTNER_VALUE
  );

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
    <ResponsiveDialogContent className='sm:max-w-[420px]'>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Link this payee</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          Attaches a trading partner to this expense without reopening it — works on a recorded
          expense, not just a draft. Unlinking keeps the last-known payee name as evidence.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
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
    </ResponsiveDialogContent>
  );
}

const editExpenseSchema = z.object({
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  payeeName: z.string(),
  category: z.string().trim().min(1, 'Category is required'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  taxAmount: z.string().trim(),
  paymentMethod: z.enum([
    'card',
    'cash',
    'bank_transfer',
    'marketplace_balance',
    'direct_debit',
    'other'
  ]),
  notes: z.string()
});

type EditExpenseFormValues = z.infer<typeof editExpenseSchema>;

/**
 * A4 (loxep-wx3) — `ExpensesService.update` had zero callers; "Save as
 * draft" wrote a record the operator could only void. Mounted here rather
 * than reusing `new-expense-page.tsx` in edit mode: that page's evidence
 * pane, drag-to-line-items weave, and pinned-candidate state are all about
 * ORIGINATING an expense from a receipt, none of which applies to editing a
 * few header fields on an already-created draft, and the service's own
 * `update` input is a flat field set with no lines/evidence in it at all —
 * a focused dialog matches the shape of what can actually change. Gated by
 * the caller on `status === 'draft'`, matching the service's own lock.
 */
function EditExpenseDialog({
  open,
  onOpenChange,
  expenseId,
  referenceCode,
  expense
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  referenceCode: string;
  expense: {
    expenseDate: string;
    payeeName: string | null;
    category: string;
    currency: string;
    amount: string;
    taxAmount: string;
    paymentMethod: string;
    notes: string | null;
  };
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: EditExpenseFormValues) =>
      updateExpense({
        data: {
          expenseId,
          expenseDate: values.expenseDate,
          payeeName: values.payeeName.trim() === '' ? null : values.payeeName.trim(),
          category: values.category,
          currency: values.currency.toUpperCase(),
          amount: values.amount,
          taxAmount: values.taxAmount.trim() === '' ? '0' : values.taxAmount.trim(),
          paymentMethod: values.paymentMethod,
          notes: values.notes.trim() === '' ? null : values.notes.trim()
        }
      }),
    onSuccess: () => {
      toast.success(`${referenceCode} updated`);
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to update expense')
  });

  const form = useAppForm({
    defaultValues: {
      expenseDate: expense.expenseDate,
      payeeName: expense.payeeName ?? '',
      category: expense.category,
      currency: expense.currency,
      amount: expense.amount,
      taxAmount: expense.taxAmount,
      paymentMethod: expense.paymentMethod as EditExpenseFormValues['paymentMethod'],
      notes: expense.notes ?? ''
    } as EditExpenseFormValues,
    validators: { onSubmit: editExpenseSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit {referenceCode}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Only a draft can be edited in place — once recorded, the correction path is void-and-
            re-record.
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
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='expenseDate'
                children={(field) => <field.TextField label='Date' required type='date' />}
              />
              <form.AppField
                name='payeeName'
                children={(field) => <field.TextField label='Payee name' placeholder='e.g. USPS' />}
              />
            </div>
            <form.Field name='category'>
              {(field) => (
                <CategoryComboboxField
                  label='Category'
                  name='category'
                  required
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  invalid={field.state.meta.isTouched && !field.state.meta.isValid}
                  errors={field.state.meta.errors}
                />
              )}
            </form.Field>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
              <form.AppField
                name='amount'
                children={(field) => (
                  <field.TextField label='Amount' required inputMode='decimal' placeholder='0.00' />
                )}
              />
              <form.AppField
                name='taxAmount'
                children={(field) => (
                  <field.TextField label='Tax' inputMode='decimal' placeholder='0.00' />
                )}
              />
              <form.AppField
                name='currency'
                children={(field) => (
                  <field.TextField label='Currency' required placeholder='USD' maxLength={3} />
                )}
              />
            </div>
            <form.AppField
              name='paymentMethod'
              children={(field) => (
                <field.SelectField label='Payment' required options={paymentMethodOptions} />
              )}
            />
            <form.AppField
              name='notes'
              children={(field) => <field.TextareaField label='Notes' />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save changes</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
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

export default function ExpenseDetail({
  expenseId,
  q = null
}: {
  expenseId: string;
  /** Forwarded to `fetchExpense` — see `expenseQuery`'s own doc; drives the receipt-gallery snippet only. */
  q?: string | null;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(expenseQuery(expenseId, q));
  const { data: entities } = useQuery(entitiesQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [voidOpen, setVoidOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [linkPayeeOpen, setLinkPayeeOpen] = React.useState(false);
  const [promoteLotPickerOpen, setPromoteLotPickerOpen] = React.useState(false);
  const [promoteTarget, setPromoteTarget] = React.useState<AcquisitionLotTarget | null>(null);
  const [promoteOpen, setPromoteOpen] = React.useState(false);

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
              <>
                <Button size='sm' variant='outline' onClick={() => setEditOpen(true)}>
                  <Icons.edit />
                  Edit
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}
                >
                  Record now
                </Button>
              </>
            )}
            {data.status === 'recorded' && (
              <>
                <Button size='sm' variant='outline' onClick={() => setVoidOpen(true)}>
                  <Icons.circleX />
                  Void &amp; re-record
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    setPromoteTarget(null);
                    setPromoteLotPickerOpen(true);
                  }}
                >
                  <Icons.product />
                  Promote to acquisition
                </Button>
              </>
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
          <AlertTitle>Voided and promoted to a lot's cost</AlertTitle>
          <AlertDescription>
            This expense was voided and its value was re-recorded as a capitalized acquisition cost
            — the acquisition seam's correction path for spend that turned out to have bought goods
            for resale.
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
          <ExpenseAllocationsCard
            expenseId={expenseId}
            status={data.status}
            currency={data.currency}
            amount={data.amount}
            allocatedAmount={data.allocatedAmount}
            unallocatedAmount={data.unallocatedAmount}
            fullyAllocated={data.fullyAllocated}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className='pt-6'>
          <ReceiptGallery expenseId={expenseId} receipts={data.receipts} />
        </CardContent>
      </Card>

      <EditExpenseDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        expenseId={expenseId}
        referenceCode={data.referenceCode}
        expense={{
          expenseDate: data.expenseDate,
          payeeName: data.payeeName,
          category: data.category,
          currency: data.currency,
          amount: data.amount,
          taxAmount: data.taxAmount,
          paymentMethod: data.paymentMethod,
          notes: data.notes
        }}
      />

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
          // Relocated from the quick-entry dialog's prefilled re-open
          // (OWNER REVERSAL, 2026-08-17, `expense-entry-design.md` decision
          // 1) — the void itself is unchanged (this fires from
          // `VoidExpenseDialog`'s own `onSuccess`, i.e. AFTER the void
          // write lands), only WHERE the re-record form lives moves: the
          // page loads this now-voided expense via `reRecordFrom` and seeds
          // itself, instead of a dialog reopening prefilled in place.
          void navigate({
            to: '/finance/expenses/new',
            search: { reRecordFrom: expenseId }
          });
        }}
      />

      <AcquisitionLotPickerDialog
        open={promoteLotPickerOpen}
        onOpenChange={setPromoteLotPickerOpen}
        onSelected={(target) => {
          setPromoteTarget(target);
          setPromoteOpen(true);
        }}
        defaultTitle={data.payeeCounterpartyDisplayName ?? data.payeeName ?? undefined}
        defaultVendorName={data.payeeCounterpartyDisplayName ?? data.payeeName}
        defaultCurrency={data.currency}
      />
      {promoteTarget && (
        <PromoteToAcquisitionDialog
          open={promoteOpen}
          onOpenChange={setPromoteOpen}
          expenseId={expenseId}
          referenceCode={data.referenceCode}
          target={promoteTarget}
          onPromoted={() => {
            setPromoteTarget(null);
          }}
        />
      )}
    </div>
  );
}
