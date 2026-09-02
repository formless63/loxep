import * as React from 'react';
import * as z from 'zod';
import { toast } from 'sonner';
import { useAppForm } from '@/lib/form';
import { authClient } from '@/lib/auth-client';
import type { LoginPaths } from '@/server/auth-functions';
import { useSearch } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Icons } from '@/components/icons';

const signInSchema = z.object({
  email: z.email('Enter a valid email address')
});

/** Where successful sign-ins land (magic-link verification and OAuth callback). */
const SIGN_IN_CALLBACK_PATH = '/dashboard/overview';

/**
 * Where a DECLINED sign-in lands. Better Auth otherwise sends magic-link
 * errors to the success callback and OAuth errors to its own
 * `/api/auth/error` page; pointing both back here is what lets the message
 * below be shown at all (ADR-0024 §3).
 */
const SIGN_IN_ERROR_PATH = '/auth/sign-in';

/**
 * Sign-in failures worth explaining. `SIGNUP_DISABLED` is the OAuth callback's
 * rendering of Loxep's own provisioning refusal; `failed_to_create_user` is
 * what the magic-link verifier emits when the same refusal aborts the insert.
 * Anything else is reported verbatim-ish, without inventing a diagnosis.
 */
function describeSignInError(error: string): { title: string; body: string } {
  if (error === 'SIGNUP_DISABLED' || error === 'failed_to_create_user') {
    return {
      title: 'This installation is not accepting new accounts',
      body: 'An administrator must create your account before you can sign in. If you already have one, check that you used the same address it was created with.'
    };
  }
  if (error === 'INVALID_TOKEN') {
    return {
      title: 'That sign-in link is no longer valid',
      body: 'Links expire quickly and can only be used once. Request a new one below.'
    };
  }
  return {
    title: 'Sign-in could not be completed',
    body: 'Please try again, or ask your Loxep administrator for help.'
  };
}

export function SignInView({ loginPaths }: { loginPaths: LoginPaths }) {
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [ssoPending, setSsoPending] = React.useState(false);
  const search = useSearch({ strict: false }) as { error?: unknown };
  const signInError = typeof search.error === 'string' ? search.error : null;

  // Both configured methods decline new accounts: say so up front rather than
  // letting a newcomer request a link that will never arrive. Stated once for
  // everyone, so it can never reveal whether a given address has an account.
  const newAccountsClosed =
    (!loginPaths.magicLink || !loginPaths.newAccounts.magicLink) &&
    (!loginPaths.oidc || !loginPaths.newAccounts.oidc);

  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: signInSchema },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.signIn.magicLink({
        email: value.email,
        callbackURL: SIGN_IN_CALLBACK_PATH
      });
      if (error) {
        toast.error(error.message || 'Could not send the sign-in link. Please try again.');
        return;
      }
      setSentTo(value.email);
    }
  });

  const handleSso = async () => {
    setSsoPending(true);
    // providerId matches OIDC_PROVIDER_ID in @loxep/auth; hardcoded here so
    // the server package never enters the client bundle.
    const { error } = await authClient.signIn.social({
      provider: 'oidc',
      callbackURL: SIGN_IN_CALLBACK_PATH,
      errorCallbackURL: SIGN_IN_ERROR_PATH
    });
    if (error) {
      toast.error(error.message || 'Could not start SSO sign-in. Please try again.');
      setSsoPending(false);
    }
  };

  return (
    <main className='bg-background flex min-h-dvh items-center justify-center p-4'>
      <Card className='w-full max-w-sm'>
        <CardHeader className='items-center text-center'>
          <div className='bg-primary text-primary-foreground mx-auto mb-2 flex size-10 items-center justify-center rounded-md'>
            <Icons.logo className='size-5' />
          </div>
          <CardTitle className='text-xl'>Sign in to Loxep</CardTitle>
          <CardDescription>Marketplace intelligence and commerce operations</CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          {signInError !== null && !sentTo && (
            <Alert variant='warning'>
              <AlertTitle>{describeSignInError(signInError).title}</AlertTitle>
              <AlertDescription>{describeSignInError(signInError).body}</AlertDescription>
            </Alert>
          )}
          {newAccountsClosed && !sentTo && (
            <Alert>
              <AlertTitle>New accounts are closed</AlertTitle>
              <AlertDescription>
                Sign in below if you already have an account. If you do not, an administrator must
                create one for you — there is no self-service sign-up.
              </AlertDescription>
            </Alert>
          )}
          {sentTo ? (
            <div className='space-y-4 text-center'>
              <div className='bg-muted mx-auto flex size-10 items-center justify-center rounded-full'>
                <Icons.send className='text-muted-foreground size-5' />
              </div>
              <div className='space-y-1'>
                <p className='font-medium'>Check your email</p>
                <p className='text-muted-foreground text-sm'>
                  We sent a sign-in link to <span className='font-medium'>{sentTo}</span>. The link
                  expires shortly, so use it soon.
                </p>
              </div>
              <Button variant='ghost' className='w-full' onClick={() => setSentTo(null)}>
                Use a different email
              </Button>
            </div>
          ) : (
            <>
              {loginPaths.oidc && (
                <Button className='w-full' onClick={handleSso} disabled={ssoPending}>
                  {ssoPending ? <Spinner className='size-4' /> : <Icons.login className='size-4' />}
                  Continue with SSO
                </Button>
              )}
              {loginPaths.magicLink && loginPaths.oidc && (
                <div className='flex items-center gap-3'>
                  <Separator className='flex-1' />
                  <span className='text-muted-foreground text-xs uppercase'>or</span>
                  <Separator className='flex-1' />
                </div>
              )}
              {loginPaths.magicLink && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                  }}
                  noValidate
                >
                  <FieldGroup className='gap-4'>
                    <form.AppField
                      name='email'
                      children={(field) => (
                        <field.TextField
                          label='Email'
                          type='email'
                          placeholder='you@example.com'
                          autoComplete='email'
                          required
                        />
                      )}
                    />
                    <form.AppForm>
                      {/* Outline when SSO is present: SSO is the primary path. */}
                      <form.SubmitButton
                        className='w-full'
                        variant={loginPaths.oidc ? 'outline' : 'default'}
                      >
                        Send sign-in link
                      </form.SubmitButton>
                    </form.AppForm>
                  </FieldGroup>
                </form>
              )}
              {!loginPaths.magicLink && !loginPaths.oidc && (
                <p className='text-muted-foreground text-center text-sm'>
                  No login path is configured. Set the OIDC and/or SMTP bootstrap variables and
                  restart Loxep.
                </p>
              )}
            </>
          )}
        </CardContent>
        <CardFooter className='justify-center'>
          <p className='text-muted-foreground text-xs'>
            Access is managed by your Loxep administrator.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
