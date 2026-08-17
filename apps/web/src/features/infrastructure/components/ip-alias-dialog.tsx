import { useStore } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { formatRelativeTime } from '@/lib/format';
import { createIpAlias, updateIpAlias, type IpAliasDto } from '@/server/infrastructure-functions';
import {
  ipAliasesQuery,
  pangolinConnectionOptionsQuery
} from '@/features/infrastructure/api/queries';
import { IP_ALIAS_SOURCE_OPTIONS } from '@/features/infrastructure/constants';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';

const aliasFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .regex(
        /^[a-z][a-z0-9_-]*$/,
        "Lowercase letters, digits, '-' and '_' only, starting with a letter"
      ),
    address: z.string().trim().min(1, 'Address is required'),
    source: z.enum(['manual', 'dns', 'pangolin_site']),
    hostname: z.string(),
    connectionId: z.string(),
    siteId: z.string(),
    autoApply: z.boolean()
  })
  .refine((value) => value.source !== 'dns' || value.hostname.trim() !== '', {
    message: 'A hostname is required for the DNS detector',
    path: ['hostname']
  })
  .refine(
    (value) =>
      value.source !== 'pangolin_site' ||
      (value.connectionId !== '' && value.connectionId !== '__none__'),
    {
      message: 'A Pangolin connection is required for the site detector',
      path: ['connectionId']
    }
  )
  .refine((value) => value.source !== 'pangolin_site' || value.siteId.trim() !== '', {
    message: "The site's own id is required for the site detector",
    path: ['siteId']
  });

type AliasFormValues = z.infer<typeof aliasFormSchema>;

/** The Select's own placeholder value — `SelectField` needs a non-empty string for every option, including "none chosen". */
const NO_CONNECTION_VALUE = '__none__';

/**
 * Create/edit dialog for a named dynamic-IP alias (Pangolin chain design
 * milestone 5, loxep-acj.5). The name is immutable once created — it is the
 * setting's own map key AND the identifier embedded in every referencing
 * rule's `alias:<name>` value, so renaming here would silently orphan
 * whatever already references the old name.
 */
export default function IpAliasDialog({
  open,
  onOpenChange,
  alias
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alias: IpAliasDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = alias !== null;
  const { data: connectionOptions } = useQuery(pangolinConnectionOptionsQuery);

  const mutation = useMutation({
    mutationFn: (values: AliasFormValues) => {
      const shared = {
        address: values.address.trim(),
        source: values.source,
        hostname: values.source === 'dns' ? values.hostname.trim() : null,
        connectionId:
          values.source === 'pangolin_site' && values.connectionId !== NO_CONNECTION_VALUE
            ? values.connectionId
            : null,
        siteId: values.source === 'pangolin_site' ? values.siteId.trim() : null,
        // A manual alias has no detector to trust — never let autoApply
        // stick from before a source change, client-side belt to the
        // server's own suspenders (below).
        autoApply: values.source === 'manual' ? false : values.autoApply
      };
      if (isEdit) {
        return updateIpAlias({ data: { name: alias.name, ...shared } });
      }
      return createIpAlias({ data: { name: values.name.trim(), ...shared } });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Alias updated' : 'Alias created');
      queryClient.invalidateQueries({ queryKey: ipAliasesQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save alias')
  });

  const form = useAppForm({
    defaultValues: {
      name: alias?.name ?? '',
      address: alias?.address ?? '',
      source: (alias?.source ?? 'manual') as AliasFormValues['source'],
      hostname: alias?.hostname ?? '',
      connectionId: alias?.connectionId ?? NO_CONNECTION_VALUE,
      siteId: alias?.siteId ?? '',
      autoApply: alias?.autoApply ?? false
    } satisfies AliasFormValues,
    validators: {
      onSubmit: aliasFormSchema
    },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const source = useStore(form.store, (s) => s.values.source);
  const connectionSelectOptions = [
    { value: NO_CONNECTION_VALUE, label: 'Choose a connection…' },
    ...(connectionOptions ?? []).map((c) => ({ value: c.id, label: c.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {isEdit ? `Edit alias '${alias.name}'` : 'New IP alias'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A named dynamic-IP address — the primitive Pangolin itself does not have. Reference it
            from a rule as <code className='font-mono'>alias:{'<name>'}</code> instead of a literal
            address.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField
                  label='Name'
                  required
                  disabled={isEdit}
                  placeholder='home'
                  description={
                    isEdit
                      ? 'Immutable once created — referencing rules embed this name.'
                      : "Lowercase letters, digits, '-' and '_' only."
                  }
                />
              )}
            />
            <form.AppField
              name='source'
              children={(field) => (
                <field.SelectField
                  label='Source'
                  options={IP_ALIAS_SOURCE_OPTIONS}
                  description='Where the address comes from. DNS and Pangolin site sources run automatically; manual is edited here.'
                />
              )}
            />
            <form.AppField
              name='address'
              children={(field) => (
                <field.TextField
                  label='Current address'
                  required
                  placeholder='203.0.113.7'
                  description={
                    source === 'manual'
                      ? 'You update this by hand when the address changes.'
                      : 'The detected address — the next sweep overwrites this automatically.'
                  }
                />
              )}
            />
            {source === 'dns' && (
              <form.AppField
                name='hostname'
                children={(field) => (
                  <field.TextField
                    label='Hostname to resolve'
                    required
                    placeholder='home.example.dyndns.net'
                    description='Resolved via one A-record lookup each detection cycle.'
                  />
                )}
              />
            )}
            {source === 'pangolin_site' && (
              <>
                <form.AppField
                  name='connectionId'
                  children={(field) => (
                    <field.SelectField
                      label='Pangolin connection'
                      options={connectionSelectOptions}
                      description='Which Pangolin instance the site belongs to.'
                    />
                  )}
                />
                <form.AppField
                  name='siteId'
                  children={(field) => (
                    <field.TextField
                      label="Site's own id"
                      required
                      placeholder='1'
                      description="Pangolin's own numeric site id — unverified against a live read; falls back to no detection if the field the site read exposes is absent or unparseable."
                    />
                  )}
                />
              </>
            )}
            {source === 'manual' ? (
              <p className='text-muted-foreground text-sm'>
                Auto-apply is unavailable for a manual alias — there is no detector run to trust.
              </p>
            ) : (
              <form.AppField
                name='autoApply'
                children={(field) => (
                  <field.SwitchField
                    label='Auto-apply'
                    description="Lets a detected change apply the ADD half automatically, once the connection's write policy also permits it. Never applies a retire, and always notifies."
                  />
                )}
              />
            )}
          </FieldGroup>
          {isEdit && <SystemWrittenFields alias={alias} />}
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>{isEdit ? 'Save changes' : 'Create alias'}</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * `previousAddress`/`observedAt`/`confirmedAt` are system-written — a
 * detector run or, for `confirmedAt`, this very dialog's own save (see
 * `updateIpAlias`'s handler). They are never inputs: shown here read-only,
 * outside `FieldGroup`, so there is no path through this form that submits a
 * hand-edited value for any of them. Rendered only once there is at least
 * one to show — a freshly created alias has none yet.
 */
function SystemWrittenFields({ alias }: { alias: IpAliasDto }) {
  if (alias.previousAddress === null && alias.observedAt === null && alias.confirmedAt === null) {
    return null;
  }
  return (
    <div className='bg-muted/50 rounded-md border p-3'>
      <p className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'>
        System-written — read only
      </p>
      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm'>
        {alias.previousAddress !== null && (
          <>
            <dt className='text-muted-foreground'>Previous address</dt>
            <dd className='font-mono'>{alias.previousAddress}</dd>
          </>
        )}
        {alias.observedAt !== null && (
          <>
            <dt className='text-muted-foreground'>Last observed (detector)</dt>
            <dd>{formatRelativeTime(alias.observedAt)}</dd>
          </>
        )}
        {alias.confirmedAt !== null && (
          <>
            <dt className='text-muted-foreground'>Last confirmed (operator)</dt>
            <dd>{formatRelativeTime(alias.confirmedAt)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
