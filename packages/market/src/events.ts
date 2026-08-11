/**
 * `market_events` derivation (loxep-ubx.3): pure comparison of two
 * observations of one marketplace item into the documented initial event
 * types, plus retry-safe insertion.
 *
 * ## Deduplication key convention
 *
 * `deduplication_key = "<marketplace_item_id>:<event_type>:<to_observed_at
 * ISO-8601 UTC>"` (e.g. `9d2c…:price_dropped:2026-08-11T12:00:00.000Z`). The key
 * is derived only from facts that are stable across retries — the item, the
 * event type, and the `observed_at` of the newer observation (fixed at fetch
 * time) — so re-deriving after an at-least-once retry produces the same key
 * and the `market_events.deduplication_key` UNIQUE column turns the
 * duplicate insert into a no-op (`ON CONFLICT DO NOTHING`).
 *
 * ## Event semantics (initial)
 *
 * With `p` = previous, `c` = current (both prices/quantities must be
 * non-NULL to compare; NULL never participates — an unobserved metric
 * produces no event):
 *
 * - `price_changed`   — `p.price ≠ c.price` (decimal-string comparison,
 *   never JS float math);
 * - `price_dropped`   — additionally emitted when `c.price < p.price`;
 * - `quantity_changed`— `p.quantity_available ≠ c.quantity_available`;
 * - `restocked`       — quantity `0 → >0`, or availability
 *   `"out_of_stock" → "in_stock"`;
 * - `sold_out`        — quantity `>0 → 0`, or availability
 *   `"in_stock" → "out_of_stock"`;
 * - `listing_ended`   — `listing_state` transitions from a non-NULL,
 *   non-`"ended"` value to `"ended"`.
 *
 * A first observation (no previous) derives nothing: events are
 * interpretations of change between observations.
 *
 * ## `new_listing` is the exception
 *
 * `new_listing` (Phase 2) is a DISCOVERY event, not a comparison: it fires
 * when a search or seller monitor finds an item Loxep has never seen. It
 * therefore lives in `discovery.ts`, has no `from_observed_at`, and puts the
 * item's first-discovery instant in the deduplication key's timestamp slot —
 * the same `<item>:<type>:<ISO>` convention, so the same UNIQUE column keeps
 * it idempotent.
 */
import { marketEvents } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { MarketValidationError } from "./errors.ts";

/**
 * Derived event types; text + TS union, no PG enum.
 *
 * All but `new_listing` are COMPARISONS of two observations of one item and
 * come out of {@link compareObservations}. `new_listing` is the one
 * DISCOVERY event: it has no previous observation to compare against and is
 * derived in `discovery.ts` instead (see the module doc there for its
 * first-global-discovery semantics). It still uses this module's
 * {@link deduplicationKeyFor} convention, with the item's first-discovery
 * instant in the timestamp slot.
 */
export const MARKET_EVENT_TYPES = [
  "price_changed",
  "price_dropped",
  "restocked",
  "sold_out",
  "quantity_changed",
  "listing_ended",
  "new_listing",
] as const;
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];

/** The one event type that is a discovery, not an observation comparison. */
export const NEW_LISTING_EVENT_TYPE = "new_listing" as const;

/** Availability conventions used by restock/sellout detection. */
export const AVAILABILITY_IN_STOCK = "in_stock";
export const AVAILABILITY_OUT_OF_STOCK = "out_of_stock";

/** Listing-state convention used by `listing_ended` detection. */
export const LISTING_STATE_ENDED = "ended";

/** The observation facts event derivation compares. */
export interface ObservationSnapshot {
  observedAt: Date;
  price?: string | null;
  currency?: string | null;
  quantityAvailable?: number | null;
  availability?: string | null;
  listingState?: string | null;
}

export interface DetectedMarketEvent {
  eventType: MarketEventType;
  payload: Record<string, unknown>;
}

/**
 * Exact decimal-string comparison (returns -1/0/1). Money is PostgreSQL
 * `numeric` carried as strings; this never converts to JS floats.
 */
export function compareDecimalStrings(a: string, b: string): number {
  const parse = (value: string): { sign: bigint; int: string; frac: string } => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (match === null) {
      throw new MarketValidationError(`not a decimal string: "${value}"`);
    }
    return {
      sign: match[1] === "-" ? -1n : 1n,
      int: match[2] ?? "0",
      frac: match[3] ?? "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  const scale = Math.max(pa.frac.length, pb.frac.length);
  const va = pa.sign * BigInt(pa.int + pa.frac.padEnd(scale, "0"));
  const vb = pb.sign * BigInt(pb.int + pb.frac.padEnd(scale, "0"));
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/**
 * Pure comparison of two observations (no I/O). Returns every detected
 * event with its payload; see the module doc for the exact semantics.
 */
export function compareObservations(
  previous: ObservationSnapshot,
  current: ObservationSnapshot,
): DetectedMarketEvent[] {
  const events: DetectedMarketEvent[] = [];

  const prevPrice = previous.price ?? null;
  const currPrice = current.price ?? null;
  if (prevPrice !== null && currPrice !== null) {
    const cmp = compareDecimalStrings(currPrice, prevPrice);
    if (cmp !== 0) {
      const payload = {
        from: prevPrice,
        to: currPrice,
        currency: current.currency ?? previous.currency ?? null,
      };
      events.push({ eventType: "price_changed", payload });
      if (cmp < 0) {
        events.push({ eventType: "price_dropped", payload });
      }
    }
  }

  const prevQty = previous.quantityAvailable ?? null;
  const currQty = current.quantityAvailable ?? null;
  if (prevQty !== null && currQty !== null && prevQty !== currQty) {
    events.push({
      eventType: "quantity_changed",
      payload: { from: prevQty, to: currQty },
    });
  }

  const prevAvail = previous.availability ?? null;
  const currAvail = current.availability ?? null;
  const restockedByQty = prevQty === 0 && currQty !== null && currQty > 0;
  const restockedByAvail =
    prevAvail === AVAILABILITY_OUT_OF_STOCK &&
    currAvail === AVAILABILITY_IN_STOCK;
  if (restockedByQty || restockedByAvail) {
    events.push({
      eventType: "restocked",
      payload: {
        fromQuantity: prevQty,
        toQuantity: currQty,
        fromAvailability: prevAvail,
        toAvailability: currAvail,
      },
    });
  }
  const soldOutByQty = prevQty !== null && prevQty > 0 && currQty === 0;
  const soldOutByAvail =
    prevAvail === AVAILABILITY_IN_STOCK &&
    currAvail === AVAILABILITY_OUT_OF_STOCK;
  if (soldOutByQty || soldOutByAvail) {
    events.push({
      eventType: "sold_out",
      payload: {
        fromQuantity: prevQty,
        toQuantity: currQty,
        fromAvailability: prevAvail,
        toAvailability: currAvail,
      },
    });
  }

  const prevState = previous.listingState ?? null;
  const currState = current.listingState ?? null;
  if (
    prevState !== null &&
    prevState !== LISTING_STATE_ENDED &&
    currState === LISTING_STATE_ENDED
  ) {
    events.push({
      eventType: "listing_ended",
      payload: { from: prevState, to: currState },
    });
  }

  return events;
}

/** The documented deduplication-key convention (module doc). */
export function deduplicationKeyFor(
  marketplaceItemId: string,
  eventType: MarketEventType,
  toObservedAt: Date,
): string {
  return `${marketplaceItemId}:${eventType}:${toObservedAt.toISOString()}`;
}

export type MarketEventRow = typeof marketEvents.$inferSelect;

/**
 * Derive and persist market events for one item transition. Insertion is
 * `ON CONFLICT (deduplication_key) DO NOTHING`, so re-deriving the same
 * transition (worker retry, dispatcher overlap) inserts nothing new.
 * Returns both the detected events and the rows actually inserted.
 */
export async function deriveMarketEvents(options: {
  db: LoxepDb;
  marketplaceItemId: string;
  previous: ObservationSnapshot | null;
  current: ObservationSnapshot;
  monitorTargetId?: string | null;
  detectedAt?: Date;
}): Promise<{ detected: DetectedMarketEvent[]; inserted: MarketEventRow[] }> {
  const { db, marketplaceItemId, previous, current } = options;
  if (previous === null) {
    return { detected: [], inserted: [] };
  }
  const detected = compareObservations(previous, current);
  if (detected.length === 0) {
    return { detected, inserted: [] };
  }
  const detectedAt = options.detectedAt ?? new Date();
  const rows = detected.map((event) => ({
    marketplaceItemId,
    monitorTargetId: options.monitorTargetId ?? null,
    eventType: event.eventType,
    detectedAt,
    fromObservedAt: previous.observedAt,
    toObservedAt: current.observedAt,
    payload: event.payload,
    deduplicationKey: deduplicationKeyFor(
      marketplaceItemId,
      event.eventType,
      current.observedAt,
    ),
  }));
  const inserted = await db
    .insert(marketEvents)
    .values(rows)
    .onConflictDoNothing({ target: marketEvents.deduplicationKey })
    .returning();
  return { detected, inserted };
}
