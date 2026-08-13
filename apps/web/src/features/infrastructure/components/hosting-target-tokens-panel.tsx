import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { hostingTargetQuery } from '@/features/infrastructure/api/queries';
import MintTokenDialog from '@/features/infrastructure/components/mint-token-dialog';
import RevealOnceDialog from '@/features/infrastructure/components/reveal-once-dialog';
import SetTokenZonesDialog from '@/features/infrastructure/components/set-token-zones-dialog';
import { rollDnsProviderToken } from '@/server/infrastructure-functions';
import type { DnsProviderTokenDto } from '@/server/infrastructure-functions';

/**
 * Rolling is styled DESTRUCTIVELY and kept apart from scope editing —
 * changing a token's zone scope needs no redeployment, but rolling changes
 * the value and requires touching every host it was pasted into. The design
 * is explicit that these must never be presented as neighbours.
 */
function RollTokenButton({
  token,
  hostingTargetName
}: {
  token: DnsProviderTokenDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const [revealed, setRevealed] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => rollDnsProviderToken({ data: { tokenId: token.id } }),
    onSuccess: async (result) => {
      setRevealed(result.value);
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to roll token'),
    onSettled: () => setConfirming(false)
  });

  return (
    <>
      <Button size='sm' variant='destructive' onClick={() => setConfirming(true)}>
        Roll
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll "{token.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This regenerates the token's value. Every host still using the old value stops working
              until it is updated — this is unlike a scope change, which takes effect with no
              redeployment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              Roll token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {revealed !== null && (
        <RevealOnceDialog
          open={revealed !== null}
          onOpenChange={(next) => {
            if (!next) setRevealed(null);
          }}
          title={`Token "${token.name}" rolled`}
          description={`For ${hostingTargetName}. Every host using the old value needs this one.`}
          value={revealed}
        />
      )}
    </>
  );
}

function TokenRow({
  token,
  hostingTargetName
}: {
  token: DnsProviderTokenDto;
  hostingTargetName: string;
}) {
  const [zonesOpen, setZonesOpen] = React.useState(false);

  return (
    <li className='flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between'>
      <div className='flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <span className='font-medium'>{token.name}</span>
          <Badge variant='outline'>{token.permissionScope}</Badge>
        </div>
        <p className='text-muted-foreground text-sm'>
          {token.domainIds.length} zone{token.domainIds.length === 1 ? '' : 's'}
          {token.policySyncedAt && ` · policy synced ${formatDateTime(token.policySyncedAt)}`}
          {token.lastRolledAt && ` · last rolled ${formatDateTime(token.lastRolledAt)}`}
        </p>
      </div>
      <div className='flex shrink-0 gap-2'>
        <Button size='sm' variant='outline' onClick={() => setZonesOpen(true)}>
          Edit scope
        </Button>
        <RollTokenButton token={token} hostingTargetName={hostingTargetName} />
      </div>
      {zonesOpen && (
        <SetTokenZonesDialog
          open={zonesOpen}
          onOpenChange={setZonesOpen}
          token={token}
          hostingTargetName={hostingTargetName}
        />
      )}
    </li>
  );
}

export default function HostingTargetTokensPanel({
  hostingTargetId,
  hostingTargetName,
  tokens
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  tokens: DnsProviderTokenDto[];
}) {
  const [mintOpen, setMintOpen] = React.useState(false);

  const mintButton = (
    <Button size='sm' onClick={() => setMintOpen(true)}>
      <Icons.add />
      Mint token
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>DNS tokens</CardTitle>
        <CardDescription>
          Narrow, per-host credentials this control plane has minted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tokens.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.lock />
              </EmptyMedia>
              <EmptyTitle>No tokens minted for this host</EmptyTitle>
              <EmptyDescription>
                Mint one to give a process on this host direct edit access to its own zones.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{mintButton}</EmptyContent>
          </Empty>
        ) : (
          <div className='flex flex-col gap-3'>
            <ul className='flex flex-col gap-2'>
              {tokens.map((token) => (
                <TokenRow key={token.id} token={token} hostingTargetName={hostingTargetName} />
              ))}
            </ul>
            <div>{mintButton}</div>
          </div>
        )}
      </CardContent>
      {mintOpen && (
        <MintTokenDialog
          open={mintOpen}
          onOpenChange={setMintOpen}
          hostingTargetId={hostingTargetId}
          hostingTargetName={hostingTargetName}
        />
      )}
    </Card>
  );
}
