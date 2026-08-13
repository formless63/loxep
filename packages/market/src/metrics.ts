/**
 * Historical analytics read models (loxep-7dp.4, roadmap Phase 2 "Historical
 * analytics: charts, restock/sellout metrics"): time-bucketed price and
 * availability series, restock/sellout interval derivation, and a per-item
 * activity summary — all read-only queries over the tables the observation
 * (`observations.ts`) and event derivation (`events.ts`) modules already
 * write. No schema changes; no continuous aggregates (see below).
 *
 * ## Bucketing (`priceHistory`, `availabilityHistory`)
 *
 * Buckets use TimescaleDB's `time_bucket(interval, timestamptz)` with the
 * requested width expressed as `make_interval(secs => N)` (verified against
 * the installed TimescaleDB 2.29.1 dev database: `time_bucket` accepts a
 * plain `interval` first argument and needs no Timescale-specific cast for a
 * seconds-based width). A plain `GROUP BY` over that bucket expression —
 * **not** a continuous aggregate — computes each row.
 *
 * **Gaps are absent rows, not zero-filled.** A bucket with no observations
 * simply does not appear in the result; this module never synthesizes empty
 * buckets (no `generate_series` scaffolding). Callers rendering a chart must
 * handle gaps explicitly (e.g. a sparse-line/step chart, or their own
 * client-side fill) rather than assume a contiguous series.
 *
 * ## Range convention
 *
 * `from`/`to` bound the query as a half-open interval: `from` is inclusive
 * (`>=`), `to` is exclusive (`<`). Omitting `from` means "since the
 * beginning of retained history"; omitting `to` means "through the most
 * recent observation" (or, for `restockSellout`, "through now" — see below).
 *
 * ## Restock/sellout pairing (`restockSellout`)
 *
 * The DB-facing `restockSellout` reads `market_events` rows of type
 * `restocked`/`sold_out` for one item and hands them to the pure, exported
 * {@link deriveRestockSelloutIntervals}, which contains all the pairing
 * logic and needs no database to unit test. Edge cases it makes an explicit
 * choice about:
 *
 * - **Leading restock/sellout** (the first event in the window, so there is
 *   no known prior state): no interval is closed — we do not know when the
 *   preceding state began, so we never fabricate a duration for it. The
 *   event still opens a new interval starting at its own timestamp.
 * - **Trailing open interval**: after the last event, the current state is
 *   still open. `restockSellout` defaults `to` (and therefore the interval's
 *   closing boundary) to "now" when the caller omits it, so `currentState`
 *   and the corresponding average duration reflect an ongoing outage/streak
 *   up to the present. When a caller supplies an explicit `to` in the past,
 *   the trailing interval closes there instead. The trailing interval always
 *   appears in `intervals` (so a caller can render "still out of stock since
 *   X"); its duration is folded into the relevant average only when a
 *   boundary is known (it always is, per the default above).
 * - **Missing pairs / duplicate same-type events** (e.g. two `sold_out`
 *   events with no intervening `restocked`): the second event does not
 *   close or reopen an interval — the state did not actually change, so no
 *   new duration is measured and the open interval's start does not move.
 *   `selloutCount`/`restockCount` still count every raw event of that type,
 *   independent of pairing (they answer "how many restock/sellout events
 *   fired", not "how many complete cycles").
 *
 * ## Continuous-aggregate trigger criteria (Phase 0 non-goal: do NOT build
 * one yet — this is deliberately just a note for when to revisit)
 *
 * Phase 0 explicitly excludes "Timescale aggregates before observation
 * queries exist" (`phase-0-foundation.md`). These queries now exist, but
 * that alone is not sufficient justification — a continuous aggregate is a
 * maintenance/storage cost (refresh policy, extra disk, another moving
 * part) that only pays for itself once real volume or real query latency
 * demands it. Treat the following as the trigger, to be checked against
 * MEASURED numbers (`pg_stat_statements`, `EXPLAIN ANALYZE`, or app-level
 * timing) rather than assumed:
 *
 * - a single item's `marketplace_item_observations` history exceeds roughly
 *   100k–1M rows (multiple months of sub-minute adaptive polling on a hot
 *   item), such that `priceHistory`/`availabilityHistory` scan cost per call
 *   becomes measurable; or
 * - `priceHistory`/`availabilityHistory` p95 latency, as actually measured
 *   in production (item pages, dashboards), exceeds roughly 200ms; or
 * - these two queries' combined share of total database time (via
 *   `pg_stat_statements`) becomes a measurable fraction (roughly 5%+) of
 *   overall load, i.e. they are called often enough across many items that
 *   repeated raw-row scans matter even if any single call is fast.
 *
 * If/when triggered, `priceHistory` is the query most likely to need a
 * continuous aggregate first — it is the one every `/market` item page and
 * future dashboard chart calls, at the tightest practical bucket width,
 * against the longest history. `availabilityHistory` would likely follow
 * for the same reason at smaller scale. `restockSellout` and
 * `itemActivitySummary` read the much smaller, already-indexed
 * `market_events` table (and a bounded observation window) and are unlikely
 * to need one on any timescale currently foreseeable.
 *
 * ## Money
 *
 * `price`/prices stay decimal strings end to end, exactly like
 * `observations.ts`/`events.ts`. The one place this module computes a
 * derived number from money (`priceChangePct`) does so via BigInt
 * fixed-point arithmetic mirroring {@link compareDecimalStrings}'s parsing
 * convention, converting to a JS `number` only once, for the final display
 * ratio — never for the underlying prices themselves.
 */
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { MarketValidationError } from "./errors.ts";
import {
  AVAILABILITY_IN_STOCK,
  AVAILABILITY_OUT_OF_STOCK,
  MARKET_EVENT_TYPES,
  compareDecimalStrings,
} from "./events.ts";
import type { MarketEventType } from "./events.ts";
import { intLiteral, textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

/** Default bucket width for `priceHistory`/`availabilityHistory` (1 hour). */
export const DEFAULT_HISTORY_BUCKET_SECONDS = 3600;

function rangeClause(
  column: string,
  from: Date | undefined,
  to: Date | undefined,
): string {
  const parts: string[] = [];
  if (from !== undefined) parts.push(`${column} >= ${timestamptzLiteral(from)}`);
  if (to !== undefined) parts.push(`${column} < ${timestamptzLiteral(to)}`);
  return parts.length === 0 ? "" : `and ${parts.join(" and ")}`;
}

function bucketExpression(bucketSeconds: number): string {
  if (!Number.isSafeInteger(bucketSeconds) || bucketSeconds < 1) {
    throw new MarketValidationError(
      "bucketSeconds must be a positive integer number of seconds",
    );
  }
  return `time_bucket(make_interval(secs => ${intLiteral(bucketSeconds)}), observed_at)`;
}

/**
 * `db.execute`'s raw-string path returns node-postgres's TEXT-format wire
 * output rather than applying its usual type-aware Date parsing (verified
 * against the installed dev database: a `timestamptz` column round-trips as
 * a string like `"2026-08-11 05:45:20.805258+00"`, not a `Date`), so every
 * timestamp column read through this module's raw queries is parsed
 * explicitly here rather than cast.
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(value as string);
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/* ------------------------------------------------------------------------ */
/* priceHistory                                                             */
/* ------------------------------------------------------------------------ */

export interface PriceHistoryOptions {
  marketplaceItemId: string;
  from?: Date;
  to?: Date;
  /** Bucket width in seconds; defaults to {@link DEFAULT_HISTORY_BUCKET_SECONDS}. */
  bucketSeconds?: number;
}

const priceHistoryOptionsSchema = z.strictObject({
  marketplaceItemId: z.uuid(),
  from: z.date().optional(),
  to: z.date().optional(),
  bucketSeconds: z.number().int().positive().optional(),
});

export interface PriceHistoryBucket {
  bucketStart: Date;
  /** Lowest observed price in the bucket; null when no price was observed. */
  minPrice: string | null;
  /** Highest observed price in the bucket; null when no price was observed. */
  maxPrice: string | null;
  /** Most recently observed price in the bucket (by `observed_at`). */
  lastPrice: string | null;
  /** Every observation in the bucket, not only ones with a non-null price. */
  observationCount: number;
}

/**
 * Time-bucketed price series for one item. `min`/`max`/`last` ignore
 * observations with a NULL price (an unpriced poll never counts as a $0
 * price); `observationCount` counts every observation in the bucket
 * regardless, so callers can tell "polled but unpriced" apart from "not
 * polled at all" (an absent bucket).
 */
export async function priceHistory(
  db: LoxepDb,
  options: PriceHistoryOptions,
): Promise<PriceHistoryBucket[]> {
  const parsed = priceHistoryOptionsSchema.parse(options);
  const bucketSeconds = parsed.bucketSeconds ?? DEFAULT_HISTORY_BUCKET_SECONDS;
  const result = await db.execute(
    `select
        ${bucketExpression(bucketSeconds)} as bucket_start,
        min(price) as min_price,
        max(price) as max_price,
        (array_agg(price order by observed_at desc) filter (where price is not null))[1] as last_price,
        count(*)::int as observation_count
      from marketplace_item_observations
      where marketplace_item_id = ${uuidLiteral(parsed.marketplaceItemId)}
        ${rangeClause("observed_at", parsed.from, parsed.to)}
      group by bucket_start
      order by bucket_start`,
  );
  return result.rows.map((row) => ({
    bucketStart: toDate(row["bucket_start"]),
    minPrice: (row["min_price"] as string | null) ?? null,
    maxPrice: (row["max_price"] as string | null) ?? null,
    lastPrice: (row["last_price"] as string | null) ?? null,
    observationCount: Number(row["observation_count"]),
  }));
}

/* ------------------------------------------------------------------------ */
/* availabilityHistory                                                      */
/* ------------------------------------------------------------------------ */

export interface AvailabilityHistoryOptions {
  marketplaceItemId: string;
  from?: Date;
  to?: Date;
  bucketSeconds?: number;
}

const availabilityHistoryOptionsSchema = priceHistoryOptionsSchema;

export interface AvailabilityHistoryBucket {
  bucketStart: Date;
  /** Most recently observed `quantity_available` in the bucket, if any. */
  lastQuantityAvailable: number | null;
  /** Most recently observed `listing_state` in the bucket, if any. */
  lastListingState: string | null;
  /**
   * True when ANY observation in the bucket recorded `availability =
   * "out_of_stock"` or `quantity_available = 0` — i.e. the item was seen
   * unavailable at some point during the bucket, even if it later recovered
   * within the same bucket (a coarse bucket can hide a same-bucket
   * restock/sellout pair; use `restockSellout` for exact transition timing).
   */
  wentUnavailable: boolean;
}

/** Time-bucketed availability/quantity series for one item. */
export async function availabilityHistory(
  db: LoxepDb,
  options: AvailabilityHistoryOptions,
): Promise<AvailabilityHistoryBucket[]> {
  const parsed = availabilityHistoryOptionsSchema.parse(options);
  const bucketSeconds = parsed.bucketSeconds ?? DEFAULT_HISTORY_BUCKET_SECONDS;
  const result = await db.execute(
    `select
        ${bucketExpression(bucketSeconds)} as bucket_start,
        (array_agg(quantity_available order by observed_at desc) filter (where quantity_available is not null))[1] as last_quantity_available,
        (array_agg(listing_state order by observed_at desc) filter (where listing_state is not null))[1] as last_listing_state,
        bool_or(
          availability = ${textLiteral(AVAILABILITY_OUT_OF_STOCK)}
          or quantity_available = 0
        ) as went_unavailable
      from marketplace_item_observations
      where marketplace_item_id = ${uuidLiteral(parsed.marketplaceItemId)}
        ${rangeClause("observed_at", parsed.from, parsed.to)}
      group by bucket_start
      order by bucket_start`,
  );
  return result.rows.map((row) => ({
    bucketStart: toDate(row["bucket_start"]),
    lastQuantityAvailable: (row["last_quantity_available"] as number | null) ?? null,
    lastListingState: (row["last_listing_state"] as string | null) ?? null,
    wentUnavailable: Boolean(row["went_unavailable"]),
  }));
}

/* ------------------------------------------------------------------------ */
/* restockSellout                                                           */
/* ------------------------------------------------------------------------ */

/** The `in_stock`/`out_of_stock` state vocabulary shared with `events.ts`. */
export type StockState =
  | typeof AVAILABILITY_IN_STOCK
  | typeof AVAILABILITY_OUT_OF_STOCK;

/** Minimal shape {@link deriveRestockSelloutIntervals} needs per event. */
export interface RestockSelloutEvent {
  eventType: "restocked" | "sold_out";
  at: Date;
}

export interface RestockSelloutInterval {
  /**
   * Start of the interval. Always a concrete `Date` in practice — the type
   * stays nullable only to stay symmetric with `to`, which genuinely can be
   * null (the still-open trailing interval when no `rangeEnd` is known).
   */
  from: Date | null;
  /** End of the interval; null for the still-open trailing interval when no `rangeEnd` is known. */
  to: Date | null;
  state: StockState;
}

export interface RestockSelloutResult {
  /** Raw count of `sold_out` events in the window (not "complete cycles"). */
  selloutCount: number;
  /** Raw count of `restocked` events in the window (not "complete cycles"). */
  restockCount: number;
  /** Average duration of bounded `out_of_stock` intervals, in seconds; null when none. */
  avgOutOfStockSeconds: number | null;
  /** Average duration of bounded `in_stock` intervals, in seconds; null when none. */
  avgInStockSeconds: number | null;
  /** `"unknown"` when the window contains no restock/sellout events at all. */
  currentState: StockState | "unknown";
  intervals: RestockSelloutInterval[];
}

function intervalSeconds(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 1000;
}

/**
 * Pure pairing of a chronological restock/sellout event list into
 * in-stock/out-of-stock intervals. No I/O; see the module doc for the exact
 * edge-case decisions (leading events, the trailing open interval, and
 * duplicate/missing pairs). `events` need not be pre-sorted — this function
 * sorts a copy by `at` ascending before pairing.
 */
export function deriveRestockSelloutIntervals(
  events: RestockSelloutEvent[],
  options: { rangeEnd?: Date } = {},
): RestockSelloutResult {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  let currentState: StockState | null = null;
  let currentIntervalStart: Date | null = null;
  let selloutCount = 0;
  let restockCount = 0;
  const intervals: RestockSelloutInterval[] = [];
  const outDurations: number[] = [];
  const inDurations: number[] = [];

  for (const event of sorted) {
    if (event.eventType === "restocked") {
      restockCount += 1;
      if (currentState === AVAILABILITY_OUT_OF_STOCK) {
        intervals.push({
          from: currentIntervalStart,
          to: event.at,
          state: AVAILABILITY_OUT_OF_STOCK,
        });
        if (currentIntervalStart !== null) {
          outDurations.push(intervalSeconds(currentIntervalStart, event.at));
        }
        currentState = AVAILABILITY_IN_STOCK;
        currentIntervalStart = event.at;
      } else if (currentState === null) {
        // Leading restock: no known prior state, nothing to close.
        currentState = AVAILABILITY_IN_STOCK;
        currentIntervalStart = event.at;
      }
      // else: duplicate restock while already in_stock — no-op, the
      // in_stock interval that's already open keeps its original start.
    } else {
      selloutCount += 1;
      if (currentState === AVAILABILITY_IN_STOCK) {
        intervals.push({
          from: currentIntervalStart,
          to: event.at,
          state: AVAILABILITY_IN_STOCK,
        });
        if (currentIntervalStart !== null) {
          inDurations.push(intervalSeconds(currentIntervalStart, event.at));
        }
        currentState = AVAILABILITY_OUT_OF_STOCK;
        currentIntervalStart = event.at;
      } else if (currentState === null) {
        // Leading sellout: no known prior state, nothing to close.
        currentState = AVAILABILITY_OUT_OF_STOCK;
        currentIntervalStart = event.at;
      }
      // else: duplicate sellout while already out_of_stock — no-op.
    }
  }

  if (currentState !== null) {
    const to = options.rangeEnd ?? null;
    intervals.push({ from: currentIntervalStart, to, state: currentState });
    if (to !== null && currentIntervalStart !== null) {
      const duration = intervalSeconds(currentIntervalStart, to);
      if (currentState === AVAILABILITY_OUT_OF_STOCK) {
        outDurations.push(duration);
      } else {
        inDurations.push(duration);
      }
    }
  }

  const average = (values: number[]): number | null =>
    values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    selloutCount,
    restockCount,
    avgOutOfStockSeconds: average(outDurations),
    avgInStockSeconds: average(inDurations),
    currentState: currentState ?? "unknown",
    intervals,
  };
}

export interface RestockSelloutOptions {
  marketplaceItemId: string;
  from?: Date;
  to?: Date;
}

const restockSelloutOptionsSchema = z.strictObject({
  marketplaceItemId: z.uuid(),
  from: z.date().optional(),
  to: z.date().optional(),
});

/**
 * Restock/sellout metrics for one item, derived from `market_events`.
 * Defaults `to` to "now" (both as the query's upper bound and as the
 * trailing interval's closing boundary) when the caller omits it, so an
 * item currently out of stock reports its ongoing outage duration rather
 * than an unbounded open interval — see the module doc.
 */
export async function restockSellout(
  db: LoxepDb,
  options: RestockSelloutOptions,
): Promise<RestockSelloutResult> {
  const parsed = restockSelloutOptionsSchema.parse(options);
  const rangeEnd = parsed.to ?? new Date();
  const result = await db.execute(
    `select event_type, to_observed_at
       from market_events
      where marketplace_item_id = ${uuidLiteral(parsed.marketplaceItemId)}
        and event_type in ('restocked', 'sold_out')
        ${rangeClause("to_observed_at", parsed.from, rangeEnd)}
      order by to_observed_at asc`,
  );
  const events: RestockSelloutEvent[] = result.rows.map((row) => ({
    eventType: row["event_type"] as "restocked" | "sold_out",
    at: toDate(row["to_observed_at"]),
  }));
  return deriveRestockSelloutIntervals(events, { rangeEnd });
}

/* ------------------------------------------------------------------------ */
/* itemActivitySummary                                                      */
/* ------------------------------------------------------------------------ */

export interface ItemActivitySummaryOptions {
  marketplaceItemId: string;
  windowSeconds: number;
}

const itemActivitySummaryOptionsSchema = z.strictObject({
  marketplaceItemId: z.uuid(),
  windowSeconds: z.number().int().positive(),
});

export interface ItemActivitySummary {
  marketplaceItemId: string;
  windowSeconds: number;
  /** Every {@link MARKET_EVENT_TYPES} key present, defaulting to 0. */
  eventCounts: Record<MarketEventType, number>;
  /**
   * Percent change from the first to the last priced observation inside the
   * window (`(last - first) / first * 100`); null when the window has fewer
   * than one priced observation, or when the first price is `"0"` (a
   * percentage change from a zero base is undefined).
   */
  priceChangePct: number | null;
  /** Observations inside the window (not the item's lifetime total). */
  observationCount: number;
  /**
   * Most recent observation for this item overall — NOT window-limited, so
   * a caller can tell whether data is stale independent of the requested
   * window. Null when the item has never been observed.
   */
  lastObservedAt: Date | null;
}

/**
 * Percentage change between two decimal-string prices, computed via BigInt
 * fixed-point arithmetic on the same parsing convention as
 * {@link compareDecimalStrings} (never JS float math on the prices
 * themselves). Truncates toward zero at {@link PRICE_CHANGE_PCT_SCALE}
 * fractional digits of precision before converting to a JS `number` for the
 * final, display-only ratio. Returns null when `firstPrice` is `"0"`.
 */
const PRICE_CHANGE_PCT_SCALE = 6;

export function computePriceChangePercent(
  firstPrice: string,
  lastPrice: string,
): number | null {
  if (compareDecimalStrings(firstPrice, lastPrice) === 0) return 0;
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
  const pf = parse(firstPrice);
  const pl = parse(lastPrice);
  const scale = Math.max(pf.frac.length, pl.frac.length);
  const first = pf.sign * BigInt(pf.int + pf.frac.padEnd(scale, "0"));
  const last = pl.sign * BigInt(pl.int + pl.frac.padEnd(scale, "0"));
  if (first === 0n) return null;
  const precision = 10n ** BigInt(PRICE_CHANGE_PCT_SCALE);
  const scaledPct = ((last - first) * 100n * precision) / first;
  return Number(scaledPct) / Number(precision);
}

/**
 * Per-item activity summary: derived event counts by type, price change
 * over the window, observation volume, and overall freshness — the shape
 * `/market` item pages and future dashboards consume.
 */
export async function itemActivitySummary(
  db: LoxepDb,
  options: ItemActivitySummaryOptions,
): Promise<ItemActivitySummary> {
  const parsed = itemActivitySummaryOptionsSchema.parse(options);
  const now = new Date();
  const since = new Date(now.getTime() - parsed.windowSeconds * 1000);
  const itemLiteral = uuidLiteral(parsed.marketplaceItemId);
  const sinceLiteral = timestamptzLiteral(since);
  const nowLiteral = timestamptzLiteral(now);

  const eventRows = await db.execute(
    `select event_type, count(*)::int as n
       from market_events
      where marketplace_item_id = ${itemLiteral}
        and detected_at > ${sinceLiteral}
        and detected_at <= ${nowLiteral}
      group by event_type`,
  );
  const eventCounts = Object.fromEntries(
    MARKET_EVENT_TYPES.map((type) => [type, 0]),
  ) as Record<MarketEventType, number>;
  for (const row of eventRows.rows) {
    const type = row["event_type"] as MarketEventType;
    if (type in eventCounts) {
      eventCounts[type] = Number(row["n"]);
    }
  }

  const windowRow = await db.execute(
    `with windowed as (
        select price, observed_at
          from marketplace_item_observations
         where marketplace_item_id = ${itemLiteral}
           and observed_at > ${sinceLiteral}
           and observed_at <= ${nowLiteral}
      )
      select
        count(*)::int as observation_count,
        (select price from windowed where price is not null order by observed_at asc limit 1) as first_price,
        (select price from windowed where price is not null order by observed_at desc limit 1) as last_price
      from windowed`,
  );
  const windowResultRow = windowRow.rows[0];
  const observationCount = Number(windowResultRow?.["observation_count"] ?? 0);
  const firstPrice = (windowResultRow?.["first_price"] as string | null) ?? null;
  const lastPrice = (windowResultRow?.["last_price"] as string | null) ?? null;
  const priceChangePct =
    firstPrice !== null && lastPrice !== null
      ? computePriceChangePercent(firstPrice, lastPrice)
      : null;

  const lastObservedRow = await db.execute(
    `select max(observed_at) as last_observed_at
       from marketplace_item_observations
      where marketplace_item_id = ${itemLiteral}`,
  );
  const lastObservedAt = toDateOrNull(
    lastObservedRow.rows[0]?.["last_observed_at"],
  );

  return {
    marketplaceItemId: parsed.marketplaceItemId,
    windowSeconds: parsed.windowSeconds,
    eventCounts,
    priceChangePct,
    observationCount,
    lastObservedAt,
  };
}

/* ------------------------------------------------------------------------ */
/* biggestPriceMovers                                                       */
/* ------------------------------------------------------------------------ */

export const DEFAULT_PRICE_MOVERS_LIMIT = 5;

export interface BiggestPriceMoversOptions {
  /** How many movers to return; defaults to {@link DEFAULT_PRICE_MOVERS_LIMIT}. */
  limit?: number;
  /**
   * Inclusive lower bound on `observed_at`. Omitting it considers an item's
   * whole retained history, which on a long-lived hypertable means the
   * "prior" price can be months old — pass a window (the dashboard passes
   * days) when the caller wants a *recent* move rather than a lifetime one.
   */
  since?: Date;
}

const biggestPriceMoversOptionsSchema = z.strictObject({
  limit: z.number().int().positive().max(100).optional(),
  since: z.date().optional(),
});

export interface PriceMoverRow {
  marketplaceItemId: string;
  /** Item title when known; canonical identity carries no title requirement. */
  title: string | null;
  currentState: string;
  /** Currency of the LATEST priced observation; null when never recorded. */
  currency: string | null;
  /** Decimal strings, never JS numbers — the prices themselves stay exact. */
  latestPrice: string;
  previousPrice: string;
  /** Signed percent change, via {@link computePriceChangePercent}. */
  priceChangePct: number;
  observedAt: Date;
  previousObservedAt: Date;
}

/**
 * The items whose price moved most, latest priced observation vs. the one
 * before it (loxep-jwm, the dashboard "biggest movers" tile).
 *
 * Deliberately NOT `itemActivitySummary` in a loop: that reads first-vs-last
 * inside a window, per item, in three statements each. This is one statement
 * for the whole installation, and it answers a different question — the most
 * recent *step*, which is what a "what just moved" tile means.
 *
 * Choices worth knowing:
 *
 * - **Only priced observations count.** A poll that recorded no price is not
 *   a $0 price and is not a step; NULL prices are filtered before ranking, so
 *   "latest vs prior" means the last two prices we actually saw.
 * - **Items with fewer than two priced observations are absent**, not
 *   returned with a null change — there is no move to report yet.
 * - **A zero change is not a mover.** An item whose last two prices are equal
 *   is excluded rather than allowed to occupy a slot in a top-N list; with
 *   few real movers the tile shows fewer rows instead of padding.
 * - **A prior price of exactly 0 is excluded**: a percentage change from a
 *   zero base is undefined (the same rule {@link computePriceChangePercent}
 *   applies), so those items cannot be ranked here at all.
 * - **Ranking is exact PostgreSQL `numeric` arithmetic** in the `ORDER BY`;
 *   the returned `priceChangePct` is then computed from the decimal strings
 *   by {@link computePriceChangePercent}'s BigInt fixed-point path, so no
 *   money value passes through JS floating point on the way to the caller.
 *   Ties break on `marketplace_item_id` so the ordering is total.
 */
export async function biggestPriceMovers(
  db: LoxepDb,
  options: BiggestPriceMoversOptions = {},
): Promise<PriceMoverRow[]> {
  const parsed = biggestPriceMoversOptionsSchema.parse(options);
  const limit = parsed.limit ?? DEFAULT_PRICE_MOVERS_LIMIT;
  const sinceClause =
    parsed.since === undefined
      ? ""
      : `and observed_at >= ${timestamptzLiteral(parsed.since)}`;
  const result = await db.execute(
    `with priced as (
        select marketplace_item_id, price, currency, observed_at,
               row_number() over (
                 partition by marketplace_item_id
                 order by observed_at desc
               ) as rn
          from marketplace_item_observations
         where price is not null
           ${sinceClause}
      ),
      paired as (
        select marketplace_item_id,
               max(price) filter (where rn = 1) as latest_price,
               max(price) filter (where rn = 2) as previous_price,
               max(currency) filter (where rn = 1) as currency,
               max(observed_at) filter (where rn = 1) as observed_at,
               max(observed_at) filter (where rn = 2) as previous_observed_at
          from priced
         where rn <= 2
         group by marketplace_item_id
      )
      select p.marketplace_item_id::text as marketplace_item_id,
             mi.title,
             mi.current_state,
             p.currency,
             p.latest_price::text as latest_price,
             p.previous_price::text as previous_price,
             p.observed_at,
             p.previous_observed_at
        from paired p
        join marketplace_items mi on mi.id = p.marketplace_item_id
       where p.previous_price is not null
         and p.previous_price <> 0
         and p.latest_price <> p.previous_price
       order by abs((p.latest_price - p.previous_price) / p.previous_price) desc,
                p.marketplace_item_id asc
       limit ${intLiteral(limit)}`,
  );
  const movers: PriceMoverRow[] = [];
  for (const row of result.rows) {
    const latestPrice = row["latest_price"] as string;
    const previousPrice = row["previous_price"] as string;
    const priceChangePct = computePriceChangePercent(previousPrice, latestPrice);
    // `previous_price <> 0` above already excludes the only null case; the
    // guard keeps the row type honest rather than asserting non-null.
    if (priceChangePct === null) continue;
    movers.push({
      marketplaceItemId: row["marketplace_item_id"] as string,
      title: (row["title"] as string | null) ?? null,
      currentState: row["current_state"] as string,
      currency: (row["currency"] as string | null) ?? null,
      latestPrice,
      previousPrice,
      priceChangePct,
      observedAt: toDate(row["observed_at"]),
      previousObservedAt: toDate(row["previous_observed_at"]),
    });
  }
  return movers;
}
