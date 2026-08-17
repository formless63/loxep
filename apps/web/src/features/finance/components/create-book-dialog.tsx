import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { booksQuery } from '@/features/finance/api/books-queries';
import { createBook } from '@/server/books-functions';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const createBookSchema = z.object({
  code: z.string().trim().min(1, 'Code is required'),
  name: z.string().trim().min(1, 'Name is required'),
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  accountingBasis: z.enum(['accrual', 'cash']),
  fiscalYearStartMonth: z.string().regex(/^(?:[1-9]|1[0-2])$/, 'A month from 1 to 12'),
  fiscalYearStartDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'A day from 1 to 31'),
  requiresEntityDimension: z.boolean()
});

type CreateBookFormValues = z.infer<typeof createBookSchema>;

const accountingBasisOptions = [
  { value: 'accrual', label: 'Accrual' },
  { value: 'cash', label: 'Cash (label only — no cash-basis rule set exists yet)' }
];

/**
 * Creates a book in one step: `createBook` itself composes the code-owned
 * starter chart and the first fiscal year of periods (both default `true`
 * on the service), so this dialog never has to sequence three calls — see
 * `books-functions.ts`'s module doc for why that composition lives in the
 * service and not here.
 */
export default function CreateBookDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: CreateBookFormValues) =>
      createBook({
        data: {
          code: values.code,
          name: values.name,
          openedOn: values.openedOn,
          accountingBasis: values.accountingBasis,
          fiscalYearStartMonth: Number(values.fiscalYearStartMonth),
          fiscalYearStartDay: Number(values.fiscalYearStartDay),
          requiresEntityDimension: values.requiresEntityDimension
        }
      }),
    onSuccess: (result) => {
      toast.success(
        `Book ${result.code} created — ${result.accountCount} accounts, ${result.periodCount} periods`
      );
      void queryClient.invalidateQueries({ queryKey: booksQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to create book')
  });

  const form = useAppForm({
    defaultValues: {
      code: '',
      name: '',
      openedOn: todayIsoDate(),
      accountingBasis: 'accrual',
      fiscalYearStartMonth: '1',
      fiscalYearStartDay: '1',
      requiresEntityDimension: false
    } as CreateBookFormValues,
    validators: { onSubmit: createBookSchema },
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
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New book</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Functional currency is fixed at USD for this build (owner decision, not a limitation of
            the schema — the multi-currency columns already exist on every journal line and sit
            unused). Creating a book also seeds the starter chart of accounts and opens its first
            fiscal year, so it is usable immediately.
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
                name='code'
                children={(field) => (
                  <field.TextField label='Code' required placeholder='e.g. MAIN' />
                )}
              />
              <form.AppField
                name='name'
                children={(field) => (
                  <field.TextField label='Name' required placeholder='e.g. Primary Books' />
                )}
              />
            </div>
            <form.AppField
              name='openedOn'
              children={(field) => <field.TextField label='Opened on' required type='date' />}
            />
            <form.AppField
              name='accountingBasis'
              children={(field) => (
                <field.SelectField
                  label='Accounting basis'
                  required
                  options={accountingBasisOptions}
                  description='Recorded because it changes what a P&L means; no rule set branches on it yet.'
                />
              )}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='fiscalYearStartMonth'
                children={(field) => (
                  <field.TextField
                    label='Fiscal year start month'
                    required
                    inputMode='numeric'
                    placeholder='1'
                  />
                )}
              />
              <form.AppField
                name='fiscalYearStartDay'
                children={(field) => (
                  <field.TextField
                    label='Fiscal year start day'
                    required
                    inputMode='numeric'
                    placeholder='1'
                  />
                )}
              />
            </div>
            <form.AppField
              name='requiresEntityDimension'
              children={(field) => (
                <field.SwitchField
                  label='Requires the entity dimension'
                  description='Turn on only when every posted line will carry an economic entity — an entity-filtered balance sheet is only meaningful when the whole book is dimensioned, not just its P&L.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Create book</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
