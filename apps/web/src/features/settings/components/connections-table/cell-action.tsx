import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import {
  archiveConnection,
  deleteConnection,
  setConnectionStatus,
  unarchiveConnection,
  type ConnectionDto,
  type ConnectionReferenceDto
} from '@/server/admin-functions';
import { disableOrderSync, enableOrderSync } from '@/server/order-sync-functions';
import { disablePurchaseSync, enablePurchaseSync } from '@/server/purchase-sync-functions';
import { connectionsQuery } from '@/features/settings/api/queries';
import { EbayConnectionActions } from '@/features/settings/components/ebay-connection-actions';
import { isOrderSyncEligible, supportsOrderSync } from './order-sync-cell';
import { isPurchaseSyncEligible, supportsPurchaseSync } from './purchase-sync-cell';

const EBAY_PROVIDER = 'ebay';

/**
 * Row actions for one account (loxep-o7h).
 *
 * Removal has two outcomes and the DATA decides which: an account nothing
 * references is deleted outright (credentials included), while an account
 * with orders, observations, monitors, or provenance behind it is archived so
 * none of that history breaks. The delete is attempted first and the server
 * either performs it or refuses with per-table counts — this component then
 * shows those counts and offers Archive, rather than pre-judging the answer
 * in the browser or silently doing something the operator did not ask for.
 *
 * Every mutation is row-scoped (its own `useMutation`) so one row's in-flight
 * request never disables another row's buttons.
 */
export function CellAction({ data }: { data: ConnectionDto }) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [blocking, setBlocking] = useState<ConnectionReferenceDto[] | null>(null);
  const archived = data.status === 'archived';

  const invalidate = () => queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });

  const statusMutation = useMutation({
    mutationFn: (status: 'active' | 'disabled') =>
      setConnectionStatus({ data: { id: data.id, status } }),
    onSuccess: () => {
      toast.success('Account status updated');
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to update status')
  });

  const archiveMutation = useMutation({
    mutationFn: (action: 'archive' | 'unarchive') =>
      action === 'archive'
        ? archiveConnection({ data: { id: data.id } })
        : unarchiveConnection({ data: { id: data.id } }),
    onSuccess: (result) => {
      setBlocking(null);
      toast.success(
        result.status === 'archived'
          ? 'Account archived — its history is kept and it is skipped everywhere'
          : 'Account restored as disabled — enable it when you want it polling again'
      );
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to archive account')
  });

  const orderSyncEnabled = data.orderSync?.enabled ?? false;
  const orderSyncMutation = useMutation({
    mutationFn: (action: 'enable' | 'disable') =>
      action === 'enable'
        ? enableOrderSync({ data: { connectionId: data.id } })
        : disableOrderSync({ data: { connectionId: data.id } }),
    onSuccess: (result) => {
      toast.success(result.enabled ? 'Order sync enabled' : 'Order sync disabled');
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to update order sync')
  });

  const purchaseSyncEnabled = data.purchaseSync?.enabled ?? false;
  const purchaseSyncMutation = useMutation({
    mutationFn: (action: 'enable' | 'disable') =>
      action === 'enable'
        ? enablePurchaseSync({ data: { connectionId: data.id } })
        : disablePurchaseSync({ data: { connectionId: data.id } }),
    onSuccess: (result) => {
      toast.success(result.enabled ? 'Purchase sync enabled' : 'Purchase sync disabled');
      invalidate();
    },
    onError: (error) => toastError(error, 'Failed to update purchase sync')
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteConnection({ data: { id: data.id } }),
    onSuccess: (result) => {
      setConfirmingDelete(false);
      if (result.deleted) {
        toast.success('Account and its stored credentials deleted');
        invalidate();
        return;
      }
      // Refusal is an expected outcome, not an error: show what is in the way.
      setBlocking(result.references);
    },
    onError: (error) => toastError(error, 'Failed to delete account')
  });

  return (
    <div className='flex items-center justify-end gap-2'>
      {data.provider === EBAY_PROVIDER && !archived && <EbayConnectionActions connection={data} />}
      {!archived && (
        <Button
          size='sm'
          variant='outline'
          disabled={statusMutation.isPending}
          onClick={() => statusMutation.mutate(data.status === 'disabled' ? 'active' : 'disabled')}
        >
          {data.status === 'disabled' ? 'Enable' : 'Disable'}
        </Button>
      )}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' className='h-8 w-8 p-0'>
            <span className='sr-only'>Open menu</span>
            <Icons.ellipsis className='h-4 w-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Account</DropdownMenuLabel>
          </DropdownMenuGroup>
          {archived ? (
            <DropdownMenuItem
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate('unarchive')}
            >
              <Icons.eye className='mr-2 h-4 w-4' /> Unarchive
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate('archive')}
            >
              <Icons.eyeOff className='mr-2 h-4 w-4' /> Archive
            </DropdownMenuItem>
          )}
          {!archived &&
            supportsOrderSync(data) &&
            (isOrderSyncEligible(data) || orderSyncEnabled) && (
              <DropdownMenuItem
                disabled={orderSyncMutation.isPending}
                onClick={() => orderSyncMutation.mutate(orderSyncEnabled ? 'disable' : 'enable')}
              >
                {orderSyncEnabled ? (
                  <>
                    <Icons.slash className='mr-2 h-4 w-4' /> Disable order sync
                  </>
                ) : (
                  <>
                    <Icons.integrations className='mr-2 h-4 w-4' /> Enable order sync
                  </>
                )}
              </DropdownMenuItem>
            )}
          {!archived &&
            supportsPurchaseSync(data) &&
            (isPurchaseSyncEligible(data) || purchaseSyncEnabled) && (
              <DropdownMenuItem
                disabled={purchaseSyncMutation.isPending}
                onClick={() =>
                  purchaseSyncMutation.mutate(purchaseSyncEnabled ? 'disable' : 'enable')
                }
              >
                {purchaseSyncEnabled ? (
                  <>
                    <Icons.slash className='mr-2 h-4 w-4' /> Disable purchase sync
                  </>
                ) : (
                  <>
                    <Icons.integrations className='mr-2 h-4 w-4' /> Enable purchase sync
                  </>
                )}
              </DropdownMenuItem>
            )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConfirmingDelete(true)}>
            <Icons.trash className='mr-2 h-4 w-4' /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {data.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account and every credential stored for it. It only
              succeeds when nothing references the account — if orders, observations, monitors, or
              provenance records point at it, the deletion is refused and archiving is offered
              instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                // Keep the dialog up until the server answers: the answer may
                // be a refusal that this row has to explain.
                event.preventDefault();
                deleteMutation.mutate();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blocking !== null} onOpenChange={(open) => !open && setBlocking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{data.name} still has data</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting the account would break records that reference it, so it was not deleted.
              Archive it instead: nothing is removed, and the account stops appearing in pickers,
              polling, and token refresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className='text-muted-foreground space-y-1 text-sm'>
            {(blocking ?? []).map((reference) => (
              <li key={reference.table} className='flex justify-between gap-4'>
                <span className='capitalize'>{reference.label}</span>
                <span className='text-foreground tabular-nums'>{reference.count}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                archiveMutation.mutate('archive');
              }}
            >
              Archive instead
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
