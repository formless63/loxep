import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { toastError } from '@/lib/errors';
import {
  PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS,
  PROVIDER_WRITE_POLICY_TIER_LABELS,
  PROVIDER_WRITE_POLICY_TIER_VALUES,
  WRITE_POLICY_ENFORCED_PROVIDERS
} from '@/features/settings/constants';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { providerWritePolicyQuery } from '@/features/settings/api/queries';
import { setConnectionWritePolicy, type ConnectionDto } from '@/server/admin-functions';
import type { ProviderWritePolicyTier } from '@loxep/domain';

/**
 * Whether this connection's provider is one the write-authorization gate is
 * actually wired to check (Pangolin chain design M3, loxep-acj.3 —
 * Cloudflare's and Purelymail's reconcilers today; Pangolin's future apply
 * leg). Every other provider renders "not applicable" rather than a control
 * that would silently do nothing — the same honesty rule `disabledProviders`
 * badges already follow on this table.
 */
export function writePolicyEnforced(connection: ConnectionDto): boolean {
  return WRITE_POLICY_ENFORCED_PROVIDERS.has(connection.provider);
}

const TIER_TONE = {
  read_only: 'outline',
  additive: 'success',
  access_affecting: 'warning',
  lockout_class: 'destructive'
} satisfies Record<ProviderWritePolicyTier, Tone>;

/** A connection absent from the map is `'read_only'` — the setting's own default (`resolveProviderWritePolicy`'s server-side fallback, applied here identically). */
export function resolveWritePolicyTier(
  policies: Record<string, ProviderWritePolicyTier>,
  connectionId: string
): ProviderWritePolicyTier {
  return policies[connectionId] ?? 'read_only';
}

/**
 * Sort/toggle key for the write-policy column: least permissive first, so a
 * sort surfaces the connections most worth reviewing (anything above
 * read_only) at either end predictably.
 */
export function writePolicySortKey(
  policies: Record<string, ProviderWritePolicyTier>,
  connection: ConnectionDto
): string {
  if (!writePolicyEnforced(connection)) return '';
  return resolveWritePolicyTier(policies, connection.id);
}

/**
 * The connections table's "Write policy" column (Pangolin chain design M3).
 * `policies` is the whole `infrastructure.provider_write_policy` map,
 * fetched ONCE by the table container (`providerWritePolicyQuery`) and
 * passed down — the same shape `disabledProviders`/`catalogEnabledMap`
 * already use, so choosing a tier on one row never refetches or disturbs any
 * other row's control.
 *
 * Admin-only edit control, mirroring `AttributionCell`'s row-scoped
 * `Select`+mutation shape exactly. A non-admin sees a read-only badge; a
 * provider this gate does not check renders "not applicable" rather than a
 * control that cannot do anything.
 */
export function WritePolicyCell({
  connection,
  policies,
  isAdmin
}: {
  connection: ConnectionDto;
  policies: Record<string, ProviderWritePolicyTier>;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (tier: ProviderWritePolicyTier) =>
      setConnectionWritePolicy({ data: { connectionId: connection.id, tier } }),
    onSuccess: () => {
      toast.success('Write policy updated');
      queryClient.invalidateQueries({ queryKey: providerWritePolicyQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update write policy')
  });

  if (!writePolicyEnforced(connection)) {
    return <span className='text-muted-foreground'>—</span>;
  }

  const tier = resolveWritePolicyTier(policies, connection.id);

  if (!isAdmin) {
    return (
      <ToneBadge tone={TIER_TONE[tier]} title={PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS[tier]}>
        {PROVIDER_WRITE_POLICY_TIER_LABELS[tier]}
      </ToneBadge>
    );
  }

  return (
    <Select
      value={tier}
      onValueChange={(value) => mutation.mutate(value as ProviderWritePolicyTier)}
    >
      <SelectTrigger size='sm' className='min-w-44' disabled={mutation.isPending}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROVIDER_WRITE_POLICY_TIER_VALUES.map((value) => (
          <SelectItem
            key={value}
            value={value}
            title={PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS[value]}
          >
            {PROVIDER_WRITE_POLICY_TIER_LABELS[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
