/**
 * Listing → observation mapping (loxep-g4t.3): produce exactly the item
 * shape `@loxep/market`'s `recordObservationBatch` consumes (its
 * `observationItemSchema`), minus `marketplaceItemId` — mirroring
 * `@loxep/integration-etsy/observation.ts`'s contract (the canonical item
 * UUID only exists after `upsertMarketplaceItem`, so this package emits the
 * marketplace-item identity alongside and the ingestion orchestrator spreads
 * `{ ...observation, marketplaceItemId }` after the upsert).
 *
 * ONE mapper serves both m1 monitor types: `reverb_listing` calls
 * `adapter.getListing()` for a single listing, and `reverb_shop` calls
 * `adapter.getMyListings()` for a page of the connected account's own
 * listings — both return the same listing shape.
 *
 * ## Field mapping — DESIGN-DERIVED, pending live verification
 *
 * `id`/`title`/`price`/`state` are cross-checked against Reverb's own
 * developer docs (`title`/`price` from
 * https://www.reverb-api.com/docs/create-listings; `state`'s four values
 * from https://www.reverb-api.com/docs/updating-your-listing, fetched
 * 2026-08-13). `_links.web.href` for the canonical URL follows Reverb's
 * documented HAL convention ("You should never construct your own URLs...
 * follow resource links", /docs/getting-started) but the specific `web`
 * relation NAME was not independently confirmed against a live response in
 * this survey — treat it as a hypothesis to confirm during live
 * verification, the same caveat `@loxep/integration-etsy`'s own module docs
 * carry for their design-derived fields. A nested `shop` object's `id`/`name`
 * are read defensively (absent -> null) for the same reason.
 *
 * ```text
 * externalItemId      <- id (stringified)
 * title                 <- title
 * canonicalUrl            <- _links.web.href
 * price                     <- price (Money -> normalizeReverbMoney)
 * listingState                <- state, mapped per REVERB_LISTING_STATE_MAP
 * shopExternalId                 <- shop.id (stringified), if present
 * shopName                          <- shop.name, if present (kept on the
 *                                      snapshot for display; not part of the
 *                                      observation item schema)
 * ```
 *
 * Reverb's docs did not surface a per-listing quantity/inventory field on
 * the READ side in this survey (only on the create-listing REQUEST body),
 * nor a watcher/favorite count comparable to eBay's `watchCount` or Etsy's
 * `num_favorers` — both are therefore omitted rather than invented, the
 * same discipline Etsy's own `observation.ts` applies to eBay's per-listing
 * shipping price (a field one provider has and another does not is left out,
 * never guessed at).
 *
 * ## raw_state_hash
 *
 * Same discipline as every sibling: a sha256 hex digest over a canonical
 * JSON array of exactly the observation-relevant normalized fields, in this
 * fixed order:
 *
 *   [currency, price, listingState]
 *
 * Absent fields participate as `null`. Identity/descriptive fields (title,
 * url, shop id/name, raw payload) and batch facts (observedAt/fetchedAt/
 * batch id) are deliberately EXCLUDED.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReverbAdapterError } from "./errors.ts";
import { normalizeReverbMoney } from "./money.ts";

/** `@loxep/market` observationItemSchema shape, minus marketplaceItemId. */
export interface ReverbObservationItem {
  currency?: string;
  price?: string;
  listingState?: string;
  rawStateHash: string;
}

/**
 * `@loxep/market`'s `marketplaceItemInputSchema.marketplace` is a required,
 * non-empty string (the `(provider, marketplace, external_item_id)` unique
 * identity) — Reverb has no sub-marketplace concept, so this fixed constant
 * fills that column, exactly mirroring `ETSY_MARKETPLACE`.
 */
export const REVERB_MARKETPLACE = "reverb";

/** `@loxep/market` marketplaceItemInputSchema-compatible identity. */
export interface ReverbMarketplaceItemIdentity {
  provider: "reverb";
  marketplace: typeof REVERB_MARKETPLACE;
  externalItemId: string;
  seenAt: Date;
  currentState: string;
  sellerExternalId?: string;
  canonicalUrl?: string;
  title?: string;
}

export interface ReverbObservation {
  /** Minted by the caller at fetch time; passed through untouched. */
  observationBatchId: string;
  /** Fixed by the caller when the provider result was obtained. */
  observedAt: Date;
  connectionId?: string;
  source: string;
  item: ReverbMarketplaceItemIdentity;
  observation: ReverbObservationItem;
}

/** Reverb's own `state` enum, confirmed on /docs/updating-your-listing. */
export const REVERB_LISTING_STATES = ["draft", "live", "ended", "sold"] as const;
export type ReverbListingState = (typeof REVERB_LISTING_STATES)[number];

/**
 * `live` -> Loxep's `"active"` (the term eBay/Etsy observations already use
 * for "currently for sale"). `ended`/`sold` both map to Loxep's `"ended"`
 * (the vocabulary `deriveMarketEvents` checks for a `listing_ended` event,
 * `LISTING_STATE_ENDED` in `@loxep/market/events.ts`) — a genuine, explicit
 * design decision, not an assumption of Reverb's own semantics: Reverb's
 * gear listings are overwhelmingly single-unit (used/vintage instruments),
 * unlike Etsy's `sold_out` (which the Etsy design keeps distinct because a
 * multi-quantity listing can restock). A one-off Reverb listing that
 * transitions to `sold` is, for Loxep's purposes, definitively off the
 * market the same way `ended` is — if a live account is later found to
 * relist a `sold` listing id (rather than creating a new one), this mapping
 * should be revisited, but no evidence of that behavior was found in this
 * survey. `draft` passes through unchanged (never publicly visible, but the
 * connected account's own `reverb_shop` poll can see it).
 */
export const REVERB_LISTING_STATE_MAP: Readonly<Record<ReverbListingState, string>> = {
  draft: "draft",
  live: "active",
  ended: "ended",
  sold: "ended",
};

export function mapReverbListingState(state: unknown): string | null {
  return typeof state === "string" &&
    (REVERB_LISTING_STATES as readonly string[]).includes(state)
    ? (REVERB_LISTING_STATE_MAP[state as ReverbListingState] ?? state)
    : null;
}

/** Raw Reverb listing object -> the fields this package cares about. */
export interface ReverbListingSnapshot {
  externalItemId: string;
  title: string | null;
  canonicalUrl: string | null;
  price: { value: string; currency: string } | null;
  listingState: string;
  shopExternalId: string | null;
  shopName: string | null;
  /** Full provider payload, retained for audit/replay (ADR-0009). */
  raw: Record<string, unknown>;
  fetchedAt: Date;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function webHref(raw: Record<string, unknown>): string | null {
  const links = asRecord(raw["_links"]);
  if (links === null) return null;
  const web = asRecord(links["web"]);
  const href = web?.["href"];
  return typeof href === "string" && href.length > 0 ? href : null;
}

/**
 * Pure mapping from a raw Reverb listing payload to the Loxep-owned
 * snapshot. Exported for tests; adapter callers should map through this
 * after `getListing`/`getMyListings`.
 */
export function mapListingToSnapshot(
  raw: Record<string, unknown>,
  options: { fetchedAt: Date },
): ReverbListingSnapshot {
  const externalItemId = asString(raw["id"]);
  if (externalItemId === null) {
    throw new ReverbAdapterError(
      "provider_unavailable",
      "Reverb listing payload has no id; refusing to build a snapshot",
    );
  }
  const listingState = mapReverbListingState(raw["state"]) ?? "active";
  const shop = asRecord(raw["shop"]);

  return {
    externalItemId,
    title: asString(raw["title"]),
    canonicalUrl: webHref(raw),
    price: normalizeReverbMoney(raw["price"]),
    listingState,
    shopExternalId: shop !== null ? asString(shop["id"]) : null,
    shopName: shop !== null ? asString(shop["name"]) : null,
    raw,
    fetchedAt: options.fetchedAt,
  };
}

const contextSchema = z.strictObject({
  observationBatchId: z.uuid(),
  observedAt: z.date(),
  connectionId: z.uuid().optional(),
  source: z.string().min(1),
});

export type ReverbObservationContext = z.input<typeof contextSchema>;

/** Documented hash-field order — see the module doc before changing. */
export const OBSERVATION_HASH_FIELDS = ["currency", "price", "listingState"] as const;

export function observationStateHash(snapshot: ReverbListingSnapshot): string {
  const canonical: Array<string | null> = [
    snapshot.price?.currency ?? null,
    snapshot.price?.value ?? null,
    snapshot.listingState,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function snapshotToObservation(
  snapshot: ReverbListingSnapshot,
  context: ReverbObservationContext,
): ReverbObservation {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    throw new ReverbAdapterError(
      "invalid_request",
      "invalid observation context (batch identity is minted by the caller at fetch time)",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  const { observationBatchId, observedAt, connectionId, source } = parsed.data;

  const observation: ReverbObservationItem = {
    ...(snapshot.price !== null ? { currency: snapshot.price.currency } : {}),
    ...(snapshot.price !== null ? { price: snapshot.price.value } : {}),
    listingState: snapshot.listingState,
    rawStateHash: observationStateHash(snapshot),
  };

  const item: ReverbMarketplaceItemIdentity = {
    provider: "reverb",
    marketplace: REVERB_MARKETPLACE,
    externalItemId: snapshot.externalItemId,
    seenAt: observedAt,
    currentState: snapshot.listingState,
    ...(snapshot.shopExternalId !== null ? { sellerExternalId: snapshot.shopExternalId } : {}),
    ...(snapshot.canonicalUrl !== null ? { canonicalUrl: snapshot.canonicalUrl } : {}),
    ...(snapshot.title !== null ? { title: snapshot.title } : {}),
  };

  return {
    observationBatchId,
    observedAt,
    ...(connectionId !== undefined ? { connectionId } : {}),
    source,
    item,
    observation,
  };
}
