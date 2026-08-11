import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { setUserRole, type UserDto } from '@/server/admin-functions';
import { firstAdminBootstrapQuery, usersQuery } from '@/features/settings/api/queries';

type RoleChange = { user: UserDto; role: 'admin' | 'member' };

/** First-admin bootstrap marker (ADR-0016) — read-only status badge. */
function BootstrapStatus() {
  const { data } = useQuery(firstAdminBootstrapQuery);
  if (!data) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>First-admin bootstrap</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-wrap items-center gap-3 text-sm'>
        {data.completed ? (
          <>
            <Badge variant='secondary'>completed</Badge>
            <span className='text-muted-foreground'>
              {data.email ?? 'unknown'}
              {data.completedAt
                ? ` — ${format(new Date(data.completedAt), 'yyyy-MM-dd HH:mm')}`
                : ''}
            </span>
          </>
        ) : (
          <>
            <Badge variant='outline'>pending</Badge>
            <span className='text-muted-foreground'>
              The first sign-in matching LOXEP_BOOTSTRAP_ADMIN_EMAIL receives the admin role.
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function UsersTable({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery(usersQuery);
  const [pendingChange, setPendingChange] = React.useState<RoleChange | null>(null);

  const roleMutation = useMutation({
    mutationFn: (change: RoleChange) =>
      setUserRole({ data: { userId: change.user.id, role: change.role } }),
    onSuccess: () => {
      toast.success('Role updated');
      queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
    },
    onError: (mutationError) => {
      toast.error(mutationError instanceof Error ? mutationError.message : 'Failed to update role');
    },
    onSettled: () => setPendingChange(null)
  });

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  if (isError) {
    return (
      <p className='text-destructive text-sm'>
        {error instanceof Error ? error.message : 'Failed to load users'}
      </p>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <BootstrapStatus />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className='text-right'>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((user) => (
            <TableRow key={user.id}>
              <TableCell className='font-medium'>{user.email}</TableCell>
              <TableCell className='text-muted-foreground'>{user.name || '—'}</TableCell>
              <TableCell>
                <div className='flex items-center gap-2'>
                  <Badge variant={user.role.includes('admin') ? 'default' : 'outline'}>
                    {user.role}
                  </Badge>
                  {user.banned && <Badge variant='destructive'>banned</Badge>}
                </div>
              </TableCell>
              <TableCell className='text-muted-foreground'>
                {format(new Date(user.createdAt), 'yyyy-MM-dd')}
              </TableCell>
              <TableCell className='text-right'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={user.id === currentUserId || roleMutation.isPending}
                  onClick={() =>
                    setPendingChange({
                      user,
                      role: user.role.includes('admin') ? 'member' : 'admin'
                    })
                  }
                >
                  {user.role.includes('admin') ? 'Demote to member' : 'Promote to admin'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => !open && setPendingChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingChange?.role === 'admin' ? 'Promote' : 'Demote'} {pendingChange?.user.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange?.role === 'admin'
                ? 'Admins can manage users, entities, connections, storage, and application settings across the installation.'
                : 'The user keeps ordinary member access to product data but loses all administrative capabilities.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={roleMutation.isPending}
              onClick={() => pendingChange && roleMutation.mutate(pendingChange)}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
