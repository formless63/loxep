/**
 * Adaptive polling cadence (loxep-7dp.3, roadmap Phase 2 "Adaptive
 * scheduling/backoff"): a PURE policy that turns cheap activity signals into
 * the number of seconds until a target's next poll, plus the codec for the
 * transient adaptivity state stored under `monitor_targets.config.adaptive`.
 *
 * Nothing here performs I/O and nothing here requires a schema change.
 * `interval_seconds` remains the operator-set BASE cadence; the policy only
 * chooses a multiple of it, and `next_poll_at` advancement (see
 * {@link ../monitors.ts | recordPollSuccess}) applies the result.
 *
 * ## Inputs
 *
 * - `recentEventCount` — `market_events` derived for the target's items in a
 *   recent window (volatility that already produced user-visible events);
 * - `recentChangeCount` — observation `raw_state_hash` deltas in the same
 *   window (volatility that has not necessarily produced an event);
 * - `unchangedStreak` — consecutive polls that observed no change;
 * - `secondsUntilListingEnd` — time to the soonest `listing_ends_at` among
 *   the target's items (auction-style listings get interesting at the end);
 * - `bounds` — hard floor/ceiling. `bounds.minSeconds` is where a caller
 *   injects its per-connection RATE BUDGET floor; the policy never returns a
 *   value below it.
 *
 * ## Tiers (exact, in evaluation order)
 *
 * `activity = recentEventCount + recentChangeCount`.
 *
 * Tightening tiers (factor < 1) — the SMALLEST applicable factor wins:
 *
 * | tier                      | condition                       | factor |
 * | ------------------------- | ------------------------------- | ------ |
 * | `auction_endgame`         | `0 ≤ secondsUntilEnd < 300`     | 1/8    |
 * | `auction_near_end`        | `secondsUntilEnd < 1800`        | 1/4    |
 * | `auction_approaching_end` | `secondsUntilEnd < 21600` (6 h) | 1/2    |
 * | `activity_hot`            | `activity ≥ 8`                  | 1/4    |
 * | `activity_warm`           | `activity ≥ 3`                  | 1/2    |
 *
 * Relaxation tiers (factor > 1) apply ONLY when no tightening tier fired and
 * `activity === 0` — recent activity always beats an idle streak, which is
 * what keeps a busy target from oscillating:
 *
 * | tier                | condition             | factor |
 * | ------------------- | --------------------- | ------ |
 * | `idle_relaxed`      | `unchangedStreak ≥ 6` | 2      |
 * | `idle_long`         | `unchangedStreak ≥ 12`| 4      |
 * | `idle_very_long`    | `unchangedStreak ≥ 24`| 8      |
 *
 * Otherwise the tier is `steady` (factor 1 — the operator's base interval).
 *
 * ## Damping and clamping (in order)
 *
 * 1. `raw = baseIntervalSeconds * factor` (so the policy spans
 *    `[base/8, base*8]` before clamping);
 * 2. **step damping** — when `previousIntervalSeconds` is supplied the result
 *    may not move by more than {@link MAX_STEP_FACTOR}× per computation, so
 *    cadence walks between tiers instead of thrashing;
 * 3. **bounds** — clamped into `[bounds.minSeconds, bounds.maxSeconds]`. The
 *    floor wins if a caller passes a degenerate range (`min > max`): a rate
 *    budget is a safety constraint, not a preference;
 * 4. rounded to a whole number of seconds, never below 1.
 */
import { z } from "zod";
import { MarketValidationError } from "./errors.ts";

/** Namespaced key under `monitor_targets.config` holding adaptivity state. */
export const ADAPTIVE_CONFIG_KEY = "adaptive";

/** Auction-proximity thresholds (seconds until `listing_ends_at`). */
export const AUCTION_ENDGAME_SECONDS = 300;
export const AUCTION_NEAR_END_SECONDS = 1800;
export const AUCTION_APPROACHING_END_SECONDS = 21_600;

/** Activity thresholds (`recentEventCount + recentChangeCount`). */
export const ACTIVITY_HOT_COUNT = 8;
export const ACTIVITY_WARM_COUNT = 3;

/** Idle thresholds (consecutive unchanged polls). */
export const IDLE_STREAK_RELAXED = 6;
export const IDLE_STREAK_LONG = 12;
export const IDLE_STREAK_VERY_LONG = 24;

/** Largest change allowed between two consecutive computed intervals. */
export const MAX_STEP_FACTOR = 4;

/**
 * Bounds used when a caller supplies none. `minSeconds` is a conservative
 * politeness floor only — real deployments pass the per-connection rate
 * budget floor, which is always the stricter of the two.
 */
export const DEFAULT_ADAPTIVE_MIN_SECONDS = 30;
export const DEFAULT_ADAPTIVE_MAX_SECONDS = 86_400;

/** Default window for deriving `recent*` counts from stored history. */
export const DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS = 3600;

/** Tier names, in tightening-to-relaxing order (text + TS union, no enum). */
export const ADAPTIVE_TIERS = [
  "auction_endgame",
  "auction_near_end",
  "auction_approaching_end",
  "activity_hot",
  "activity_warm",
  "steady",
  "idle_relaxed",
  "idle_long",
  "idle_very_long",
] as const;
export type AdaptiveTier = (typeof ADAPTIVE_TIERS)[number];

/** The factor each tier applies to the operator's base interval. */
export const ADAPTIVE_TIER_FACTORS = {
  auction_endgame: 1 / 8,
  auction_near_end: 1 / 4,
  auction_approaching_end: 1 / 2,
  activity_hot: 1 / 4,
  activity_warm: 1 / 2,
  steady: 1,
  idle_relaxed: 2,
  idle_long: 4,
  idle_very_long: 8,
} as const satisfies Record<AdaptiveTier, number>;

export interface AdaptiveBounds {
  /** Hard floor — the caller's per-connection rate budget lives here. */
  minSeconds: number;
  /** Hard ceiling — a target must still be polled this often. */
  maxSeconds: number;
}

export interface AdaptiveIntervalInput {
  /** Operator-set `monitor_targets.interval_seconds`. */
  baseIntervalSeconds: number;
  /** `market_events` for this target's items in the recent window. */
  recentEventCount?: number;
  /** Observation `raw_state_hash` deltas in the recent window. */
  recentChangeCount?: number;
  /** Consecutive polls that observed no change. */
  unchangedStreak?: number;
  /** Seconds to the soonest future `listing_ends_at`; null/negative = none. */
  secondsUntilListingEnd?: number | null;
  /** Previously computed interval, for step damping (see module doc). */
  previousIntervalSeconds?: number | null;
  bounds?: Partial<AdaptiveBounds>;
}

export interface AdaptiveDecision {
  /** Seconds until the next poll — a whole number inside `bounds`. */
  intervalSeconds: number;
  tier: AdaptiveTier;
  /** The tier's factor (before damping/clamping). */
  factor: number;
  /** Which limit, if any, actually changed the value. */
  clampedBy: "min" | "max" | "step" | null;
  bounds: AdaptiveBounds;
}

function nonNegativeCount(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) {
    throw new MarketValidationError(`${label} must be a finite number`);
  }
  return Math.max(0, Math.floor(value));
}

function resolveBounds(
  bounds: Partial<AdaptiveBounds> | undefined,
): AdaptiveBounds {
  const minSeconds = bounds?.minSeconds ?? DEFAULT_ADAPTIVE_MIN_SECONDS;
  const maxSeconds = bounds?.maxSeconds ?? DEFAULT_ADAPTIVE_MAX_SECONDS;
  if (!Number.isFinite(minSeconds) || minSeconds < 1) {
    throw new MarketValidationError(
      "bounds.minSeconds must be a finite number of seconds >= 1",
    );
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds < 1) {
    throw new MarketValidationError(
      "bounds.maxSeconds must be a finite number of seconds >= 1",
    );
  }
  return { minSeconds: Math.ceil(minSeconds), maxSeconds: Math.floor(maxSeconds) };
}

/** Pick the tier (see the module doc's tables) — pure, total, order-fixed. */
export function selectAdaptiveTier(input: {
  activity: number;
  unchangedStreak: number;
  secondsUntilListingEnd: number | null;
}): AdaptiveTier {
  const { activity, unchangedStreak, secondsUntilListingEnd } = input;

  const auctionTier: AdaptiveTier | null =
    secondsUntilListingEnd === null
      ? null
      : secondsUntilListingEnd < AUCTION_ENDGAME_SECONDS
        ? "auction_endgame"
        : secondsUntilListingEnd < AUCTION_NEAR_END_SECONDS
          ? "auction_near_end"
          : secondsUntilListingEnd < AUCTION_APPROACHING_END_SECONDS
            ? "auction_approaching_end"
            : null;

  const activityTier: AdaptiveTier | null =
    activity >= ACTIVITY_HOT_COUNT
      ? "activity_hot"
      : activity >= ACTIVITY_WARM_COUNT
        ? "activity_warm"
        : null;

  // Tightening wins, most aggressive first.
  if (auctionTier !== null && activityTier !== null) {
    return ADAPTIVE_TIER_FACTORS[auctionTier] <=
      ADAPTIVE_TIER_FACTORS[activityTier]
      ? auctionTier
      : activityTier;
  }
  if (auctionTier !== null) return auctionTier;
  if (activityTier !== null) return activityTier;

  // Relax only when the window is genuinely quiet.
  if (activity === 0) {
    if (unchangedStreak >= IDLE_STREAK_VERY_LONG) return "idle_very_long";
    if (unchangedStreak >= IDLE_STREAK_LONG) return "idle_long";
    if (unchangedStreak >= IDLE_STREAK_RELAXED) return "idle_relaxed";
  }
  return "steady";
}

/**
 * Full policy evaluation: tier, factor, damping/clamping provenance, and the
 * resulting interval. {@link computeAdaptiveInterval} is the seconds-only
 * form. Pure — same inputs always produce the same decision.
 */
export function evaluateAdaptiveInterval(
  input: AdaptiveIntervalInput,
): AdaptiveDecision {
  const base = input.baseIntervalSeconds;
  if (!Number.isFinite(base) || base <= 0) {
    throw new MarketValidationError(
      "baseIntervalSeconds must be a positive finite number of seconds",
    );
  }
  const bounds = resolveBounds(input.bounds);
  const activity =
    nonNegativeCount(input.recentEventCount, "recentEventCount") +
    nonNegativeCount(input.recentChangeCount, "recentChangeCount");
  const unchangedStreak = nonNegativeCount(
    input.unchangedStreak,
    "unchangedStreak",
  );
  const rawEnd = input.secondsUntilListingEnd;
  // Negative (already ended) and non-finite values carry no auction signal.
  const secondsUntilListingEnd =
    rawEnd === null ||
    rawEnd === undefined ||
    !Number.isFinite(rawEnd) ||
    rawEnd < 0
      ? null
      : rawEnd;

  const tier = selectAdaptiveTier({
    activity,
    unchangedStreak,
    secondsUntilListingEnd,
  });
  const factor = ADAPTIVE_TIER_FACTORS[tier];

  let seconds = base * factor;
  let clampedBy: AdaptiveDecision["clampedBy"] = null;

  const previous = input.previousIntervalSeconds;
  if (previous !== null && previous !== undefined && previous > 0) {
    const floor = previous / MAX_STEP_FACTOR;
    const ceiling = previous * MAX_STEP_FACTOR;
    if (seconds < floor) {
      seconds = floor;
      clampedBy = "step";
    } else if (seconds > ceiling) {
      seconds = ceiling;
      clampedBy = "step";
    }
  }

  if (seconds > bounds.maxSeconds) {
    seconds = bounds.maxSeconds;
    clampedBy = "max";
  }
  // The rate-budget floor is applied last: it outranks every other rule,
  // including a caller-supplied ceiling below it.
  if (seconds < bounds.minSeconds) {
    seconds = bounds.minSeconds;
    clampedBy = "min";
  }

  return {
    intervalSeconds: Math.max(1, Math.round(seconds)),
    tier,
    factor,
    clampedBy,
    bounds,
  };
}

/** Seconds until the next poll under the documented policy (pure). */
export function computeAdaptiveInterval(input: AdaptiveIntervalInput): number {
  return evaluateAdaptiveInterval(input).intervalSeconds;
}

/**
 * Shape stored at `monitor_targets.config.adaptive`. Every field is optional
 * so a hand-written config stays valid; `enabled` is opt-OUT (adaptivity is
 * on unless `enabled: false`) and is the only operator-facing key. A
 * registered application setting supersedes it later.
 */
export const adaptiveConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  unchangedStreak: z.number().int().nonnegative().optional(),
  lastComputedInterval: z.number().int().positive().optional(),
  lastTier: z.enum(ADAPTIVE_TIERS).optional(),
  /** ISO-8601 instant of the poll that last wrote this state. */
  updatedAt: z.string().optional(),
});

export type AdaptiveConfig = z.infer<typeof adaptiveConfigSchema>;

/** Normalized view of `config.adaptive`, with defaults filled in. */
export interface AdaptiveState {
  enabled: boolean;
  unchangedStreak: number;
  lastComputedInterval: number | null;
  lastTier: AdaptiveTier | null;
  updatedAt: string | null;
}

/**
 * Read `config.adaptive` leniently: unknown/garbage state degrades to the
 * defaults (adaptivity enabled, no streak) instead of failing a poll. Only
 * {@link adaptiveConfigSchema} through the monitor service enforces shape.
 */
export function readAdaptiveState(config: unknown): AdaptiveState {
  const fallback: AdaptiveState = {
    enabled: true,
    unchangedStreak: 0,
    lastComputedInterval: null,
    lastTier: null,
    updatedAt: null,
  };
  if (typeof config !== "object" || config === null) return fallback;
  const raw = (config as Record<string, unknown>)[ADAPTIVE_CONFIG_KEY];
  if (typeof raw !== "object" || raw === null) return fallback;
  const parsed = adaptiveConfigSchema.safeParse(raw);
  const value: AdaptiveConfig = parsed.success ? parsed.data : {};
  return {
    enabled: value.enabled !== false,
    unchangedStreak: value.unchangedStreak ?? 0,
    lastComputedInterval: value.lastComputedInterval ?? null,
    lastTier: value.lastTier ?? null,
    updatedAt: value.updatedAt ?? null,
  };
}

/**
 * Next unchanged-streak value. Recording the same poll twice (at-least-once
 * retry: identical `at`) must NOT inflate the streak, so a replay keeps the
 * stored value and therefore recomputes the identical interval.
 */
export function nextUnchangedStreak(options: {
  state: AdaptiveState;
  changed: boolean;
  at: Date;
}): number {
  const { state, changed, at } = options;
  if (state.updatedAt !== null && state.updatedAt === at.toISOString()) {
    return state.unchangedStreak;
  }
  return changed ? 0 : state.unchangedStreak + 1;
}

/**
 * The transient state to merge into `config.adaptive`. `enabled` is
 * deliberately absent: the writer never overwrites the operator's toggle.
 */
export function adaptiveStatePatch(options: {
  unchangedStreak: number;
  decision: AdaptiveDecision;
  at: Date;
}): Required<Omit<AdaptiveConfig, "enabled">> {
  return {
    unchangedStreak: options.unchangedStreak,
    lastComputedInterval: options.decision.intervalSeconds,
    lastTier: options.decision.tier,
    updatedAt: options.at.toISOString(),
  };
}
