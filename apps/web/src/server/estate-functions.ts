/**
 * Server functions for the estate-browser SHELL (loxep-47o.1) — the machinery
 * every `/<workspace>/estate/$connectionId` page shares, extracted from
 * `pangolin-estate-functions.ts` (`loxep-pq2`) and generalized per
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md`.
 *
 * {@link fetchEstateConnectionSummary} is the ONE read every estate page
 * needs before it can even pick which provider's sections to render — Rule
 * P1 requires the provider be read from the connection row, never encoded in
 * the URL. This is a database read only (`connections.getConnection` +
 * the `provider_write_policy` setting), never a provider call, so it never
 * counts against Rule P7's per-provider call budget.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { WRITE_POLICY_ENFORCED_PROVIDERS } from '@/features/settings/constants';
import type { ConnectionStatus, ProviderWritePolicyTier } from '@loxep/domain';

function iso(date: Date): string {
  return date.toISOString();
}

export interface EstateWritePolicySummaryDto {
  /** Whether `WRITE_POLICY_ENFORCED_PROVIDERS` checks this provider at all — a provider absent from it has no gate to render a tier for. */
  enforced: boolean;
  /** Present only when `enforced` — the connection's stored tier, `'read_only'` fallback already applied. */
  tier: ProviderWritePolicyTier | null;
}

export interface EstateConnectionSummaryDto {
  id: string;
  name: string;
  provider: string;
  status: ConnectionStatus;
  externalAccountId: string | null;
  externalAccountName: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  writePolicy: EstateWritePolicySummaryDto;
}

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/**
 * The header block every estate page renders BEFORE it knows which
 * provider's sections to mount: connection identity, health (with ITS OWN
 * clock — Rule P4), and the write-policy tier (or "not enforced for this
 * provider"). Member-readable (`requireSession`): this is visibility, not
 * control, matching every other estate read.
 */
export const fetchEstateConnectionSummary = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateConnectionSummaryDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { connections, settings } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    const enforced = WRITE_POLICY_ENFORCED_PROVIDERS.has(connection.provider);
    let tier: ProviderWritePolicyTier | null = null;
    if (enforced) {
      const { providerWritePolicySetting, resolveProviderWritePolicy } =
        await import('@loxep/domain');
      const policies = await settings.get(providerWritePolicySetting);
      tier = resolveProviderWritePolicy(policies, connection.id);
    }

    return {
      id: connection.id,
      name: connection.name,
      provider: connection.provider,
      status: connection.status,
      externalAccountId: connection.externalAccountId,
      externalAccountName: connection.externalAccountName,
      lastSuccessAt: connection.lastSuccessAt === null ? null : iso(connection.lastSuccessAt),
      lastErrorAt: connection.lastErrorAt === null ? null : iso(connection.lastErrorAt),
      lastErrorCode: connection.lastErrorCode,
      writePolicy: { enforced, tier }
    };
  });
