/**
 * `CommerceOrderFact` — the Loxep-owned, PROVIDER-NEUTRAL order shape the
 * ingestion service persists.
 *
 * Every provider adapter produces its own fact type at the integration
 * boundary (`WooOrderFact`, and later eBay's and Medusa's). Those types stop
 * there (ADR-0009): a small translation function per provider maps them onto
 * this shape, and only this shape reaches the database. The payoff is that
 * ingestion, idempotency, attachment rewriting, attribution, and provenance
 * are written and tested exactly once, and adding eBay is a translator plus a
 * status table — not a second ingestion service.
 *
 * ## Amount discipline
 *
 * Every amount is a DECIMAL STRING (see `decimal.ts`). Amounts are
 * provider-reported facts stored positive as reported; `feeAmount` and
 * `refundedAmount` are MAGNITUDES of deductions, not negatives. Net proceeds
 * are computed by the read models and never stored.
 *
 * ## Instants
 *
 * ISO-8601 strings with an explicit zone. Adapters own the parsing quirks —
 * WooCommerce's `*_gmt` fields, for instance, omit the `Z` and the Woo adapter
 * appends it. A naive local-time string reaching this shape is a bug in the
 * adapter, not something this layer repairs.
 */
import type {
  FeeDirection,
  FeeScope,
} from "@loxep/db/schema";

/** One sold thing. */
export interface CommerceOrderLineFact {
  /** 1-based position within the order. */
  lineNumber: number;
  /**
   * Stable provider line identity where the provider has one. When present it
   * — not `lineNumber` — is the re-sync matching key, so a provider that
   * reorders its lines cannot make the ingestion service duplicate them.
   */
  externalLineId: string | null;
  externalItemId: string | null;
  externalVariationId: string | null;
  /** The SKU string the CHANNEL reported; evidence for the catalog match. */
  channelSku: string | null;
  title: string | null;
  quantity: string;
  unitPrice: string;
  lineSubtotal: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  refundedAmount: string;
  lineTotal: string;
}

/** One provider-reported fee attached to the order. */
export interface CommerceOrderFeeFact {
  externalFeeId: string | null;
  feeScope: FeeScope;
  /** Required when `feeScope === 'line'`; resolved to an `order_lines.id`. */
  lineNumber: number | null;
  /** See `FEE_DIRECTIONS` — `buyer_surcharge` is never a deduction. */
  feeDirection: FeeDirection;
  feeType: string;
  providerFeeCode: string | null;
  description: string | null;
  currency: string;
  amount: string;
  chargedAt: string | null;
}

/** Which line a refund touched, when the provider says. */
export interface CommerceOrderRefundLineFact {
  /** Null for an order-level refund that names no line. */
  lineNumber: number | null;
  quantity: string | null;
  amount: string;
}

/** Money returned to the buyer. Positive. */
export interface CommerceOrderRefundFact {
  externalRefundId: string | null;
  kind: string;
  status: string;
  reasonCode: string | null;
  currency: string;
  amount: string;
  refundedAt: string | null;
  lines: readonly CommerceOrderRefundLineFact[];
}

/** Per-line shipped quantity within one channel-reported fulfillment. */
export interface CommerceOrderFulfillmentLineFact {
  lineNumber: number;
  quantity: string;
}

/** What the channel said was shipped. Not a carrier shipment (Phase 4). */
export interface CommerceOrderFulfillmentFact {
  externalFulfillmentId: string | null;
  status: string;
  carrierCode: string | null;
  carrierName: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  /** ISO-3166-1 alpha-2. Not meaningfully personal data; the rest of the
   *  address stays in the retained provider payload. */
  destinationCountry: string | null;
  destinationRegion: string | null;
  lines: readonly CommerceOrderFulfillmentLineFact[];
}

/** One normalized sale, ready to persist. */
export interface CommerceOrderFact {
  /** Adapter family: `woocommerce`, `ebay`, `medusa`. */
  provider: string;
  /** The selling surface as Loxep names it for cross-channel reporting. */
  channel: string;
  /** The provider's sub-market where one exists; null for single-market stores. */
  marketplace: string | null;
  /** Adapter-computed account scope; a fact, never a constraint. */
  sourceAccountKey: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  /** The provider's own status string, verbatim. */
  providerStatusRaw: string | null;
  /** ISO-4217. */
  currency: string;
  subtotalAmount: string;
  shippingAmount: string;
  discountAmount: string;
  taxAmount: string;
  /** Magnitude of SELLER-side fees only. Buyer surcharges are excluded. */
  feeAmount: string;
  refundedAmount: string;
  totalAmount: string;
  /**
   * Channel-native buyer reference only. NEVER an email, phone, or address —
   * see the design doc's open question 8 and the `orders` table doc.
   */
  buyerExternalId: string | null;
  /**
   * A channel-native display handle (an eBay username), NOT a legal name from
   * a billing address. Adapters that have only the latter must leave this null.
   */
  buyerDisplayName: string | null;
  placedAt: string;
  /** The incremental-sync watermark. */
  providerUpdatedAt: string | null;
  cancelledAt: string | null;
  lines: readonly CommerceOrderLineFact[];
  fees: readonly CommerceOrderFeeFact[];
  refunds: readonly CommerceOrderRefundFact[];
  fulfillments: readonly CommerceOrderFulfillmentFact[];
  /**
   * The verbatim provider payload, destined for `provider_objects` at the
   * provenance boundary.
   *
   * **MAY CONTAIN PERSONAL DATA** (a WooCommerce order payload carries
   * billing/shipping addresses, email, phone, IP, and user agent). It is never
   * logged, never asserted on in a test that can print a diff, and never
   * copied into a domain column. Whether this object class needs a retention
   * policy that marketplace observations do not is an unresolved POLICY
   * question — no retention logic exists in Phase 3.
   */
  rawPayload: Record<string, unknown> | null;
  /** `provider_objects.object_type`, e.g. `woocommerce.order`. */
  providerObjectType: string;
}
