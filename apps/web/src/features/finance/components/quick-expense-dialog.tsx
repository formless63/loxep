import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { createExpense } from '@/server/expense-functions';
import type { EntityDto } from '@/server/admin-functions';
import { uploadReceipt } from '@/features/finance/api/receipt-upload';
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

const quickExpenseSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  category: z.string().trim().min(1, 'Category is required'),
  payeeName: z.string(),
  /** `NO_TRADING_PARTNER_VALUE` ('') means free-text-only, per the picker's own contract. */
  payeeCounterpartyId: z.string(),
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
  saveAsDraft: z.boolean()
});

type QuickExpenseFormValues = z.infer<typeof quickExpenseSchema>;

export interface QuickExpensePrefill {
  amount?: string;
  category?: string;
  payeeName?: string | null;
  paymentMethod?: string;
  currency?: string;
  economicEntityId?: string | null;
  /** When re-recording after a void, shown in the dialog's description. */
  correctingReferenceCode?: string;
}

/**
 * One-screen quick entry (loxep-dgf.1): writes `status: 'recorded'` in one
 * action by default — `draft` stays reachable via "Save as draft" for the
 * deliberate "finish this later" case (the design's own distinction).
 *
 * The entity field's empty selection is "Unattributed"
 * (`UNATTRIBUTED_ENTITY_VALUE`), submitted as an EXPLICIT
 * `economicEntityId: null` — never omitted — so it can never be confused
 * with the installation-default rung (`resolveExpenseAttribution`,
 * `@loxep/accounting/attribution.ts`). That third rung has no registered
 * application setting to resolve it from in this milestone (a documented
 * gap), so this dialog only ever produces `manual` or `unattributed`.
 *
 * A photo is optional and uploads AFTER the expense is created (there is no
 * expense id to attach to before that) — presented as one UI action even
 * though it is two network calls under the hood, matching the design's
 * "photo optional … -> receipt link" quick-entry field.
 */
export default function QuickExpenseDialog({
  open,
  onOpenChange,
  entities,
  prefill
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entities: EntityDto[];
  prefill?: QuickExpensePrefill;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);

  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...entities.map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  const mutation = useMutation({
    mutationFn: async (values: QuickExpenseFormValues) => {
      const result = await createExpense({
        data: {
          amount: values.amount,
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
          status: values.saveAsDraft ? 'draft' : 'recorded'
        }
      });
      if (file) {
        try {
          await uploadReceipt({ file, expenseId: result.id });
        } catch (error) {
          // The expense itself was recorded successfully — a failed receipt
          // upload is reported but must not roll back or mask that.
          toastError(error, 'Expense recorded, but the receipt upload failed');
        }
      }
      return result;
    },
    onSuccess: (result) => {
      toast.success(`Expense ${result.referenceCode} recorded`);
      // Prefix-matches every finance query key (list, detail, reports).
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      setFile(null);
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to record expense')
  });

  const form = useAppForm({
    defaultValues: {
      amount: prefill?.amount ?? '',
      expenseDate: todayIsoDate(),
      category: prefill?.category ?? '',
      payeeName: prefill?.payeeName ?? '',
      payeeCounterpartyId: NO_TRADING_PARTNER_VALUE,
      paymentMethod: (prefill?.paymentMethod as QuickExpenseFormValues['paymentMethod']) ?? 'card',
      currency: prefill?.currency ?? DEFAULT_CURRENCY,
      economicEntityId: prefill?.economicEntityId ?? UNATTRIBUTED_ENTITY_VALUE,
      saveAsDraft: false
    } as QuickExpenseFormValues,
    validators: { onSubmit: quickExpenseSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  /**
   * The dialog's one growth point (`expense-entry-design.md` section 1):
   * "The dialog is capture. The page is composition. They write the same
   * records through the same service, and the dialog never grows a second
   * column." Everything already typed here rides along as search params so
   * an operator who starts fast and discovers the receipt has fourteen
   * lines is not retyping — `/finance/expenses/new` reads these as its own
   * form prefill.
   */
  function handleMoreOptions() {
    const values = form.state.values;
    onOpenChange(false);
    void navigate({
      to: '/finance/expenses/new',
      search: {
        amount: values.amount.trim() === '' ? undefined : values.amount,
        category: values.category.trim() === '' ? undefined : values.category,
        payeeName: values.payeeName.trim() === '' ? undefined : values.payeeName,
        paymentMethod: values.paymentMethod,
        currency: values.currency,
        economicEntityId:
          values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE
            ? undefined
            : values.economicEntityId
      }
    });
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    setFile(selected);
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFile(null);
        onOpenChange(next);
      }}
    >
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {prefill?.correctingReferenceCode ? 'Record corrected expense' : 'New expense'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {prefill?.correctingReferenceCode
              ? `Correcting ${prefill.correctingReferenceCode}, which was just voided — the voided row stays as evidence.`
              : 'Amount is the only field that cannot be defaulted. Saving records the spend immediately; a recorded expense is locked and corrected by voiding it, never edited.'}
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
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='amount'
                children={(field) => (
                  <field.TextField label='Amount' required inputMode='decimal' placeholder='0.00' />
                )}
              />
              <form.AppField
                name='expenseDate'
                children={(field) => <field.TextField label='Date' required type='date' />}
              />
            </div>
            <form.AppField
              name='category'
              children={(field) => (
                <div>
                  <field.TextField
                    label='Category'
                    required
                    list='expense-category-suggestions'
                    placeholder='e.g. shipping_supplies'
                    description='Your own vocabulary — an open set, not a fixed list.'
                  />
                  <datalist id='expense-category-suggestions'>
                    {SUGGESTED_EXPENSE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </datalist>
                </div>
              )}
            />
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
                  label='Payee (free text)'
                  placeholder='e.g. USPS'
                  description='Always saved — picking a trading partner above fills this in, but you can still edit or type it directly.'
                />
              )}
            />
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
              name='saveAsDraft'
              children={(field) => (
                <field.SwitchField
                  label='Save as draft'
                  description='Draft stays editable; leave off to record the spend immediately (locked, correctable only by voiding).'
                />
              )}
            />
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
                onClick={() => fileInputRef.current?.click()}
              >
                <Icons.upload />
                {file ? 'Change receipt photo' : 'Attach receipt (optional)'}
              </Button>
              {file && (
                <Badge variant='secondary' className='ml-2'>
                  {file.name}
                </Badge>
              )}
            </div>
          </FieldGroup>
          <div className='flex items-center justify-between gap-2'>
            <Button
              type='button'
              variant='link'
              size='sm'
              className='px-0'
              onClick={handleMoreOptions}
            >
              More options
            </Button>
            <div className='flex gap-2'>
              <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <form.AppForm>
                <form.SubmitButton>Save</form.SubmitButton>
              </form.AppForm>
            </div>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
