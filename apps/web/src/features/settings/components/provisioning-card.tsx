import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup, FieldSeparator } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { updateAuthProvisioning, type AuthProvisioningDto } from '@/server/admin-functions';
import { authProvisioningQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

const provisioningFormSchema = z.object({
  magicLinkOpen: z.boolean(),
  oidcOpen: z.boolean(),
  magicLinkEmailDomains: z.array(
    z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
        'Enter a bare domain such as example.com'
      )
  ),
  claim: z.string().trim().max(200),
  adminValues: z.array(z.string().trim().min(1)),
  claimEverySignIn: z.boolean()
});

type ProvisioningFormValues = z.infer<typeof provisioningFormSchema>;

/**
 * Account provisioning policy (ADR-0024): who may become a Loxep user.
 *
 * Every control here governs account CREATION only — an existing user always
 * keeps their sign-in path — which is why the copy says so on each field and
 * why the only hazard warned about is the authoritative claim mapping, not the
 * domain allowlist.
 */
export default function ProvisioningCard() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(authProvisioningQuery);

  if (isPending) {
    return (
      <ProvisioningShell>
        <Skeleton className='h-40 w-full' />
      </ProvisioningShell>
    );
  }

  if (isError) {
    return (
      <ProvisioningShell>
        <QueryErrorAlert
          error={error}
          title='Failed to load the provisioning policy'
          onRetry={() => refetch()}
        />
      </ProvisioningShell>
    );
  }

  const closed = data.newUsers.magicLink === 'closed' && data.newUsers.oidc === 'closed';

  return (
    <ProvisioningShell closed={closed} inForce={data.installationHasAdmin}>
      {!data.installationHasAdmin && (
        <Alert className='mb-6'>
          <AlertTitle>This policy is not in force yet</AlertTitle>
          <AlertDescription>
            The installation has no administrator, so new accounts are accepted from every
            configured method whatever this policy says — otherwise a fresh deployment could never
            sign anybody in. The policy below takes effect the moment the first administrator
            exists.
          </AlertDescription>
        </Alert>
      )}
      <ProvisioningForm
        data={data}
        onSaved={() => queryClient.invalidateQueries({ queryKey: authProvisioningQuery.queryKey })}
      />
    </ProvisioningShell>
  );
}

function ProvisioningShell({
  closed,
  inForce,
  children
}: {
  closed?: boolean;
  inForce?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex flex-wrap items-center gap-2 text-base'>
          Account provisioning
          {closed !== undefined && (
            <Badge variant={closed ? 'default' : 'secondary'}>
              {closed ? 'New accounts closed' : 'New accounts open'}
            </Badge>
          )}
          {inForce === false && <Badge variant='outline'>not in force</Badge>}
        </CardTitle>
        <CardDescription>
          Who may become a Loxep user. These controls govern account <strong>creation</strong> only
          — people who already have an account keep signing in exactly as before, whatever you set
          here, so nothing on this card can lock anybody out. When new accounts are closed, add
          people with <strong>New user</strong> below.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ProvisioningForm({ data, onSaved }: { data: AuthProvisioningDto; onSaved: () => void }) {
  const mutation = useMutation({
    mutationFn: (values: ProvisioningFormValues) =>
      updateAuthProvisioning({
        data: {
          newUsers: {
            magicLink: values.magicLinkOpen ? 'open' : 'closed',
            oidc: values.oidcOpen ? 'open' : 'closed'
          },
          magicLinkEmailDomains: values.magicLinkEmailDomains.map((domain) => domain.trim()),
          oidcAdminClaim: {
            claim: values.claim.trim() === '' ? null : values.claim.trim(),
            adminValues: values.adminValues.map((value) => value.trim()),
            applyOn: values.claimEverySignIn ? 'every_sign_in' : 'create'
          }
        }
      }),
    onSuccess: () => {
      toast.success('Provisioning policy saved');
      onSaved();
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to save the provisioning policy')
  });

  const form = useAppForm({
    defaultValues: {
      magicLinkOpen: data.newUsers.magicLink === 'open',
      oidcOpen: data.newUsers.oidc === 'open',
      magicLinkEmailDomains: data.magicLinkEmailDomains,
      claim: data.oidcAdminClaim.claim ?? '',
      adminValues: data.oidcAdminClaim.adminValues,
      claimEverySignIn: data.oidcAdminClaim.applyOn === 'every_sign_in'
    },
    validators: { onSubmit: provisioningFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <FieldGroup>
        <form.AppField
          name='magicLinkOpen'
          children={(field) => (
            <field.SwitchField
              label='Anyone with an email address can create an account'
              description='While off, a magic link is never sent to an address that has no account, so a stranger cannot sign themselves up — and cannot make this server email them either.'
            />
          )}
        />
        <form.AppField
          name='magicLinkEmailDomains'
          mode='array'
          children={(field) => (
            <field.TagsField
              label='Allowed email domains'
              placeholder='example.com'
              description='Bare domains only, and exact — example.com does not cover sub.example.com. Leave empty for no restriction. Applies to new accounts only; it can never affect anyone who already has one, including you.'
            />
          )}
        />
        <form.AppField
          name='oidcOpen'
          children={(field) => (
            <field.SwitchField
              label='Anyone your identity provider authenticates can create an account'
              description='Turn this on when your identity provider is the gate — everyone it lets through gets a Loxep member account on first sign-in. While off, SSO sign-in is declined for people who have no account yet.'
            />
          )}
        />
      </FieldGroup>

      <FieldSeparator />

      <div className='space-y-1'>
        <p className='text-sm font-medium'>Administrators from your identity provider</p>
        <p className='text-muted-foreground text-sm'>
          Optional. Read from the OIDC id_token, so the claim has to be one your issuer already puts
          there under the <code className='font-mono'>openid profile email</code> scopes — if it
          needs an extra scope, Loxep cannot see it yet and the mapping does nothing.
        </p>
      </div>

      <FieldGroup>
        <form.AppField
          name='claim'
          children={(field) => (
            <field.TextField
              label='Claim'
              placeholder='groups'
              description='Dotted path into the id_token claims — groups, or realm_access.roles. Leave empty to ignore claims entirely.'
            />
          )}
        />
        <form.AppField
          name='adminValues'
          mode='array'
          children={(field) => (
            <field.TagsField
              label='Values that mean administrator'
              placeholder='loxep-admins'
              description='Matched case-insensitively against the claim. Only the admin role is ever mapped — Loxep has exactly two roles.'
            />
          )}
        />
        <form.AppField
          name='claimEverySignIn'
          children={(field) => (
            <field.SwitchField
              label='Re-apply on every sign-in'
              description='Off (recommended): the claim grants admin once, when the account is first created, and role changes you make here are permanent afterwards. On: your identity provider is authoritative and will also REVOKE admin from anyone whose claim stops matching.'
            />
          )}
        />
      </FieldGroup>

      <form.Subscribe
        selector={(state) => ({
          everySignIn: state.values.claimEverySignIn,
          claim: state.values.claim,
          adminValues: state.values.adminValues
        })}
        children={({ everySignIn, claim, adminValues }) =>
          everySignIn && claim.trim() !== '' && adminValues.length > 0 ? (
            <Alert variant='warning'>
              <AlertTitle>Your identity provider will own the admin role</AlertTitle>
              <AlertDescription>
                Every administrator — including you — is demoted to member on their next sign-in
                unless their <code className='font-mono'>{claim.trim()}</code> claim carries one of
                these values. Confirm you are in that group before saving. Loxep will refuse to
                demote the last remaining administrator, but that is a backstop, not a plan.
              </AlertDescription>
            </Alert>
          ) : null
        }
      />

      <form.Subscribe
        selector={(state) => state.values.magicLinkEmailDomains}
        children={(domains) =>
          data.currentUserEmailDomain !== null &&
          domains.length > 0 &&
          !domains.some((domain) => domain.trim().toLowerCase() === data.currentUserEmailDomain) ? (
            <Alert>
              <AlertTitle>Your own domain is not on this list</AlertTitle>
              <AlertDescription>
                Your account is unaffected — this list only applies to people who do not have one
                yet — but colleagues at{' '}
                <span className='font-medium'>{data.currentUserEmailDomain}</span> will not be able
                to sign themselves up.
              </AlertDescription>
            </Alert>
          ) : null
        }
      />

      <div className='flex justify-end'>
        <form.AppForm>
          <form.SubmitButton>Save</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}
