import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { dismissOnboardingOidcPrompt, enableOidcOnboarding } from '@/server/admin-functions';
import { authProvisioningQuery, onboardingOidcPromptQuery } from '@/features/settings/api/queries';

/**
 * `/dashboard/overview` onboarding card (ADR-0024 §2, loxep-yk8).
 *
 * The owner ruling that confirmed `auth.provisioning`'s closed-for-both
 * default explicitly rejected defaulting `oidc` to `'open'` — one coherent
 * default is easier to reason about than a two-speed one — and addressed the
 * discoverability gap that split was trying to close with this one-time
 * surface instead: right after the installation's first administrator
 * exists, offer the choice rather than silently making it. See
 * `authOnboardingOidcPromptDismissedSetting` (`@loxep/domain`) for why
 * dismissal is its own setting.
 *
 * Renders nothing until the query resolves — this is a discoverability
 * nicety, not primary page content, so there is no skeleton to reserve space
 * for it — and nothing again once its own conditions say not to show it
 * (already dismissed, OIDC not bootstrap-configured, or `newUsers.oidc`
 * already open).
 */
export function OnboardingOidcPromptCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery(onboardingOidcPromptQuery);

  const invalidatePrompt = () =>
    queryClient.invalidateQueries({ queryKey: onboardingOidcPromptQuery.queryKey });

  const enable = useMutation({
    mutationFn: () => enableOidcOnboarding(),
    onSuccess: () => {
      toast.success('OIDC auto-provisioning is now open for new accounts');
      void invalidatePrompt();
      // The full provisioning policy card on /settings/users reads this same
      // setting — keep it in sync rather than waiting for its own refetch.
      void queryClient.invalidateQueries({ queryKey: authProvisioningQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to enable OIDC auto-provisioning')
  });

  const dismiss = useMutation({
    mutationFn: () => dismissOnboardingOidcPrompt(),
    onSuccess: () => void invalidatePrompt(),
    onError: (error) => toastError(error, 'Failed to dismiss this card')
  });

  if (!data?.show) return null;

  return (
    <Alert>
      <AlertTitle>Let your identity provider create accounts automatically?</AlertTitle>
      <AlertDescription>
        <p>
          Right now, new accounts are closed: only people you add from{' '}
          <span className='font-medium'>Settings → Users</span> can sign in, even through your
          identity provider. Turning this on means anyone your identity provider authenticates gets
          a Loxep <span className='font-medium'>member</span> account on first sign-in — the same
          &ldquo;add the user in your IdP, they sign in&rdquo; behavior most self-hosted SSO setups
          have. Leaving it off is a perfectly good choice: you can open it any time from{' '}
          <span className='font-medium'>Settings → Users → Account provisioning</span>.
        </p>
        <div className='mt-2 flex gap-2'>
          <Button size='sm' onClick={() => enable.mutate()} disabled={enable.isPending}>
            Open OIDC auto-provisioning
          </Button>
          <Button
            size='sm'
            variant='outline'
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
          >
            Not now
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
