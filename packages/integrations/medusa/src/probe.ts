/**
 * Connection probe: "can this secret API key read this Medusa backend?"
 *
 * LIVE-VERIFIED against Medusa 2.18.0 (loxep-xh9.4.1): the probe call
 * returns `ok: true` with `visibleOrderCount` taken from the body's `count`,
 * and a fabricated `sk_…` key yields `ok: false` with `kind: "auth"`.
 *
 * ONE strategy, unlike the WooCommerce adapter's two. WooCommerce needs a
 * fallback because a key pair's readable endpoints depend on the WordPress
 * ROLE of the user that issued it (`manage_woocommerce` vs a lesser role).
 * Nothing found in the Medusa source reviewed for this package (see
 * `config.ts`/`orders.ts` for the citation trail), and nothing observed
 * live, suggests a Medusa secret API key can be scoped narrower than the
 * admin `user` it authenticates as
 * (https://github.com/medusajs/medusa/blob/develop/packages/core/framework/src/http/middlewares/authenticate-middleware.ts
 * treats a valid API key as `actor_type: "api-key"` with no further scope
 * check before handing the request to the same route handlers a
 * session/JWT-authenticated user would reach). There is therefore no
 * graceful-degradation case to build here — a single minimal authenticated
 * call either succeeds or it does not.
 *
 * `GET /admin/orders?limit=1&fields=id,status` is the cheapest call this
 * adapter has a documented shape for: it is read-only, requests only two
 * scalar fields (no address/PII fields reachable even by accident), and its
 * response `count` doubles as a free "how many orders does this backend
 * have" diagnostic — the same idea as the WooCommerce probe's
 * `visibleOrderCount`.
 *
 * `ok: false` is returned — not thrown — when the call fails, carrying the
 * normalized taxonomy `kind`, matching `WooProbeResult`'s contract: a probe
 * is a diagnostic, and an integration health surface wants "auth" or
 * "provider_unavailable" as data, not as a stack unwind.
 */
import type { MedusaAdapter } from "./adapter.ts";
import {
  MedusaAdapterError,
  normalizeMedusaError,
  type MedusaErrorKind,
} from "./errors.ts";

export interface MedusaProbeResult {
  ok: boolean;
  /** Backend root the probe used. */
  baseUrl: string;
  /** `X-...`-free: Medusa's `orders.count` from the probe call, when it ran. */
  visibleOrderCount: number | null;
  /** Present only when `ok` is false. Message is the adapter's sanitized one. */
  error?: { kind: MedusaErrorKind; message: string };
}

export async function probeConnection(
  adapter: MedusaAdapter,
): Promise<MedusaProbeResult> {
  const base = { baseUrl: adapter.baseUrl };

  try {
    const result = await adapter.list(
      "/orders",
      "orders",
      { limit: 1, fields: "id,status" },
      { operation: "probe.orders" },
    );
    return {
      ok: true,
      ...base,
      visibleOrderCount: result.page.count,
    };
  } catch (error) {
    const normalized =
      error instanceof MedusaAdapterError
        ? error
        : normalizeMedusaError(error, {
            operation: "probe.orders",
            path: "/admin/orders",
          });
    return {
      ok: false,
      ...base,
      visibleOrderCount: null,
      error: { kind: normalized.kind, message: normalized.message },
    };
  }
}
