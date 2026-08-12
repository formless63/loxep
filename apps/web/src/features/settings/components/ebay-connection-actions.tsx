import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  DEFAULT_EBAY_CONSENT_TIER,
  EBAY_CONSENT_TIER_LABELS,
  EBAY_OAUTH_CREDENTIAL_TYPE,
  ebayConsentTierForScopes,
  ebayGrantedScopes,
  ebayRequestedConsentTier,
  startEbayConsent,
  validateEbayConnection,
  type EbayConsentTier
} from '@/server/ebay-oauth';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { connectionsQuery } from '@/features/settings/api/queries';
import type { ConnectionDto } from '@/server/admin-functions';

/** The `ebay_oauth` credential (registered purpose `oauth_tokens`), if any. */
function ebayOAuthCredential(connection: ConnectionDto) {
  return connection.credentials.find(
    (credential) => credential.credentialType === EBAY_OAUTH_CREDENTIAL_TYPE
  );
}

/**
 * The tier a connection actually HOLDS, derived from the scopes recorded on
 * `config.ebayOAuth` — `null` when there is no consent yet. Scopes are the
 * stored fact; the tier is a reading of them, never a second stored copy.
 */
function grantedConsentTier(connection: ConnectionDto): EbayConsentTier | null {
  const scopes = ebayGrantedScopes(connection.config);
  return scopes === null ? null : ebayConsentTierForScopes(scopes);
}

/**
 * The tier a consent restart should ask for: keep what the connection already
 * holds (a "Reconnect" must not silently narrow an orders connection back to
 * watchlist), else honour a consent that was started but never completed,
 * else the narrow default.
 */
function tierToReRequest(connection: ConnectionDto): EbayConsentTier {
  return (
    grantedConsentTier(connection) ??
    ebayRequestedConsentTier(connection.config) ??
    DEFAULT_EBAY_CONSENT_TIER
  );
}

/**
 * Member-readable — every field here already comes from the member-readable
 * `fetchConnections`. Two facts, not one: whether an eBay account is bound at
 * all, and which consent TIER that binding carries (loxep-ld0). The tier is
 * what decides whether order ingestion can run, so it is stated rather than
 * left to be inferred from a failed sync.
 */
export function EbayCredentialStatus({ connection }: { connection: ConnectionDto }) {
  const credential = ebayOAuthCredential(connection);
  if (!credential) {
    const pending = ebayRequestedConsentTier(connection.config);
    return (
      <div className='flex flex-col items-start gap-0.5'>
        <Badge variant='outline'>No eBay account</Badge>
        {pending !== null && (
          <span className='text-muted-foreground text-xs'>
            consent started for {EBAY_CONSENT_TIER_LABELS[pending].toLowerCase()}
          </span>
        )}
      </div>
    );
  }
  const tier = grantedConsentTier(connection) ?? DEFAULT_EBAY_CONSENT_TIER;
  return (
    <div className='flex flex-col items-start gap-0.5'>
      <Badge variant='secondary'>eBay account connected</Badge>
      <ToneBadge tone={tier === 'orders' ? 'success' : 'outline'} className='normal-case'>
        {EBAY_CONSENT_TIER_LABELS[tier]}
      </ToneBadge>
      <span className='text-muted-foreground text-xs'>
        expires {formatDateTime(credential.expiresAt)}
      </span>
    </div>
  );
}

/**
 * Admin-only per-connection eBay actions (loxep-62y.5, loxep-ld0): "Connect"
 * starts consent and does a FULL top-level navigation to the returned URL —
 * the CSRF nonce lives in a same-browser httpOnly cookie
 * (`startEbayConsent`/`EBAY_CONSENT_NONCE_COOKIE` doc in
 * `@/server/ebay-oauth`), which only a real top-level navigation carries
 * through eBay's redirect back to the callback; an XHR/fetch redirect would
 * not. "Grant order access" is the SAME flow at the wider tier: eBay has no
 * incremental-consent grant, so widening access is a fresh consent that
 * replaces the stored token — which is also why it is offered only on a
 * connection that does not already hold the orders tier. "Validate" runs a
 * cheap authenticated call server-side and reports the result inline — see
 * `validateEbayConnection`'s doc for what it calls.
 */
export function EbayConnectionActions({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();
  const credential = ebayOAuthCredential(connection);
  const grantedTier = grantedConsentTier(connection);

  const connectMutation = useMutation({
    mutationFn: (tier: EbayConsentTier) =>
      startEbayConsent({ data: { connectionId: connection.id, tier } }),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (error) => toastError(error, 'Failed to start eBay consent')
  });

  const validateMutation = useMutation({
    mutationFn: () => validateEbayConnection({ data: { connectionId: connection.id } }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    },
    onError: (error) => toastError(error, 'eBay validation failed')
  });

  return (
    <div className='flex justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={connectMutation.isPending}
        onClick={() => connectMutation.mutate(tierToReRequest(connection))}
      >
        {credential ? 'Reconnect' : 'Connect'}
      </Button>
      {grantedTier === 'watchlist' && (
        <Button
          size='sm'
          variant='outline'
          disabled={connectMutation.isPending}
          onClick={() => connectMutation.mutate('orders')}
          title='Re-runs eBay consent asking for read-only order history as well.'
        >
          Grant order access
        </Button>
      )}
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
