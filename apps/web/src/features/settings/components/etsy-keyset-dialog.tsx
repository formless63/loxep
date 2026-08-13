import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { storeEtsyKeyset } from '@/server/etsy-oauth';
import { etsyCallbackUrlQuery, etsyKeysetStatusQuery } from '@/features/settings/api/queries';
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

const keysetFormSchema = z.object({
  keystring: z.string().trim().min(1, 'Keystring is required'),
  sharedSecret: z.string().trim().min(1, 'Shared secret is required')
});

type KeysetFormValues = z.infer<typeof keysetFormSchema>;

const ETSY_DEVELOPER_PORTAL_URL = 'https://www.etsy.com/developers/register';
const ETSY_YOUR_APPS_URL = 'https://www.etsy.com/developers/your-apps';

/**
 * The Etsy Developer Portal path that produces everything this form asks
 * for, plus the two facts that block most first attempts: 2FA/captcha
 * before an app can even be registered, and the 24-48h approval wait during
 * which the key is inactive for every call, including public ones.
 */
function KeysetSetupGuidance() {
  const { data } = useQuery(etsyCallbackUrlQuery);
  const callbackUrl = data?.callbackUrl ?? null;
  const callbackPath = data?.callbackPath ?? '/api/integrations/etsy/callback';

  return (
    <SetupGuidance>
      <GuidanceSteps>
        <GuidanceStep>
          Enable two-factor authentication on your Etsy account first — the Developer Portal refuses
          app registration without it.
        </GuidanceStep>
        <GuidanceStep>
          Register a <strong>Personal App</strong> at{' '}
          <GuidanceLink href={ETSY_DEVELOPER_PORTAL_URL}>Etsy&apos;s Developer Portal</GuidanceLink>
          . You will complete a captcha identity-verification step.
          <GuidanceNote>
            Etsy reviews every new app before its key is active — typically 24&ndash;48 hours,
            longer if the description is vague. Nothing here works, including public reads, until
            approval lands.
          </GuidanceNote>
        </GuidanceStep>
        <GuidanceStep>
          Once approved, open <GuidanceLink href={ETSY_YOUR_APPS_URL}>Your Apps</GuidanceLink> and
          copy the <strong>Keystring</strong> and <strong>Shared secret</strong> into the fields
          below.
        </GuidanceStep>
        <GuidanceStep>
          Register this installation&apos;s callback URL as the app&apos;s OAuth redirect URI:
          <div className='mt-2'>
            <CopyableValue value={callbackUrl} />
          </div>
          {callbackUrl === null ? (
            <GuidanceNote>
              This installation has no public origin configured, so the full URL cannot be shown.
              The path is <code className='font-mono'>{callbackPath}</code> — prefix it with the
              address people reach Loxep on, or use{' '}
              <code className='font-mono'>http://127.0.0.1:&lt;port&gt;{callbackPath}</code> for
              local development, which Etsy allows as its one HTTP exception.
            </GuidanceNote>
          ) : (
            <GuidanceNote>
              Etsy takes this literal URL — unlike eBay, there is no portal-generated redirect name
              to copy back.
            </GuidanceNote>
          )}
        </GuidanceStep>
      </GuidanceSteps>
      <GuidanceCallout>
        <p>
          Etsy has no sandbox. This keyset — and every Etsy shop connected with it — talks to the
          real Etsy site from the moment it is approved.
        </p>
        <p>
          The keyset is shared by every Etsy shop connected here, and every value is write-only: it
          is stored encrypted and never shown again. Saving again replaces the whole keyset.
        </p>
      </GuidanceCallout>
    </SetupGuidance>
  );
}

/**
 * Admin-only Etsy application-keyset form (loxep-g4t.1). Every field is
 * write-only: the value is sent once to `storeEtsyKeyset`
 * (`@/server/etsy-oauth`), which persists it as the encrypted application
 * secret `integration.etsy.keyset` (ADR-0019, purpose `etsy_keyset`) — no
 * read surface ever echoes it back.
 */
export default function EtsyKeysetDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: KeysetFormValues) =>
      storeEtsyKeyset({
        data: { keystring: values.keystring, sharedSecret: values.sharedSecret }
      }),
    onSuccess: () => {
      toast.success('Etsy keyset saved');
      queryClient.invalidateQueries({ queryKey: etsyKeysetStatusQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save Etsy keyset')
  });

  const form = useAppForm({
    defaultValues: { keystring: '', sharedSecret: '' },
    validators: { onSubmit: keysetFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>Configure Etsy keyset</DialogTitle>
          <DialogDescription>
            The application keyset from your Etsy Developer Portal app — one keyset for the whole
            installation, shared by every Etsy shop.
          </DialogDescription>
        </DialogHeader>
        <KeysetSetupGuidance />
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='keystring'
              children={(field) => (
                <field.TextField
                  label='Keystring'
                  required
                  autoComplete='off'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='sharedSecret'
              children={(field) => (
                <field.TextField
                  label='Shared secret'
                  required
                  type='password'
                  autoComplete='new-password'
                  description='Write-only: stored encrypted, never displayed again.'
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
      </DialogContent>
    </Dialog>
  );
}
