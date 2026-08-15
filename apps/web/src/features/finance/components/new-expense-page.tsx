import * as React from 'react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { createExpenseWithEvidence } from '@/server/expense-functions';
import { entitiesQuery } from '@/features/settings/api/queries';
import EvidencePane, { type EvidenceAttachment } from '@/features/finance/components/evidence-pane';
import {
  NO_TRADING_PARTNER_VALUE,
  PayeeComboboxField
} from '@/features/finance/components/payee-combobox-field';
import {
  paymentMethodOptions,
  SUGGESTED_EXPENSE_CATEGORIES,
  UNATTRIBUTED_ENTITY_VALUE
} from '@/features/finance/constants';

const DEFAULT_CURRENCY = 'USD';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const newExpenseSchema = z.object({
  payeeName: z.string(),
  payeeCounterpartyId: z.string(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  taxAmount: z.string().trim(),
  category: z.string().trim().min(1, 'Category is required'),
  paymentMethod: z.enum([
    'card',
    'cash',
    'bank_transfer',
    'marketplace_balance',
    'direct_debit',
    'other'
  ]),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  economicEntityId: z.string(),
  notes: z.string()
});

type NewExpenseFormValues = z.infer<typeof newExpenseSchema>;

export interface NewExpensePrefill {
  amount?: string;
  expenseDate?: string;
  category?: string;
  payeeName?: string;
  paymentMethod?: string;
  currency?: string;
  economicEntityId?: string;
}

/**
 * `/finance/expenses/new`'s two-pane body (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1's layout diagram): the entry form on
 * the left, the evidence pane on the right, side by side on desktop and
 * stacked (form first) below `md` — never a modal, never a tab, never a
 * separate route, because the whole point is that the receipt and the
 * fields are visible at once.
 *
 * `useAppForm` only, per Frontend Standards — no raw `<Input>` + `useState`.
 * "Save as draft" and "Record expense" are two DISTINCT buttons (the
 * design's own mockup), not a toggle field: each sets the intended status
 * then submits, rather than one submit whose meaning depends on a switch the
 * operator might not notice.
 *
 * **The payee seam (M1, landing concurrently as loxep-cd3.1):**
 * `expense-entry-design.md` section 2 designs a counterparty combobox with
 * inline "+ New trading partner" create. `createExpenseWithEvidence` already
 * accepts an optional `payeeCounterpartyId` (mirroring `createExpense`'s own
 * quick-entry field, `@/server/expense-functions.ts`) — "both are written,
 * always" per the design, so once a picker exists here it needs no server
 * change, only a value to pass. As of this milestone no picker COMPONENT
 * exists yet under `apps/web/src` to mount (only `@/server/
 * trading-partner-functions.ts`'s server functions do), so this field stays
 * a plain text input writing `payeeName` only, exactly like the quick-entry
 * dialog's own Payee field — free text alone stays valid per the design ("a
 * thrift-store receipt from a shop with no name is a real expense"). Swap
 * this `field.TextField` for the picker component when it lands, wiring its
 * resolved id into the `payeeCounterpartyId` the mutation already sends as
 * `null`; no other change on this page should be required.
 */
export default function NewExpensePage({ prefill }: { prefill?: NewExpensePrefill }) {
  const { data: entities } = useSuspenseQuery(entitiesQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [attachments, setAttachments] = React.useState<EvidenceAttachment[]>([]);

  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...entities.map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  const mutation = useMutation({
    mutationFn: (input: { values: NewExpenseFormValues; status: 'draft' | 'recorded' }) => {
      const mediaObjectIds = attachments
        .filter((attachment) => attachment.status === 'uploaded' && attachment.mediaObjectId)
        .map((attachment) => attachment.mediaObjectId as string);
      const { values } = input;
      return createExpenseWithEvidence({
        data: {
          amount: values.amount,
          taxAmount: values.taxAmount.trim() === '' ? null : values.taxAmount.trim(),
          expenseDate: values.expenseDate,
          category: values.category,
          payeeName: values.payeeName.trim() === '' ? null : values.payeeName.trim(),
          payeeCounterpartyId:
            values.payeeCounterpartyId === NO_TRADING_PARTNER_VALUE
              ? null
              : values.payeeCounterpartyId,
          paymentMethod: values.paymentMethod,
          currency: values.currency.toUpperCase(),
          economicEntityId:
            values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : values.economicEntityId,
          status: input.status,
          notes: values.notes.trim() === '' ? null : values.notes.trim(),
          mediaObjectIds
        }
      });
    },
    onSuccess: (result) => {
      toast.success(
        result.attachedCount > 0
          ? `Expense ${result.referenceCode} recorded with ${result.attachedCount} attachment(s)`
          : `Expense ${result.referenceCode} recorded`
      );
      // Prefix-matches every finance query key (list, detail, reports) — same
      // invalidation `QuickExpenseDialog` uses.
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      void navigate({ to: '/finance/expenses/$id', params: { id: result.id } });
    },
    onError: (error) => toastError(error, 'Failed to record expense')
  });

  // "Save as draft" and "Record expense" are two distinct submit intents,
  // not a switch field — TanStack Form's `onSubmitMeta`/`handleSubmit(meta)`
  // is the sanctioned mechanism for exactly this ("which button" without a
  // parallel manual-validation path): each button passes its own status as
  // submit meta, and the form's normal validate-then-call-onSubmit lifecycle
  // (including `isSubmitting`) runs unchanged either way.
  const form = useAppForm({
    defaultValues: {
      payeeName: prefill?.payeeName ?? '',
      payeeCounterpartyId: NO_TRADING_PARTNER_VALUE,
      expenseDate: prefill?.expenseDate ?? todayIsoDate(),
      amount: prefill?.amount ?? '',
      taxAmount: '',
      category: prefill?.category ?? '',
      paymentMethod: (prefill?.paymentMethod as NewExpenseFormValues['paymentMethod']) ?? 'card',
      currency: prefill?.currency ?? DEFAULT_CURRENCY,
      economicEntityId: prefill?.economicEntityId ?? UNATTRIBUTED_ENTITY_VALUE,
      notes: ''
    } as NewExpenseFormValues,
    onSubmitMeta: { status: 'recorded' as 'draft' | 'recorded' },
    validators: { onSubmit: newExpenseSchema },
    onSubmit: async ({ value, meta }) => {
      try {
        await mutation.mutateAsync({ values: value, status: meta.status });
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_360px]'>
      <Card>
        <CardContent className='pt-6'>
          <form
            className='space-y-6'
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit({ status: 'recorded' });
            }}
          >
            <FieldGroup>
              <form.Field name='payeeCounterpartyId'>
                {(field) => (
                  <PayeeComboboxField
                    label='Payee'
                    name='payeeCounterpartyId'
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    invalid={field.state.meta.isTouched && !field.state.meta.isValid}
                    errors={field.state.meta.errors}
                    economicEntityId={
                      form.state.values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE
                        ? null
                        : form.state.values.economicEntityId
                    }
                    onPayeeSelected={(payee) =>
                      form.setFieldValue(
                        'payeeName',
                        payee?.displayName ?? form.state.values.payeeName
                      )
                    }
                    description='Trading partners (vendor/payee roles) rank first. Empty selection writes the name below alone.'
                  />
                )}
              </form.Field>
              <form.AppField
                name='payeeName'
                children={(field) => (
                  <field.TextField
                    label='Payee name'
                    placeholder='e.g. USPS'
                    description='Free text stays valid — a name-less receipt is a real expense.'
                  />
                )}
              />
              <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                <form.AppField
                  name='expenseDate'
                  children={(field) => <field.TextField label='Date' required type='date' />}
                />
                <form.AppField
                  name='amount'
                  children={(field) => (
                    <field.TextField
                      label='Amount'
                      required
                      inputMode='decimal'
                      placeholder='0.00'
                    />
                  )}
                />
              </div>
              <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                <form.AppField
                  name='taxAmount'
                  children={(field) => (
                    <field.TextField label='Tax' inputMode='decimal' placeholder='0.00' />
                  )}
                />
                <form.AppField
                  name='category'
                  children={(field) => (
                    <div>
                      <field.TextField
                        label='Category'
                        required
                        list='new-expense-category-suggestions'
                        placeholder='e.g. shipping_supplies'
                        description='Your own vocabulary — an open set, not a fixed list.'
                      />
                      <datalist id='new-expense-category-suggestions'>
                        {SUGGESTED_EXPENSE_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </datalist>
                    </div>
                  )}
                />
              </div>
              <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                <form.AppField
                  name='paymentMethod'
                  children={(field) => (
                    <field.SelectField label='Payment' required options={paymentMethodOptions} />
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
                name='economicEntityId'
                children={(field) => (
                  <field.SelectField
                    label='Entity'
                    options={entityOptions}
                    description='Empty selection means Unattributed — a deliberate choice, not an omission.'
                  />
                )}
              />
              <form.AppField
                name='notes'
                children={(field) => <field.TextareaField label='Notes' />}
              />
            </FieldGroup>
            <div className='flex justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                disabled={mutation.isPending}
                onClick={() => void form.handleSubmit({ status: 'draft' })}
              >
                Save as draft
              </Button>
              <Button type='submit' disabled={mutation.isPending}>
                Record expense
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <EvidencePane attachments={attachments} onAttachmentsChange={setAttachments} />
    </div>
  );
}
