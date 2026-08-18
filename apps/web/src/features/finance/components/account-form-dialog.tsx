import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { ledgerAccountsQuery } from '@/features/finance/api/books-queries';
import {
  createLedgerAccount,
  updateLedgerAccount,
  type LedgerAccountDto
} from '@/server/ledger-accounts-functions';
import { ledgerAccountTypeOptions } from '@/features/finance/constants';

const NO_PARENT_VALUE = '__no_parent__';

const accountFormSchema = z.object({
  code: z.string().trim().min(1, 'Code is required'),
  name: z.string().trim().min(1, 'Name is required'),
  accountType: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  parentAccountId: z.string(),
  isPostable: z.boolean(),
  isContra: z.boolean(),
  description: z.string()
});

type AccountFormValues = z.infer<typeof accountFormSchema>;

/**
 * Create/edit dialog for `AccountsService` (loxep-l49). `accountType` and
 * `systemKey` are never editable here — the service refuses both on
 * `updateAccount` and `systemKey` is never accepted on `createAccount`
 * either (see `ledger-accounts-functions.ts`'s module doc): an
 * operator-created account is always plain.
 */
export default function AccountFormDialog({
  open,
  onOpenChange,
  accountingBookId,
  accounts,
  account
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
  accounts: LedgerAccountDto[];
  account: LedgerAccountDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = account !== null;

  const parentOptions = [
    { value: NO_PARENT_VALUE, label: 'No parent' },
    ...accounts
      .filter((candidate) => candidate.id !== account?.id)
      .map((candidate) => ({ value: candidate.id, label: `${candidate.code} — ${candidate.name}` }))
  ];

  const mutation = useMutation({
    mutationFn: async (values: AccountFormValues) => {
      const parentAccountId =
        values.parentAccountId === NO_PARENT_VALUE ? null : values.parentAccountId;
      const description = values.description.trim() === '' ? null : values.description.trim();
      if (isEdit) {
        return updateLedgerAccount({
          data: {
            ledgerAccountId: account.id,
            code: values.code,
            name: values.name,
            parentAccountId,
            isPostable: values.isPostable,
            description
          }
        });
      }
      return createLedgerAccount({
        data: {
          accountingBookId,
          code: values.code,
          name: values.name,
          accountType: values.accountType,
          parentAccountId,
          isPostable: values.isPostable,
          isContra: values.isContra,
          description
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Account updated' : 'Account created');
      void queryClient.invalidateQueries({
        queryKey: ledgerAccountsQuery(accountingBookId).queryKey
      });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save account')
  });

  const form = useAppForm({
    defaultValues: {
      code: account?.code ?? '',
      name: account?.name ?? '',
      accountType: account?.accountType ?? 'asset',
      parentAccountId: account?.parentAccountId ?? NO_PARENT_VALUE,
      isPostable: account?.isPostable ?? true,
      isContra: account?.isContra ?? false,
      description: account?.description ?? ''
    } as AccountFormValues,
    validators: {
      onSubmit: accountFormSchema
    },
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
          <ResponsiveDialogTitle>{isEdit ? 'Edit account' : 'Add account'}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {isEdit
              ? 'Code, name, description, and parent may change freely, including on system accounts. Type and system key never do.'
              : 'A plain account — never carries a system key, so no shipped posting rule resolves through it.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='code'
              children={(field) => (
                <field.TextField label='Code' required placeholder='e.g. 1210' />
              )}
            />
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Accounts Receivable' />
              )}
            />
            {!isEdit && (
              <form.AppField
                name='accountType'
                children={(field) => (
                  <field.SelectField label='Type' required options={ledgerAccountTypeOptions} />
                )}
              />
            )}
            <form.AppField
              name='parentAccountId'
              children={(field) => (
                <field.SelectField label='Parent account' options={parentOptions} />
              )}
            />
            <form.AppField
              name='isPostable'
              children={(field) => (
                <field.SwitchField
                  label='Postable'
                  description='Off marks a roll-up header — a line may never post directly against it.'
                />
              )}
            />
            {!isEdit && (
              <form.AppField
                name='isContra'
                children={(field) => (
                  <field.SwitchField
                    label='Contra'
                    description='Flips the normal balance side (e.g. accumulated depreciation).'
                  />
                )}
              />
            )}
            <form.AppField
              name='description'
              children={(field) => (
                <field.TextareaField label='Description' placeholder='Optional' />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>{isEdit ? 'Save changes' : 'Add account'}</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
