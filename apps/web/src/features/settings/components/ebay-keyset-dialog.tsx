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
import { storeEbayKeyset } from '@/server/ebay-oauth';
import { ebayCallbackUrlQuery, ebayKeysetStatusQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  CopyableValue,
  GuidanceCallout,
  GuidanceLink,
  GuidanceNote,
  GuidanceStep,
  GuidanceSteps,
  SetupGuidance
} from '@/features/settings/components/setup-guidance';

const environmentOptions = [
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'production', label: 'Production' }
];

const keysetFormSchema = z.object({
  environment: z.enum(['sandbox', 'production']),
  appId: z.string().trim().min(1, 'App ID is required'),
  certId: z.string().trim().min(1, 'Cert ID is required'),
  devId: z.string().trim().min(1, 'Dev ID is required'),
  ruName: z.string().trim()
});

type KeysetFormValues = z.infer<typeof keysetFormSchema>;

const EBAY_KEYSETS_URL = 'https://developer.ebay.com/my/keys';

/**
 * The eBay developer-portal path that produces everything this form asks
 * for. The callback URL is read from the running installation rather than
 * written out as an example, because the value eBay must be given is a
 * property of THIS deployment — see `fetchEbayCallbackUrl`.
 */
function KeysetSetupGuidance() {
  const { data } = useQuery(ebayCallbackUrlQuery);
  const callbackUrl = data?.callbackUrl ?? null;
  const callbackPath = data?.callbackPath ?? '/api/integrations/ebay/callback';

  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Sign in to your eBay developer account and open{' '}
          <GuidanceLink href={EBAY_KEYSETS_URL}>Application Keysets</GuidanceLink>.
        </GuidanceStep>
        <GuidanceStep>
          Pick the keyset for the environment you want. <strong>Sandbox</strong> is eBay&apos;s
          isolated test site — its own listings, its own logins, no real money.{' '}
          <strong>Production</strong> is the live eBay site — real listings, real accounts, real
          rate limits.
          <GuidanceNote>
            Copy that keyset&apos;s App ID, Cert ID, and Dev ID into the fields below, and set
            Environment to match. A sandbox keyset never authenticates against production, or the
            reverse.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          On the same keyset choose <strong>User Tokens</strong>, then{' '}
          <strong>Add eBay Redirect URL</strong>.
        </GuidanceStep>
        <GuidanceStep>
          Put this installation&apos;s callback URL in <strong>Your auth accepted URL</strong>:
          <div className='mt-2'>
            <CopyableValue value={callbackUrl} />
          </div>
          {callbackUrl === null ? (
            <GuidanceNote>
              This installation has no public origin configured, so the full URL cannot be shown.
              The path is <code className='font-mono'>{callbackPath}</code> — prefix it with the
              address people reach Loxep on.
            </GuidanceNote>
          ) : (
            <GuidanceNote>
              eBay also asks for a display title, an auth declined URL, and a privacy policy URL on
              the same form. The same callback URL works as the declined URL — Loxep handles a
              declined consent as well as an accepted one.
            </GuidanceNote>
          )}
        </GuidanceStep>
        <GuidanceStep>
          Select <strong>OAuth</strong> — not Auth&apos;n&apos;Auth — and save.
        </GuidanceStep>
        <GuidanceStep>
          Copy the <strong>RuName</strong> eBay generates (it calls it the &quot;redirect URL
          name&quot;) into the RuName field below.
          <GuidanceNote>
            eBay sends the RuName itself as the redirect target and resolves it to the accepted URL
            above, so the two always have to describe the same installation. If Loxep later moves to
            a different address, update the accepted URL in the portal as well.
          </GuidanceNote>
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          The keyset is shared by every eBay account connected here, and every value is write-only:
          it is stored encrypted and never shown again. Saving again replaces the whole keyset.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

/**
 * Admin-only eBay application-keyset form (loxep-62y.5). Every field is
 * write-only: the value is sent once to `storeEbayKeyset`
 * (`@/server/ebay-oauth`), which persists it as the encrypted application
 * secret `integration.ebay.keyset` (ADR-0019, purpose `ebay_keyset`) — no
 * read surface ever echoes it back, including this dialog, which always
 * opens blank.
 */
export default function EbayKeysetDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: KeysetFormValues) =>
      storeEbayKeyset({
        data: {
          environment: values.environment,
          appId: values.appId,
          certId: values.certId,
          devId: values.devId,
          ruName: values.ruName.trim() === '' ? null : values.ruName.trim()
        }
      }),
    onSuccess: () => {
      toast.success('eBay keyset saved');
      queryClient.invalidateQueries({ queryKey: ebayKeysetStatusQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save eBay keyset')
  });

  const form = useAppForm({
    defaultValues: {
      environment: 'sandbox' as KeysetFormValues['environment'],
      appId: '',
      certId: '',
      devId: '',
      ruName: ''
    },
    validators: {
      onSubmit: keysetFormSchema
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
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Configure eBay keyset</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The application keyset from your eBay developer account — one keyset for the whole
            installation, shared by every eBay connection. The RuName is what enables the consent
            screen, so add it here once the redirect URL is registered with eBay.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <KeysetSetupGuidance />
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='environment'
              children={(field) => (
                <field.SelectField label='Environment' required options={environmentOptions} />
              )}
            />
            <form.AppField
              name='appId'
              children={(field) => (
                <field.TextField
                  label='App ID'
                  required
                  autoComplete='off'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='certId'
              children={(field) => (
                <field.TextField
                  label='Cert ID'
                  required
                  type='password'
                  autoComplete='new-password'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='devId'
              children={(field) => (
                <field.TextField
                  label='Dev ID'
                  required
                  type='password'
                  autoComplete='new-password'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='ruName'
              children={(field) => (
                <field.TextField
                  label='RuName'
                  autoComplete='off'
                  placeholder='e.g. Your_Name-YourApp-SBX-abc123'
                  description='eBay "Redirect URL name" — required before "Connect eBay account" will work.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save keyset</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
