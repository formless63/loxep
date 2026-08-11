import * as React from 'react';
import * as z from 'zod';
import { toast } from 'sonner';
import { useAppForm } from '@/lib/form';
import { authClient } from '@/lib/auth-client';
import type { LoginPaths } from '@/server/auth-functions';
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

export function SignInView({ loginPaths }: { loginPaths: LoginPaths }) {
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [ssoPending, setSsoPending] = React.useState(false);

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
    const { error } = await authClient.signIn.oauth2({
      providerId: 'oidc',
      callbackURL: SIGN_IN_CALLBACK_PATH
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
                      <form.SubmitButton className='w-full'>Send sign-in link</form.SubmitButton>
                    </form.AppForm>
                  </FieldGroup>
                </form>
              )}
              {loginPaths.magicLink && loginPaths.oidc && (
                <div className='flex items-center gap-3'>
                  <Separator className='flex-1' />
                  <span className='text-muted-foreground text-xs uppercase'>or</span>
                  <Separator className='flex-1' />
                </div>
              )}
              {loginPaths.oidc && (
                <Button
                  variant='outline'
                  className='w-full'
                  onClick={handleSso}
                  disabled={ssoPending}
                >
                  {ssoPending ? <Spinner className='size-4' /> : <Icons.login className='size-4' />}
                  Continue with SSO
                </Button>
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
