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
import { partnersQuery } from '@/features/finance/api/partners-queries';
import { createPartner, updatePartner, type PartnerListItemDto } from '@/server/partners-functions';
import {
  partnerKindOptions,
  partnerRoleOptions,
  partnerStatusOptions
} from '@/features/finance/constants';

const partnerFormSchema = z.object({
  kind: z.enum(['person', 'organization']),
  displayName: z.string().trim().min(1, 'Name is required'),
  legalName: z.string(),
  status: z.enum(['active', 'inactive', 'archived']),
  defaultCurrency: z.string().refine((value) => value === '' || /^[A-Za-z]{3}$/.test(value), {
    message: 'Expected an ISO-4217 alphabetic code, e.g. USD'
  }),
  notes: z.string(),
  roles: z.array(
    z.enum([
      'customer',
      'vendor',
      'payer',
      'payee',
      'consignor',
      'subcontractor',
      'partner',
      'other'
    ])
  )
});

type PartnerFormValues = z.infer<typeof partnerFormSchema>;

/**
 * Create/edit dialog for `@loxep/counterparties`' `CounterpartiesService`
 * (loxep-l49) — the same fields the payee combobox's inline "+ New trading
 * partner" create writes, plus every field `create`/`update` accept, plus
 * installation-wide role management (see `partners-functions.ts`'s doc on
 * the scope that covers).
 *
 * `taxIdentifierKind`/`taxIdentifier` are deliberately NOT exposed here: the
 * service enforces they may only be set on an `organization` and are
 * recorded together or not at all, and this dialog's own field set already
 * covers the identity/status/roles an ordinary trading-partner record needs
 * — a tax identifier is edge-case enough on this surface that adding its
 * conditional field logic here was left out rather than half-built.
 */
export default function PartnerFormDialog({
  open,
  onOpenChange,
  partner
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partner: PartnerListItemDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = partner !== null;

  const mutation = useMutation({
    mutationFn: async (values: PartnerFormValues) => {
      const legalName = values.legalName.trim() === '' ? null : values.legalName.trim();
      const defaultCurrency =
        values.defaultCurrency.trim() === '' ? null : values.defaultCurrency.trim();
      const notes = values.notes.trim() === '' ? null : values.notes.trim();
      if (isEdit) {
        return updatePartner({
          data: {
            counterpartyId: partner.id,
            displayName: values.displayName,
            legalName,
            status: values.status,
            defaultCurrency,
            notes,
            roles: values.roles
          }
        });
      }
      return createPartner({
        data: {
          kind: values.kind,
          displayName: values.displayName,
          legalName,
          defaultCurrency,
          notes,
          roles: values.roles
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Trading partner updated' : 'Trading partner created');
      void queryClient.invalidateQueries({ queryKey: partnersQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save trading partner')
  });

  const form = useAppForm({
    defaultValues: {
      kind: partner?.kind ?? 'organization',
      displayName: partner?.displayName ?? '',
      legalName: partner?.legalName ?? '',
      status: partner?.status ?? 'active',
      defaultCurrency: partner?.defaultCurrency ?? '',
      notes: '',
      roles: partner?.roles ?? []
    } as PartnerFormValues,
    validators: {
      onSubmit: partnerFormSchema
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
      <ResponsiveDialogContent className='sm:max-w-[520px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {isEdit ? 'Edit trading partner' : 'New trading partner'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            An outside party Loxep does business with — a customer, vendor, or other counterparty.
            Never one of Loxep&rsquo;s own economic entities.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            {!isEdit && (
              <form.AppField
                name='kind'
                children={(field) => (
                  <field.SelectField
                    label='Kind'
                    required
                    options={partnerKindOptions}
                    placeholder='Select kind'
                  />
                )}
              />
            )}
            <form.AppField
              name='displayName'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Northgate Supply Co.' />
              )}
            />
            <form.AppField
              name='legalName'
              children={(field) => (
                <field.TextField label='Legal name' placeholder='Optional registered legal name' />
              )}
            />
            {isEdit && (
              <form.AppField
                name='status'
                children={(field) => (
                  <field.SelectField label='Status' required options={partnerStatusOptions} />
                )}
              />
            )}
            <form.AppField
              name='defaultCurrency'
              children={(field) => (
                <field.TextField
                  label='Default currency'
                  placeholder='e.g. USD'
                  description='Optional ISO-4217 code.'
                />
              )}
            />
            <form.AppField
              name='notes'
              children={(field) => <field.TextareaField label='Notes' placeholder='Optional' />}
            />
            <form.AppField
              name='roles'
              mode='array'
              children={(field) => (
                <field.CheckboxGroupField
                  label='Roles'
                  description='Granted installation-wide. An entity-scoped role grant (if this party already holds one) is not shown or changed here.'
                  options={partnerRoleOptions}
                  className='grid grid-cols-2 gap-3'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                {isEdit ? 'Save changes' : 'Create trading partner'}
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
