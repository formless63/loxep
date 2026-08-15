import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
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
import { createUserAsAdmin } from '@/server/admin-functions';
import { usersQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';

const newUserSchema = z.object({
  email: z.email('Enter a valid email address'),
  name: z.string().trim().min(1, 'Name is required'),
  // Plain string in the form (SelectField is string-valued); narrowed at
  // submit, and validated again by the server function's own enum.
  role: z.string().min(1, 'Role is required')
});

type NewUserValues = z.infer<typeof newUserSchema>;

const roleOptions = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' }
];

/**
 * Add a person directly (ADR-0024 §4) — the escape hatch a closed installation
 * uses instead of an invite system. No password is set or sent: Loxep has no
 * password login, so the person signs in with a magic link or SSO as usual.
 * The account existing is what gets them past the provisioning policy.
 */
export default function NewUserDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: NewUserValues) =>
      createUserAsAdmin({
        data: {
          email: values.email,
          name: values.name,
          role: values.role === 'admin' ? 'admin' : 'member'
        }
      }),
    onSuccess: () => {
      toast.success('User created — they can now sign in');
      queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to create the user')
  });

  const form = useAppForm({
    defaultValues: { email: '', name: '', role: 'member' },
    validators: { onSubmit: newUserSchema },
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Creates the account so this person can sign in even while new accounts are closed. No
            password is set — they sign in with a magic link or SSO exactly like everyone else.
            Nothing is emailed to them; tell them the account is ready.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='email'
              children={(field) => (
                <field.TextField
                  label='Email'
                  type='email'
                  placeholder='colleague@example.com'
                  autoComplete='off'
                  required
                  description='Must match the address they will sign in with — for SSO, the address their identity provider reports.'
                />
              )}
            />
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' placeholder='Alex Rivera' required />
              )}
            />
            <form.AppField
              name='role'
              children={(field) => (
                <field.SelectField
                  label='Role'
                  options={roleOptions}
                  description='Member reads ordinary product data across the installation; admin adds installation and security operations.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end'>
            <form.AppForm>
              <form.SubmitButton>Create user</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
