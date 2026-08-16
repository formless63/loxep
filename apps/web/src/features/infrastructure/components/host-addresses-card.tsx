import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatRelativeTime } from '@/lib/format';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  HOST_ADDRESS_FAMILY_OPTIONS,
  HOST_ADDRESS_KIND_LABELS,
  HOST_ADDRESS_KIND_OPTIONS,
  HOST_ADDRESS_KIND_TONE,
  hostAddressProvenanceLabel
} from '@/features/infrastructure/constants';
import { hostingTargetQuery } from '@/features/infrastructure/api/queries';
import {
  classifyHostingTargetAddress,
  declareHostingTargetAddress,
  removeHostingTargetAddress,
  setPrimaryHostingTargetAddress
} from '@/server/infrastructure-functions';
import type { HostAddressDto } from '@/server/infrastructure-functions';

const declareFormSchema = z.object({
  kind: z.enum(['wan', 'lan', 'tailnet', 'other']),
  family: z.enum(['v4', 'v6']),
  value: z.string().trim().min(1, 'An address is required'),
  isPrimary: z.boolean()
});

/**
 * "Declare address" — the ONLY affordance on this card that can write
 * `provenance = 'operator_declared'`, and therefore the only one that can
 * ever add to what the DNS materializer will read (loxep-bub, `kind = 'wan'`
 * rows here). Every other row on this card was written by an observer sync
 * (Tailscale, Dockhand) and stays observed no matter how it is classified —
 * see `classifyHostingTargetAddress` below.
 */
function DeclareAddressDialog({
  open,
  onOpenChange,
  hostingTargetId,
  hostingTargetName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostingTargetId: string;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof declareFormSchema>) =>
      declareHostingTargetAddress({
        data: { hostingTargetId, ...values, value: values.value.trim() }
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to declare address')
  });

  const form = useAppForm({
    defaultValues: {
      kind: 'wan',
      family: 'v4',
      value: '',
      isPrimary: false
    } as z.infer<typeof declareFormSchema>,
    validators: { onSubmit: declareFormSchema },
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
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>Declare address</DialogTitle>
          <DialogDescription>
            Only a declared WAN address ever reaches the DNS materializer. LAN and tailnet addresses
            are for the record — never published.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='kind'
              children={(field) => (
                <field.SelectField label='Kind' required options={HOST_ADDRESS_KIND_OPTIONS} />
              )}
            />
            <form.AppField
              name='family'
              children={(field) => (
                <field.SelectField label='Family' required options={HOST_ADDRESS_FAMILY_OPTIONS} />
              )}
            />
            <form.AppField
              name='value'
              children={(field) => (
                <field.TextField label='Address' required placeholder='e.g. 203.0.113.10' />
              )}
            />
            <form.AppField
              name='isPrimary'
              children={(field) => (
                <field.SwitchField
                  label='Primary'
                  description='The address this kind/family uses when more than one is declared.'
                />
              )}
            />
          </FieldGroup>
          <Button type='submit' disabled={mutation.isPending} className='w-full'>
            Declare
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClassifySelect({
  address,
  hostingTargetName
}: {
  address: HostAddressDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (kind: 'wan' | 'lan' | 'tailnet' | 'other') =>
      classifyHostingTargetAddress({ data: { id: address.id, kind } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: hostingTargetQuery(hostingTargetName).queryKey }),
    onError: (error) => toastError(error, 'Failed to classify address')
  });

  return (
    <Select
      value={address.kind}
      onValueChange={(next) => {
        if (next !== address.kind) {
          mutation.mutate(next as 'wan' | 'lan' | 'tailnet' | 'other');
        }
      }}
      disabled={mutation.isPending}
    >
      <SelectTrigger size='sm' className='w-[110px]'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {HOST_ADDRESS_KIND_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RemoveAddressButton({
  address,
  hostingTargetName
}: {
  address: HostAddressDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const mutation = useMutation({
    mutationFn: () => removeHostingTargetAddress({ data: { id: address.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to remove address'),
    onSettled: () => setConfirming(false)
  });

  return (
    <>
      <Button
        size='icon-sm'
        variant='ghost'
        aria-label='Remove address'
        onClick={() => setConfirming(true)}
      >
        <Icons.trash />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this address?</AlertDialogTitle>
            <AlertDialogDescription>
              {address.kind === 'wan' && address.provenance === 'operator_declared'
                ? 'This is a declared WAN address — removing the last one leaves this target unaddressable unless it is fronted or set to "DNS only".'
                : 'This does not affect DNS materialization; only declared WAN addresses ever reach it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddressRow({
  address,
  hostingTargetName,
  showSetPrimary
}: {
  address: HostAddressDto;
  hostingTargetName: string;
  showSetPrimary: boolean;
}) {
  const queryClient = useQueryClient();
  const setPrimaryMutation = useMutation({
    mutationFn: () => setPrimaryHostingTargetAddress({ data: { id: address.id } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: hostingTargetQuery(hostingTargetName).queryKey }),
    onError: (error) => toastError(error, 'Failed to set primary address')
  });

  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border px-3 py-2'>
      <Badge variant={HOST_ADDRESS_KIND_TONE[address.kind] ?? 'secondary'}>
        {HOST_ADDRESS_KIND_LABELS[address.kind] ?? address.kind}
      </Badge>
      <span className='text-muted-foreground text-xs uppercase'>{address.family}</span>
      <span className='font-mono text-sm'>{address.value}</span>
      {address.isPrimary && <Badge variant='outline'>primary</Badge>}
      <Badge variant={address.provenance === 'operator_declared' ? 'secondary' : 'outline'}>
        {hostAddressProvenanceLabel(address.provenance)}
      </Badge>
      <span
        className='text-muted-foreground text-xs'
        title={address.observedAt ?? address.createdAt}
      >
        {address.observedAt
          ? `observed ${formatRelativeTime(address.observedAt)}`
          : `declared ${formatRelativeTime(address.createdAt)}`}
      </span>
      <div className='ml-auto flex items-center gap-1'>
        {showSetPrimary && !address.isPrimary && (
          <Button
            size='sm'
            variant='outline'
            disabled={setPrimaryMutation.isPending}
            onClick={() => setPrimaryMutation.mutate()}
          >
            Set primary
          </Button>
        )}
        <ClassifySelect address={address} hostingTargetName={hostingTargetName} />
        <RemoveAddressButton address={address} hostingTargetName={hostingTargetName} />
      </div>
    </div>
  );
}

/**
 * The typed multi-address card (loxep-bub) — every `host_addresses` row for
 * this target, WAN/LAN/tailnet/other alike, with its provenance and clock.
 * A durable home like `ProxyConnectionPanel`/`ContainerHostRegistrationPanel`
 * below it, not gated on any existing data: a target with zero addresses
 * still renders the card and its "Declare address" affordance.
 *
 * Write actions here call server functions gated `requireAdmin` — this
 * component renders them unconditionally, matching every other write
 * affordance on this page (`DecommissionButton`, `RollTokenButton`); a
 * non-admin's action fails server-side with a toast rather than being
 * hidden client-side.
 */
export default function HostAddressesCard({
  hostingTargetId,
  hostingTargetName,
  addresses
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  addresses: HostAddressDto[];
}) {
  const [declaring, setDeclaring] = React.useState(false);

  // "Set primary" only makes sense when more than one row shares a (kind,
  // family) slot — otherwise the lone row IS primary by definition, and the
  // button would just be noise.
  const slotCounts = new Map<string, number>();
  for (const address of addresses) {
    const key = `${address.kind}:${address.family}`;
    slotCounts.set(key, (slotCounts.get(key) ?? 0) + 1);
  }

  const grouped = React.useMemo(() => {
    const byKind = new Map<string, HostAddressDto[]>();
    for (const address of addresses) {
      const list = byKind.get(address.kind) ?? [];
      list.push(address);
      byKind.set(address.kind, list);
    }
    // A fresh array from `.entries()`, so mutating in place with `.sort()` is
    // safe — no shared reference to protect, unlike `.toSorted()`'s usual
    // reason for existing (this repo's `lib` target predates it).
    const entries = [...byKind.entries()];
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries;
  }, [addresses]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Addresses</CardTitle>
        <CardDescription>
          Every kind this target answers to — only a declared WAN row ever reaches DNS.
        </CardDescription>
        <CardAction>
          <Button size='sm' variant='outline' onClick={() => setDeclaring(true)}>
            Declare address
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {addresses.length === 0 ? (
          <p className='text-muted-foreground text-sm'>No addresses declared or observed yet.</p>
        ) : (
          grouped.map(([kind, rows]) => (
            <div key={kind} className='flex flex-col gap-2'>
              <p className='text-muted-foreground text-xs font-medium uppercase'>
                {HOST_ADDRESS_KIND_LABELS[kind] ?? kind} ({rows.length})
              </p>
              {rows.map((address) => (
                <AddressRow
                  key={address.id}
                  address={address}
                  hostingTargetName={hostingTargetName}
                  showSetPrimary={(slotCounts.get(`${address.kind}:${address.family}`) ?? 0) > 1}
                />
              ))}
            </div>
          ))
        )}
      </CardContent>
      <DeclareAddressDialog
        open={declaring}
        onOpenChange={setDeclaring}
        hostingTargetId={hostingTargetId}
        hostingTargetName={hostingTargetName}
      />
    </Card>
  );
}
