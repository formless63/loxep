/**
 * Record a Tailscale API-access-token's expiry (loxep-50t §2.2b carryover).
 *
 * `connections.config.tailscale.credentialMode`/`credentialExpiresAt` are
 * written today only at connection-creation time (`createStoreConnection`
 * in `@/server/admin-functions`) — once an `api_access_token`-mode
 * connection exists, an operator had no way to record or correct that date
 * without recreating the connection from scratch. This module adds exactly
 * that one write, through `getAdminServices().connections.updateConnection`
 * — the same `ConnectionsService` `@/server/admin-functions` already uses,
 * reached the same dynamic-import way `@/server/order-sync-functions`
 * reaches it. That is deliberate: this bead's write fence keeps
 * `apps/web/src/server/admin-functions.ts` to one unrelated `inArray` line
 * (medusa order-sync wiring), so the mutation lives here instead, beside the
 * `connections-table/**` components that are its only caller.
 *
 * `updateConnection`'s `config` patch is a FULL REPLACE, not a merge
 * (`packages/domain/src/connections.ts`), so the handler reads the
 * connection's current config and only overwrites the one nested
 * `tailscale.credentialExpiresAt` key — never touching `credentialMode` or
 * anything else already stored there.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const TAILSCALE_PROVIDER = 'tailscale';

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface TailscaleExpiryDto {
  credentialExpiresAt: string;
}

export const updateTailscaleCredentialExpiry = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      connectionId: z.uuid(),
      /** `YYYY-MM-DD` — mirrors `createStoreConnection`'s own `credentialExpiresAt`. */
      credentialExpiresAt: z.iso.date()
    })
  )
  .handler(async ({ data }): Promise<TailscaleExpiryDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    await requireAdmin();
    const { connections } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    if (connection.provider !== TAILSCALE_PROVIDER) {
      throw new Error('Credential expiry recording is only supported for Tailscale connections');
    }
    const tailscaleConfig = readObject(connection.config['tailscale']);
    if (tailscaleConfig['credentialMode'] !== 'api_access_token') {
      throw new Error(
        'Only an API-access-token Tailscale connection records an expiry — an OAuth client renews itself automatically'
      );
    }

    await connections.updateConnection(connection.id, {
      config: {
        ...connection.config,
        tailscale: { ...tailscaleConfig, credentialExpiresAt: data.credentialExpiresAt }
      }
    });

    return { credentialExpiresAt: data.credentialExpiresAt };
  });
