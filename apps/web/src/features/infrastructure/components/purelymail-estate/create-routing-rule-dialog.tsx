import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  purelymailEstateDomainsQuery,
  purelymailEstateRoutingRulesQuery
} from '@/features/infrastructure/api/queries';
import { createPurelymailRoutingRule } from '@/server/purelymail-estate-functions';
import type { PurelymailCreateRoutingRuleActionDto } from '@/server/purelymail-estate-functions';

const createRoutingRuleFormSchema = z.object({
  domainId: z.string().min(1, 'A domain is required'),
  matchUser: z.string().trim(),
  targetAddresses: z.array(z.string().trim().min(1)).min(1, 'At least one target is required'),
  prefix: z.boolean(),
  catchall: z.boolean()
});

/**
 * Section-level "New routing rule…" for the Purelymail estate page
 * (loxep-4xo, A9) — mounts `MailboxAdminService.createRoutingRule` via
 * {@link createPurelymailRoutingRule}: additive (tier 1), the SAME
 * write-authorization gate the row-level "Delete…" already renders blocked
 * one tier lower. `blocked` is computed here from the SAME
 * `estateConnectionSummaryQuery` the header and every row action already
 * fetch, so the button (and its tooltip naming the flip) render blocked
 * BEFORE any click — Rule P14, never a surprise post-click refusal.
 */
export default function CreateRoutingRuleDialog({
  connectionId,
  open,
  onOpenChange,
  blocked
}: {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocked: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: domainsResult } = useQuery(purelymailEstateDomainsQuery(connectionId));
  const domainOptions = (domainsResult?.status === 'ok' ? domainsResult.data : [])
    .filter((domain) => domain.loxep !== null)
    .map((domain) => ({
      value: domain.loxep?.managedDomainId ?? '',
      label: domain.name
    }));

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof createRoutingRuleFormSchema>) =>
      createPurelymailRoutingRule({
        data: {
          connectionId,
          domainId: values.domainId,
          matchUser: values.matchUser,
          targetAddresses: values.targetAddresses,
          prefix: values.prefix,
          catchall: values.catchall
        }
      }),
    onSuccess: async (result: PurelymailCreateRoutingRuleActionDto) => {
      if (result.outcome === 'write_policy_blocked') {
        toast.warning(
          `Create blocked — this connection's write policy refused the write. Raise its tier on Settings → Connections to unblock it.`
        );
      } else {
        toast.success(
          result.outcome === 'already_exists'
            ? 'That routing rule already exists at Purelymail.'
            : 'Routing rule created at Purelymail.'
        );
        onOpenChange(false);
        form.reset();
      }
      await queryClient.invalidateQueries({
        queryKey: purelymailEstateRoutingRulesQuery(connectionId).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to create the routing rule')
  });

  const form = useAppForm({
    defaultValues: {
      domainId: '',
      matchUser: '',
      targetAddresses: [],
      prefix: false,
      catchall: false
    } as z.infer<typeof createRoutingRuleFormSchema>,
    validators: { onSubmit: createRoutingRuleFormSchema },
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
          <ResponsiveDialogTitle>New routing rule</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Mail matching this rule forwards to the target addresses immediately at Purelymail.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {blocked ? (
          <p className='text-muted-foreground text-sm'>
            Blocked: this connection&apos;s write policy must be &quot;Additive writes&quot; or
            higher to create a routing rule — raise it on Settings → Connections.
          </p>
        ) : domainOptions.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            No domain on this connection is declared in Loxep yet. Declare one under Infrastructure
            → Domains first.
          </p>
        ) : (
          <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
            <FieldGroup>
              <form.AppField
                name='domainId'
                children={(field) => (
                  <field.SelectField label='Domain' required options={domainOptions} />
                )}
              />
              <form.AppField
                name='matchUser'
                children={(field) => (
                  <field.TextField
                    label='Match user'
                    placeholder='Leave empty for a catch-all'
                    description='The local part to match — leave empty and enable "Catch-all" below to match everything unmatched.'
                  />
                )}
              />
              <form.AppField
                name='targetAddresses'
                mode='array'
                children={(field) => (
                  <field.TagsField
                    label='Forwards to'
                    placeholder='name@example.com'
                    description='One or more full addresses. Enter adds each one.'
                  />
                )}
              />
              <form.AppField
                name='prefix'
                children={(field) => (
                  <field.SwitchField
                    label='Prefix match'
                    description='Match any local part starting with "Match user" rather than an exact address.'
                  />
                )}
              />
              <form.AppField
                name='catchall'
                children={(field) => (
                  <field.SwitchField
                    label='Catch-all'
                    description='Match everything not otherwise handled for this domain.'
                  />
                )}
              />
            </FieldGroup>
            <div className='flex justify-end gap-2'>
              <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <form.AppForm>
                <form.SubmitButton>Create rule</form.SubmitButton>
              </form.AppForm>
            </div>
          </form>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
