import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { integrationHealthQuery } from '@/features/settings/api/queries';
import type { ConnectionDto, JsonValue } from '@/server/admin-functions';

/**
 * Mirrors `packages/app/src/fleet.ts`'s `TERMIX_CONNECTION_PROVIDER`, not
 * imported: `@loxep/app` is a server-only package this client component
 * cannot cross, same convention `tailscale-expiry-cell.tsx`'s
 * `TAILSCALE_PROVIDER` and `order-sync-cell.tsx`'s provider constants use.
 */
export const TERMIX_PROVIDER = 'termix';

function readDetailObject(detail: JsonValue | undefined): Record<string, JsonValue> {
  return typeof detail === 'object' && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, JsonValue>)
    : {};
}

/**
 * Read-only credential state for the connections table's "Credentials"
 * column, Termix rows only — parallels `EbayCredentialStatus`/
 * `TailscaleCredentialExpiryCell`.
 *
 * Termix's `probe()` (loxep-tit, `@loxep/integration-termix`'s
 * `authRejectedStatus`) distinguishes two OPPOSITE operator problems that
 * `termixKindFromStatus` otherwise collapses into one `'auth'` kind: a 401
 * means the stored password is wrong or was changed, and a 403 means this
 * Termix instance has turned password sign-in off entirely (OIDC/SSO-only) —
 * no password edit here will ever fix that. `fleet-health.ts`'s
 * `probeTermixConnection` copies `authRejectedStatus` into
 * `integration_health.detail` only when it is 401 or 403 (never a body,
 * header, or provider message), so this cell reads it from the SAME
 * `integrationHealthQuery` `/settings/overview` uses — react-query dedupes
 * the request rather than issuing a second one. When the connection has no
 * matching health row yet, or the row's `detail.kind` is not `'auth'`, this
 * falls back to the same generic credential-badge list `columns.tsx`'s
 * default branch renders for every other provider.
 */
export function TermixAuthStatusCell({ connection }: { connection: ConnectionDto }) {
  const { data } = useQuery(integrationHealthQuery);
  const healthRow = data?.find(
    (row) => row.subjectType === 'connection' && row.subjectId === connection.id
  );
  const detail = readDetailObject(healthRow?.detail);

  if (detail['kind'] === 'auth') {
    const authRejectedStatus = detail['authRejectedStatus'];
    if (authRejectedStatus === 403) {
      return (
        <ToneBadge
          tone='destructive'
          title='This Termix instance has disabled password sign-in (OIDC/SSO-only). No password change here will fix this — it needs a machine credential from Termix, or password authentication re-enabled on the instance.'
        >
          password auth disabled
        </ToneBadge>
      );
    }
    if (authRejectedStatus === 401) {
      return (
        <ToneBadge tone='destructive' title='Termix rejected the stored password.'>
          wrong password
        </ToneBadge>
      );
    }
    return (
      <ToneBadge
        tone='destructive'
        title="Termix rejected the stored credential. This may be a wrong password, or this instance may have password authentication disabled — check Termix's own sign-in page to tell which."
      >
        credential rejected
      </ToneBadge>
    );
  }

  if (connection.credentials.length === 0) {
    return <span className='text-muted-foreground'>none</span>;
  }
  return (
    <div className='flex flex-wrap gap-1'>
      {connection.credentials.map((credential) => (
        <Badge key={credential.credentialType} variant='outline'>
          {credential.credentialType} v{credential.currentVersion}
        </Badge>
      ))}
    </div>
  );
}
