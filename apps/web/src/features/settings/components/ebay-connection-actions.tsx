import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  EBAY_OAUTH_CREDENTIAL_TYPE,
  startEbayConsent,
  validateEbayConnection
} from '@/server/ebay-oauth';
import { connectionsQuery } from '@/features/settings/api/queries';
import type { ConnectionDto } from '@/server/admin-functions';

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

/** The `ebay_oauth` credential (registered purpose `oauth_tokens`), if any. */
function ebayOAuthCredential(connection: ConnectionDto) {
  return connection.credentials.find(
    (credential) => credential.credentialType === EBAY_OAUTH_CREDENTIAL_TYPE
  );
}

/** Member-readable — every field here already comes from the member-readable `fetchConnections`. */
export function EbayCredentialStatus({ connection }: { connection: ConnectionDto }) {
  const credential = ebayOAuthCredential(connection);
  if (!credential) {
    return <Badge variant='outline'>No eBay account</Badge>;
  }
  return (
    <div className='flex flex-col gap-0.5'>
      <Badge variant='secondary'>eBay account connected</Badge>
      <span className='text-muted-foreground text-xs'>
        expires {formatTimestamp(credential.expiresAt)}
      </span>
    </div>
  );
}

/**
 * Admin-only per-connection eBay actions (loxep-62y.5): "Connect" starts
 * consent and does a FULL top-level navigation to the returned URL — the
 * CSRF nonce lives in a same-browser httpOnly cookie
 * (`startEbayConsent`/`EBAY_CONSENT_NONCE_COOKIE` doc in
 * `@/server/ebay-oauth`), which only a real top-level navigation carries
 * through eBay's redirect back to the callback; an XHR/fetch redirect would
 * not. "Validate" runs a cheap authenticated call server-side and reports
 * the result inline — see `validateEbayConnection`'s doc for what it calls.
 */
export function EbayConnectionActions({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    mutationFn: () => startEbayConsent({ data: { connectionId: connection.id } }),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start eBay consent');
    }
  });

  const validateMutation = useMutation({
    mutationFn: () => validateEbayConnection({ data: { connectionId: connection.id } }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'eBay validation failed');
    }
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={connectMutation.isPending}
        onClick={() => connectMutation.mutate()}
      >
        {ebayOAuthCredential(connection) ? 'Reconnect' : 'Connect'}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={validateMutation.isPending}
        onClick={() => validateMutation.mutate()}
      >
        Validate
      </Button>
    </div>
  );
}
