import { useMutation } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useRef, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup, FieldSeparator } from '@/components/ui/field';
import { uploadAvatar } from '@/features/account/api/avatar';
import { isValidAvatarUrl } from '@/lib/avatar';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { splitFullName, userDisplayLabel, userInitials } from '@/lib/user-identity';
import { updateProfile, type SessionInfo } from '@/server/auth-functions';

/** Mirrors the server's `ALLOWED_AVATAR_MIME_TYPES`/`MAX_AVATAR_BYTES` (`@/server/avatar`). */
const ALLOWED_AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Client-side mirror of the server's `updateProfileInput` bounds. The server
 * validator is authoritative — this exists so the field errors appear next to
 * the inputs instead of arriving as a toast.
 */
const profileFormSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().max(100),
  displayName: z.string().trim().max(80),
  imageUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => value === '' || isValidAvatarUrl(value), 'Avatar URL must be an http(s) URL')
});

type ProfileFormValues = z.infer<typeof profileFormSchema>;

/**
 * Self-service profile editor: full name (entered first/last, stored as Better
 * Auth's single `name`), display name, and avatar URL.
 *
 * Values arrive pre-filled from the identity provider on first sign-in — a
 * generic OIDC issuer's `name`/`picture` claims become `name`/`image`, and
 * `nickname`/`preferred_username` seeds `displayName`. Anything saved here
 * wins permanently: Better Auth applies provider values only when it creates
 * the user, so later sign-ins never overwrite an in-app edit.
 */
export default function ProfileForm({ user }: { user: SessionInfo['user'] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { firstName, lastName } = splitFullName(user.name);

  const mutation = useMutation({
    mutationFn: (values: ProfileFormValues) => updateProfile({ data: values }),
    onSuccess: async () => {
      toast.success('Profile saved');
      // The signed-in identity lives in the router's root context, so the
      // sidebar picks up the new name/avatar as soon as it is revalidated.
      await router.invalidate();
    },
    onError: (error) => toastError(error, 'Failed to save profile')
  });

  // Uploads through `/api/account/avatar` set `user.image` server-side
  // immediately (same `auth.api.updateUser` call `updateProfile` uses) —
  // this mutation just reflects the result back into the form/preview and
  // revalidates the router so the sidebar avatar updates too.
  const avatarUpload = useMutation({
    mutationFn: uploadAvatar,
    onSuccess: async (result) => {
      form.setFieldValue('imageUrl', result.image);
      toast.success('Avatar uploaded');
      await router.invalidate();
    },
    onError: (error) => toastError(error, 'Failed to upload avatar')
  });

  function handleAvatarFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires a change event.
    event.target.value = '';
    if (!file) return;
    if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
      toast.error('Avatars must be a PNG, JPEG, or WEBP image');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('Avatars must be 2MB or smaller');
      return;
    }
    avatarUpload.mutate(file);
  }

  const form = useAppForm({
    defaultValues: {
      firstName,
      lastName,
      displayName: user.displayName ?? '',
      imageUrl: user.image ?? ''
    } satisfies ProfileFormValues,
    validators: { onSubmit: profileFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Already surfaced by the mutation's `onError` toast; swallowed here
        // so `isSubmitting` settles instead of rejecting out of the form.
      }
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How you are named and pictured across Loxep. Fields your identity provider supplied are
          filled in already; anything you change here is kept and is never overwritten by a later
          sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <div className='grid gap-4 sm:grid-cols-2'>
              <form.AppField
                name='firstName'
                children={(field) => (
                  <field.TextField
                    label='First name'
                    required
                    autoComplete='given-name'
                    description='Stored together with the last name as your full name.'
                  />
                )}
              />
              <form.AppField
                name='lastName'
                children={(field) => (
                  <field.TextField label='Last name' autoComplete='family-name' />
                )}
              />
            </div>
            <form.AppField
              name='displayName'
              children={(field) => (
                <field.TextField
                  label='Display name'
                  autoComplete='nickname'
                  description='The short name shown in the sidebar and wherever Loxep names you — “Will” for “Alex Rivera”. Leave it empty to be shown by your full name.'
                />
              )}
            />
          </FieldGroup>

          <FieldSeparator />

          <div className='flex flex-col gap-4 sm:flex-row sm:items-start'>
            <div className='flex flex-col items-start gap-2 sm:w-56'>
              <form.Subscribe
                selector={(state) => state.values}
                children={(values) => <AvatarPreview values={values} email={user.email} />}
              />
              <input
                ref={fileInputRef}
                type='file'
                accept='image/png,image/jpeg,image/webp'
                className='hidden'
                onChange={handleAvatarFileChange}
              />
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={avatarUpload.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {avatarUpload.isPending ? 'Uploading…' : 'Upload image'}
              </Button>
            </div>
            <div className='flex-1'>
              <FieldGroup>
                <form.AppField
                  name='imageUrl'
                  children={(field) => (
                    <field.TextField
                      label='Avatar URL'
                      type='text'
                      inputMode='url'
                      placeholder='https://…'
                      autoComplete='photo'
                      description='A link to an image, or upload one at left (PNG/JPEG/WEBP, up to 2MB). Your identity provider’s picture is used until you set one here; clear the field to fall back to your initials.'
                    />
                  )}
                />
              </FieldGroup>
            </div>
          </div>

          <div className='flex justify-end'>
            <form.AppForm>
              <form.SubmitButton>Save profile</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Live preview of the avatar as typed. Driven by the form's own values
 * (`form.Subscribe`) rather than a second piece of state, so the image and the
 * initials fallback always match what will be saved.
 */
function AvatarPreview({ values, email }: { values: ProfileFormValues; email: string }) {
  const label = userDisplayLabel({
    name: [values.firstName, values.lastName].filter(Boolean).join(' '),
    displayName: values.displayName,
    email
  });
  const src = values.imageUrl.trim();

  return (
    <div className='flex items-center gap-3 sm:w-56'>
      <Avatar size='lg' className='size-16'>
        {src && <AvatarImage src={src} alt='' />}
        <AvatarFallback className='text-base'>
          {userInitials({ name: label, email })}
        </AvatarFallback>
      </Avatar>
      <div className='grid text-sm leading-tight'>
        <span className='truncate font-medium'>{label}</span>
        <span className='text-muted-foreground truncate text-xs'>{email}</span>
      </div>
    </div>
  );
}
