import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { FieldGroup } from '@/components/ui/field';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { usersQuery } from '@/features/settings/api/queries';
import {
  banUser,
  setUserRole,
  signOutUserEverywhere,
  unbanUser,
  type UserDto
} from '@/server/admin-functions';

const BAN_DURATION_VALUES = ['permanent', '1h', '1d', '7d', '30d'] as const;
type BanDuration = (typeof BAN_DURATION_VALUES)[number];

const BAN_DURATION_OPTIONS: { value: BanDuration; label: string }[] = [
  { value: 'permanent', label: 'Permanent' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' }
];

/** Seconds for `banExpiresIn`; `undefined` (permanent) is never sent to the server. */
const BAN_DURATION_SECONDS: Record<BanDuration, number | undefined> = {
  permanent: undefined,
  '1h': 60 * 60,
  '1d': 60 * 60 * 24,
  '7d': 60 * 60 * 24 * 7,
  '30d': 60 * 60 * 24 * 30
};

const banFormSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required'),
  duration: z.enum(BAN_DURATION_VALUES)
});

/**
 * Row actions for one user (loxep-u8c A17/A18): the existing role toggle,
 * plus ban/unban (a required reason, an optional expiry) and a standalone
 * "Sign out everywhere" — the only recourse before this bead was psql.
 *
 * Each mutation is scoped to its own instance here (not a table-level
 * mutation), so `isPending` only disables the control actually in flight —
 * the same reasoning the pre-existing role-toggle mutation already
 * documented for itself.
 */
export function CellAction({ data, currentUserId }: { data: UserDto; currentUserId: string }) {
  const queryClient = useQueryClient();
  const isSelf = data.id === currentUserId;
  const [confirmingRole, setConfirmingRole] = React.useState(false);
  const [banning, setBanning] = React.useState(false);
  const [confirmingUnban, setConfirmingUnban] = React.useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = React.useState(false);
  const nextRole = data.role.includes('admin') ? 'member' : 'admin';

  const invalidate = () => queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });

  const roleMutation = useMutation({
    mutationFn: () => setUserRole({ data: { userId: data.id, role: nextRole } }),
    onSuccess: () => {
      toast.success('Role updated — the user is signed out everywhere so it applies immediately');
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to update role'),
    onSettled: () => setConfirmingRole(false)
  });

  const banMutation = useMutation({
    mutationFn: (values: { reason: string; duration: BanDuration }) =>
      banUser({
        data: {
          userId: data.id,
          reason: values.reason,
          banExpiresInSeconds: BAN_DURATION_SECONDS[values.duration]
        }
      }),
    onSuccess: () => {
      toast.success(`${data.email} banned and signed out everywhere`);
      invalidate();
      setBanning(false);
    },
    onError: (error) => toastError(error, 'Failed to ban user')
  });

  const unbanMutation = useMutation({
    mutationFn: () => unbanUser({ data: { userId: data.id } }),
    onSuccess: () => {
      toast.success(`${data.email} unbanned`);
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to unban user'),
    onSettled: () => setConfirmingUnban(false)
  });

  const signOutMutation = useMutation({
    mutationFn: () => signOutUserEverywhere({ data: { userId: data.id } }),
    onSuccess: () => toast.success(`${data.email} signed out everywhere`),
    onError: (error) => toastError(error, 'Failed to sign out user'),
    onSettled: () => setConfirmingSignOut(false)
  });

  const banForm = useAppForm({
    defaultValues: { reason: '', duration: 'permanent' as BanDuration },
    validators: { onSubmit: banFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await banMutation.mutateAsync(value);
      } catch {
        // Reported through banMutation.onError's toast.
      }
    }
  });

  return (
    <>
      <div className='flex items-center justify-end gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={isSelf}
          onClick={() => setConfirmingRole(true)}
        >
          {data.role.includes('admin') ? 'Demote to member' : 'Promote to admin'}
        </Button>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon-sm'>
              <span className='sr-only'>Open menu</span>
              <Icons.ellipsis className='h-4 w-4' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {data.banned ? (
              <DropdownMenuItem onClick={() => setConfirmingUnban(true)}>
                Unban user
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={isSelf} onClick={() => setBanning(true)}>
                Ban user
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setConfirmingSignOut(true)}>
              Sign out everywhere
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmingRole} onOpenChange={setConfirmingRole}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nextRole === 'admin' ? 'Promote' : 'Demote'} {data.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nextRole === 'admin'
                ? 'Admins can manage users, entities, connections, storage, and application settings across the installation.'
                : 'The user keeps ordinary member access to product data but loses all administrative capabilities. They are signed out everywhere so the change applies immediately.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={roleMutation.isPending}
              onClick={() => roleMutation.mutate()}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResponsiveDialog open={banning} onOpenChange={setBanning}>
        <ResponsiveDialogContent className='sm:max-w-[480px]'>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Ban {data.email}?</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Every existing session is revoked immediately — the user cannot sign in again until
              unbanned or the ban expires.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <form className='space-y-6' onSubmit={submitFormEvent(banForm.handleSubmit)}>
            <FieldGroup>
              <banForm.AppField
                name='reason'
                children={(field) => (
                  <field.TextField
                    label='Reason'
                    required
                    placeholder='Why is this user being banned?'
                  />
                )}
              />
              <banForm.AppField
                name='duration'
                children={(field) => (
                  <field.SelectField label='Duration' required options={BAN_DURATION_OPTIONS} />
                )}
              />
            </FieldGroup>
            <div className='flex justify-end gap-2'>
              <Button type='button' variant='outline' onClick={() => setBanning(false)}>
                Cancel
              </Button>
              <banForm.AppForm>
                <banForm.SubmitButton variant='destructive'>Ban user</banForm.SubmitButton>
              </banForm.AppForm>
            </div>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog open={confirmingUnban} onOpenChange={setConfirmingUnban}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unban {data.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores the user's ability to sign in through their normal method.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={unbanMutation.isPending}
              onClick={() => unbanMutation.mutate()}
            >
              Unban
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingSignOut} onOpenChange={setConfirmingSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out {data.email} everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              Revokes every active session for this user. Their role and ban state are unchanged —
              they can sign back in normally.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={signOutMutation.isPending}
              onClick={() => signOutMutation.mutate()}
            >
              Sign out everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
