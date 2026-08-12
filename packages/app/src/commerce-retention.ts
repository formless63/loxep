/**
 * The ADR-0021 redaction seam, bound (loxep-xh9.9).
 *
 * `@loxep/commerce` owns the retention SWEEP — the policy read, the eligible
 * query, the bounded batching, the at-least-once guard — but deliberately does
 * not know what any provider's redacted payload looks like. That is an
 * integration-boundary fact, so it is injected from here, exactly as
 * `commerce-ebay.ts` injects the eBay order pager and for exactly the same
 * reason: this module is the only place in the wiring that imports an order
 * adapter's redaction helper.
 *
 * ```text
 * commerce.redact-order-payloads (cron, daily)
 *   → runOrderPayloadRedactionSweep
 *       → read commerce.order_payload_retention        ← the gate
 *       → select order-class provider_objects,
 *         redacted_at is null, fetched_at < cutoff
 *       → THIS MAP[object_type](payload)               ← the seam
 *       → update payload + redacted_at (guarded)
 * ```
 *
 * ## What each redactor actually does
 *
 * Every order adapter ships a `redact*OrderFact` helper whose contract is
 * "everything about the fact EXCEPT `raw`". The stored payload IS that `raw`,
 * so redacting it means mapping the stored payload back through the adapter's
 * pure `map*Order` function and keeping the fact instead:
 *
 * ```text
 * stored payload  →  mapWooOrder  →  WooOrderFact  →  redactWooOrderFact
 *   (buyer name, address, email, phone, IP, user agent, …)
 *                                                   ↓
 *                                  { totals, lines, fees, refunds, statuses,
 *                                    buyerExternalId, …, raw: "[redacted]" }
 * ```
 *
 * The result is strictly more useful than an empty object and strictly less
 * dangerous than the original: order economics, line items, statuses, and
 * timestamps survive for replay and debugging, while every personal-data field
 * lived only inside `raw` and is gone. Both helpers are pure, synchronous, and
 * make no provider call — a maintenance sweep must never depend on a
 * connection still existing or its credentials still decrypting.
 *
 * ## `sourceAccountKey` is deliberately not reconstructed
 *
 * `mapWooOrder` and `mapEbayOrder` need an account-scope fallback for the
 * `sourceAccountKey` field of the fact they build, and the sweep has no
 * business resolving a store URL or seller id months after the fact (that
 * would mean a provider call, or a join, for a field that is not the reason
 * the sweep exists). The authoritative value lives on `orders.source_account_key`
 * and is untouched by redaction, so these placeholders name themselves as
 * placeholders rather than fabricating a plausible-looking key. eBay prefers
 * the payload's own `sellerId` and only falls back when the payload has none.
 *
 * ## Already-redacted input is a no-op
 *
 * {@link OrderPayloadRedactor}'s contract requires totality on the redactor's
 * own output. The sweep's `redacted_at is null` guard means a redacted payload
 * should never arrive here, but a redactor that would throw on its own output
 * turns that "should" into an outage, so both branches short-circuit on the
 * `raw: "[redacted]"` marker the helpers stamp.
 */
import {
  EBAY_ORDER_OBJECT_TYPE,
  WOO_ORDER_OBJECT_TYPE,
} from "@loxep/commerce";
import type { OrderPayloadRedactors } from "@loxep/commerce";
import { mapEbayOrder, redactEbayOrderFact } from "@loxep/integration-ebay";
import { mapWooOrder, redactWooOrderFact } from "@loxep/integration-woo";

/** The marker every `redact*OrderFact` helper stamps in place of `raw`. */
const REDACTED_MARKER = "[redacted]";

/**
 * Account-scope placeholders. See the module doc — these are intentionally not
 * plausible account keys, because the sweep does not know the real one and
 * `orders.source_account_key` already does.
 */
const WOO_REDACTED_SOURCE_ACCOUNT_KEY = "woocommerce:redacted";
const EBAY_REDACTED_SOURCE_ACCOUNT_KEY = "ebay:redacted";

function alreadyRedacted(payload: Record<string, unknown>): boolean {
  return payload["raw"] === REDACTED_MARKER;
}

/**
 * The `object_type` → redactor map for every order class this composition can
 * both ingest and redact.
 *
 * A provider missing from this map is not silently skipped: the sweep counts
 * its eligible rows and logs them as `unhandled`, which is the ADR-0021
 * requirement that every adapter gaining order ingestion ships a redaction
 * helper as part of that work.
 *
 * Medusa is absent for a benign reason and is worth stating explicitly:
 * `@loxep/integration-medusa` DOES ship `redactMedusaOrderFact`, but no Medusa
 * order ingestion exists in `@loxep/commerce` yet — there is no
 * `medusa.order` object type, so no such row is ever written and there is
 * nothing to redact. Wiring it belongs with the Medusa order-ingestion work,
 * which is also when `ORDER_PROVIDER_OBJECT_TYPES` gains its type.
 */
export function createOrderPayloadRedactors(): OrderPayloadRedactors {
  return {
    [WOO_ORDER_OBJECT_TYPE]: (payload) => {
      if (alreadyRedacted(payload)) return payload;
      return redactWooOrderFact(
        mapWooOrder(payload, {
          sourceAccountKey: WOO_REDACTED_SOURCE_ACCOUNT_KEY,
        }),
      ) as unknown as Record<string, unknown>;
    },
    [EBAY_ORDER_OBJECT_TYPE]: (payload) => {
      if (alreadyRedacted(payload)) return payload;
      return redactEbayOrderFact(
        mapEbayOrder(payload, {
          fallbackSourceAccountKey: EBAY_REDACTED_SOURCE_ACCOUNT_KEY,
        }),
      ) as unknown as Record<string, unknown>;
    },
  };
}
