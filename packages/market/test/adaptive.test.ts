/**
 * Adaptive polling cadence (loxep-7dp.3):
 *
 * 1. a PURE policy matrix over `computeAdaptiveInterval` — every documented
 *    tier, bounds clamping (including the caller's rate-budget floor),
 *    auction-end tightening, idle relaxation curves, and step damping /
 *    stability between consecutive computations;
 * 2. integration against real PostgreSQL/TimescaleDB — `recordPollSuccess`
 *    with changed/unchanged sequences advances `next_poll_at` per policy and
 *    persists `config.adaptive`, the `enabled: false` opt-out and the
 *    no-adaptive-input call both fall back to the flat advance, and
 *    `collectAdaptiveSignals` derives activity from existing tables only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  ACTIVITY_HOT_COUNT,
  ACTIVITY_WARM_COUNT,
  ADAPTIVE_CONFIG_KEY,
  AUCTION_APPROACHING_END_SECONDS,
  AUCTION_ENDGAME_SECONDS,
  AUCTION_NEAR_END_SECONDS,
  DEFAULT_ADAPTIVE_MIN_SECONDS,
  IDLE_STREAK_LONG,
  IDLE_STREAK_RELAXED,
  IDLE_STREAK_VERY_LONG,
  MAX_STEP_FACTOR,
  MarketNotFoundError,
  MarketValidationError,
  claimDueTargets,
  collectAdaptiveSignals,
  computeAdaptiveInterval,
  createMonitorService,
  deriveMarketEvents,
  evaluateAdaptiveInterval,
  linkItemToMonitor,
  nextUnchangedStreak,
  readAdaptiveState,
  recordObservationBatch,
  recordPollSuccess,
  upsertMarketplaceItem,
} from "../src/index.ts";
import type { AdaptiveState, MonitorService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const BASE = 600;

describe("computeAdaptiveInterval (pure policy)", () => {
  it("returns the operator base when nothing is interesting", () => {
    expect(computeAdaptiveInterval({ baseIntervalSeconds: BASE })).toBe(BASE);
    expect(
      computeAdaptiveInterval({
        baseIntervalSeconds: BASE,
        recentEventCount: 1,
        recentChangeCount: 1,
        unchangedStreak: IDLE_STREAK_RELAXED - 1,
        secondsUntilListingEnd: null,
      }),
    ).toBe(BASE);
  });

  it("tightens by tier as an auction end approaches", () => {
    const at = (secondsUntilListingEnd: number) =>
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        secondsUntilListingEnd,
      });

    // 6 h .. 30 min → half the base.
    expect(at(AUCTION_APPROACHING_END_SECONDS).tier).toBe("steady");
    expect(at(AUCTION_APPROACHING_END_SECONDS - 1).tier).toBe(
      "auction_approaching_end",
    );
    expect(at(AUCTION_APPROACHING_END_SECONDS - 1).intervalSeconds).toBe(
      BASE / 2,
    );
    // 30 min .. 5 min → a quarter.
    expect(at(AUCTION_NEAR_END_SECONDS).tier).toBe("auction_approaching_end");
    expect(at(AUCTION_NEAR_END_SECONDS - 1).tier).toBe("auction_near_end");
    expect(at(AUCTION_NEAR_END_SECONDS - 1).intervalSeconds).toBe(BASE / 4);
    // under 5 min → an eighth (the policy floor before bounds).
    expect(at(AUCTION_ENDGAME_SECONDS).tier).toBe("auction_near_end");
    expect(at(AUCTION_ENDGAME_SECONDS - 1).tier).toBe("auction_endgame");
    expect(at(0).tier).toBe("auction_endgame");
    expect(at(0).intervalSeconds).toBe(BASE / 8);
  });

  it("ignores a listing that has already ended or has no end", () => {
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        secondsUntilListingEnd: -30,
      }).tier,
    ).toBe("steady");
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        secondsUntilListingEnd: null,
      }).tier,
    ).toBe("steady");
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        secondsUntilListingEnd: Number.POSITIVE_INFINITY,
      }).tier,
    ).toBe("steady");
  });

  it("tightens by tier with recent activity (events + hash deltas)", () => {
    const activity = (recentEventCount: number, recentChangeCount: number) =>
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        recentEventCount,
        recentChangeCount,
      });

    expect(activity(1, 1).tier).toBe("steady");
    expect(activity(ACTIVITY_WARM_COUNT, 0).tier).toBe("activity_warm");
    expect(activity(1, ACTIVITY_WARM_COUNT - 1).tier).toBe("activity_warm");
    expect(activity(ACTIVITY_WARM_COUNT, 0).intervalSeconds).toBe(BASE / 2);
    expect(activity(ACTIVITY_HOT_COUNT - 1, 0).tier).toBe("activity_warm");
    expect(activity(ACTIVITY_HOT_COUNT, 0).tier).toBe("activity_hot");
    expect(activity(4, 4).tier).toBe("activity_hot");
    expect(activity(ACTIVITY_HOT_COUNT, 0).intervalSeconds).toBe(BASE / 4);
  });

  it("lets the most aggressive tightening tier win", () => {
    // Auction endgame (1/8) beats hot activity (1/4)...
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        recentEventCount: 20,
        secondsUntilListingEnd: 60,
      }).tier,
    ).toBe("auction_endgame");
    // ...and hot activity beats a merely approaching end (1/2).
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        recentEventCount: 20,
        secondsUntilListingEnd: AUCTION_APPROACHING_END_SECONDS - 1,
      }).tier,
    ).toBe("activity_hot");
  });

  it("relaxes along the idle curve and never while the window is active", () => {
    const idle = (unchangedStreak: number, recentEventCount = 0) =>
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        unchangedStreak,
        recentEventCount,
      });

    expect(idle(IDLE_STREAK_RELAXED - 1).tier).toBe("steady");
    expect(idle(IDLE_STREAK_RELAXED).tier).toBe("idle_relaxed");
    expect(idle(IDLE_STREAK_RELAXED).intervalSeconds).toBe(BASE * 2);
    expect(idle(IDLE_STREAK_LONG).tier).toBe("idle_long");
    expect(idle(IDLE_STREAK_LONG).intervalSeconds).toBe(BASE * 4);
    expect(idle(IDLE_STREAK_VERY_LONG).tier).toBe("idle_very_long");
    expect(idle(IDLE_STREAK_VERY_LONG).intervalSeconds).toBe(BASE * 8);
    expect(idle(1000).tier).toBe("idle_very_long");

    // One recent event suppresses relaxation entirely, at any streak.
    expect(idle(IDLE_STREAK_VERY_LONG, 1).tier).toBe("steady");
    // An auction ending still tightens a long-idle target.
    expect(
      evaluateAdaptiveInterval({
        baseIntervalSeconds: BASE,
        unchangedStreak: IDLE_STREAK_VERY_LONG,
        secondsUntilListingEnd: 10,
      }).tier,
    ).toBe("auction_endgame");
  });

  it("never returns less than the caller's rate-budget floor", () => {
    // Default politeness floor.
    expect(
      computeAdaptiveInterval({
        baseIntervalSeconds: 60,
        secondsUntilListingEnd: 10,
      }),
    ).toBe(DEFAULT_ADAPTIVE_MIN_SECONDS);
    // Per-connection budget floor supplied by the caller.
    const budgeted = evaluateAdaptiveInterval({
      baseIntervalSeconds: 600,
      secondsUntilListingEnd: 10,
      bounds: { minSeconds: 120 },
    });
    expect(budgeted.intervalSeconds).toBe(120);
    expect(budgeted.clampedBy).toBe("min");
    // The floor outranks a ceiling below it — a rate budget is a safety rule.
    expect(
      computeAdaptiveInterval({
        baseIntervalSeconds: 600,
        bounds: { minSeconds: 900, maxSeconds: 300 },
      }),
    ).toBe(900);
  });

  it("never returns more than the ceiling", () => {
    const relaxed = evaluateAdaptiveInterval({
      baseIntervalSeconds: BASE,
      unchangedStreak: IDLE_STREAK_VERY_LONG,
      bounds: { maxSeconds: 1800 },
    });
    expect(relaxed.intervalSeconds).toBe(1800);
    expect(relaxed.clampedBy).toBe("max");
  });

  it("damps consecutive computations to a 4x step and is stable", () => {
    // A long-idle target that suddenly goes quiet-to-busy cannot jump the
    // whole 8x → 1/8 span in one poll.
    const step = evaluateAdaptiveInterval({
      baseIntervalSeconds: BASE,
      secondsUntilListingEnd: 10,
      previousIntervalSeconds: BASE * 8,
    });
    expect(step.intervalSeconds).toBe((BASE * 8) / MAX_STEP_FACTOR);
    expect(step.clampedBy).toBe("step");
    expect(step.tier).toBe("auction_endgame");

    // Repeated evaluation converges instead of oscillating.
    let previous: number = BASE * 8;
    const walk: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      previous = computeAdaptiveInterval({
        baseIntervalSeconds: BASE,
        secondsUntilListingEnd: 10,
        previousIntervalSeconds: previous,
      });
      walk.push(previous);
    }
    expect(walk).toEqual([1200, 300, 75, 75]);

    // Pure: identical inputs always produce identical output.
    const input = {
      baseIntervalSeconds: BASE,
      recentEventCount: 4,
      unchangedStreak: 3,
      secondsUntilListingEnd: 4000,
      previousIntervalSeconds: 900,
    };
    expect(computeAdaptiveInterval(input)).toBe(computeAdaptiveInterval(input));
  });

  it("returns whole seconds and rejects nonsensical inputs", () => {
    expect(
      Number.isInteger(
        computeAdaptiveInterval({
          baseIntervalSeconds: 7,
          secondsUntilListingEnd: 10,
          bounds: { minSeconds: 1 },
        }),
      ),
    ).toBe(true);
    expect(() => computeAdaptiveInterval({ baseIntervalSeconds: 0 })).toThrow(
      MarketValidationError,
    );
    expect(() =>
      computeAdaptiveInterval({ baseIntervalSeconds: Number.NaN }),
    ).toThrow(MarketValidationError);
    expect(() =>
      computeAdaptiveInterval({
        baseIntervalSeconds: BASE,
        bounds: { minSeconds: 0 },
      }),
    ).toThrow(MarketValidationError);
    expect(() =>
      computeAdaptiveInterval({
        baseIntervalSeconds: BASE,
        recentEventCount: Number.NaN,
      }),
    ).toThrow(MarketValidationError);
  });
});

describe("adaptive config state (pure)", () => {
  it("reads defaults from absent, foreign, or malformed config", () => {
    const defaults: AdaptiveState = {
      enabled: true,
      unchangedStreak: 0,
      lastComputedInterval: null,
      lastTier: null,
      updatedAt: null,
    };
    expect(readAdaptiveState(undefined)).toEqual(defaults);
    expect(readAdaptiveState({})).toEqual(defaults);
    expect(readAdaptiveState({ externalItemId: "1" })).toEqual(defaults);
    expect(readAdaptiveState({ adaptive: "nonsense" })).toEqual(defaults);
    expect(readAdaptiveState({ adaptive: { unchangedStreak: -3 } })).toEqual(
      defaults,
    );
  });

  it("treats the toggle as opt-out and round-trips stored state", () => {
    expect(readAdaptiveState({ adaptive: { enabled: false } }).enabled).toBe(
      false,
    );
    expect(readAdaptiveState({ adaptive: {} }).enabled).toBe(true);
    expect(
      readAdaptiveState({
        [ADAPTIVE_CONFIG_KEY]: {
          unchangedStreak: 7,
          lastComputedInterval: 1200,
          lastTier: "idle_relaxed",
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
      }),
    ).toEqual({
      enabled: true,
      unchangedStreak: 7,
      lastComputedInterval: 1200,
      lastTier: "idle_relaxed",
      updatedAt: "2026-08-11T12:00:00.000Z",
    });
  });

  it("does not inflate the streak when the same poll is replayed", () => {
    const at = new Date("2026-08-11T12:00:00.000Z");
    const state = readAdaptiveState({
      adaptive: { unchangedStreak: 3, updatedAt: at.toISOString() },
    });
    expect(nextUnchangedStreak({ state, changed: false, at })).toBe(3);
    expect(
      nextUnchangedStreak({
        state,
        changed: false,
        at: new Date(at.getTime() + 1000),
      }),
    ).toBe(4);
    expect(
      nextUnchangedStreak({
        state,
        changed: true,
        at: new Date(at.getTime() + 1000),
      }),
    ).toBe(0);
  });
});

const dbName = scratchDbName("loxep_test_adaptive");
let handle: DbHandle;
let service: MonitorService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  service = createMonitorService({ db: handle.db });
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

const T0 = new Date("2026-08-11T12:00:00.000Z");

function adaptiveOf(config: unknown): AdaptiveState {
  return readAdaptiveState(config);
}

describe("recordPollSuccess adaptive advancement", () => {
  it("relaxes across an unchanged streak and snaps back when change returns", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "idle-then-busy",
      intervalSeconds: BASE,
    });

    // 5 unchanged polls: still the operator base (streak below the tier).
    let at = T0;
    for (let i = 1; i <= IDLE_STREAK_RELAXED - 1; i += 1) {
      at = new Date(T0.getTime() + i * 600_000);
      const result = await recordPollSuccess(handle.db, target.id, {
        at,
        changed: false,
      });
      expect(result.adaptive?.tier).toBe("steady");
      expect(result.adaptive?.unchangedStreak).toBe(i);
      expect(result.nextPollAt?.getTime()).toBe(at.getTime() + BASE * 1000);
    }

    // Streak 6 → 2x; the state persisted in config.adaptive drives it.
    at = new Date(T0.getTime() + IDLE_STREAK_RELAXED * 600_000);
    const relaxed = await recordPollSuccess(handle.db, target.id, {
      at,
      changed: false,
    });
    expect(relaxed.adaptive?.tier).toBe("idle_relaxed");
    expect(relaxed.adaptive?.intervalSeconds).toBe(BASE * 2);
    expect(relaxed.nextPollAt?.getTime()).toBe(at.getTime() + BASE * 2000);

    const stored = await service.getTarget(target.id);
    // interval_seconds is untouched: it stays the operator-set BASE.
    expect(stored.intervalSeconds).toBe(BASE);
    expect(stored.nextPollAt?.getTime()).toBe(at.getTime() + BASE * 2000);
    expect(stored.lastPollAt?.getTime()).toBe(at.getTime());
    expect(stored.lastSuccessAt?.getTime()).toBe(at.getTime());
    expect(adaptiveOf(stored.config)).toEqual({
      enabled: true,
      unchangedStreak: IDLE_STREAK_RELAXED,
      lastComputedInterval: BASE * 2,
      lastTier: "idle_relaxed",
      updatedAt: at.toISOString(),
    });

    // Walk out to the longest idle tier.
    for (let i = IDLE_STREAK_RELAXED + 1; i <= IDLE_STREAK_VERY_LONG; i += 1) {
      at = new Date(T0.getTime() + i * 600_000);
      await recordPollSuccess(handle.db, target.id, { at, changed: false });
    }
    const veryIdle = adaptiveOf((await service.getTarget(target.id)).config);
    expect(veryIdle.lastTier).toBe("idle_very_long");
    expect(veryIdle.lastComputedInterval).toBe(BASE * 8);

    // Change returns: the streak resets, and step damping walks the cadence
    // back down 4x per poll instead of thrashing straight to the base.
    at = new Date(at.getTime() + 600_000);
    const firstChange = await recordPollSuccess(handle.db, target.id, {
      at,
      changed: true,
    });
    expect(firstChange.adaptive?.unchangedStreak).toBe(0);
    expect(firstChange.adaptive?.tier).toBe("steady");
    expect(firstChange.adaptive?.clampedBy).toBe("step");
    expect(firstChange.adaptive?.intervalSeconds).toBe(
      (BASE * 8) / MAX_STEP_FACTOR,
    );

    at = new Date(at.getTime() + 600_000);
    const secondChange = await recordPollSuccess(handle.db, target.id, {
      at,
      changed: true,
    });
    expect(secondChange.adaptive?.intervalSeconds).toBe(BASE);
    expect(secondChange.nextPollAt?.getTime()).toBe(at.getTime() + BASE * 1000);
  });

  it("tightens toward the rate-budget floor as an auction ends", async () => {
    const target = await service.createTarget({
      targetType: "ebay_item",
      name: "auction-endgame",
      intervalSeconds: BASE,
      config: { externalItemId: "auction-1" },
    });
    const near = await recordPollSuccess(handle.db, target.id, {
      at: T0,
      changed: true,
      secondsUntilListingEnd: 120,
    });
    expect(near.adaptive?.tier).toBe("auction_endgame");
    expect(near.adaptive?.intervalSeconds).toBe(BASE / 8);
    expect(near.nextPollAt?.getTime()).toBe(T0.getTime() + (BASE / 8) * 1000);

    // The caller's per-connection budget floor wins over the tier.
    const budgeted = await recordPollSuccess(handle.db, target.id, {
      at: new Date(T0.getTime() + 75_000),
      changed: true,
      secondsUntilListingEnd: 45,
      bounds: { minSeconds: 120 },
    });
    expect(budgeted.adaptive?.clampedBy).toBe("min");
    expect(budgeted.adaptive?.intervalSeconds).toBe(120);

    // The item config key survives every scheduler write.
    const stored = await service.getTarget(target.id);
    expect((stored.config as Record<string, unknown>)["externalItemId"]).toBe(
      "auction-1",
    );
    expect(adaptiveOf(stored.config).lastTier).toBe("auction_endgame");
  });

  it("is idempotent when the same poll outcome is replayed", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "replayed-poll",
      intervalSeconds: BASE,
    });
    const at = new Date(T0.getTime() + 3_600_000);
    const first = await recordPollSuccess(handle.db, target.id, {
      at,
      changed: false,
    });
    const second = await recordPollSuccess(handle.db, target.id, {
      at,
      changed: false,
    });
    expect(second.adaptive?.unchangedStreak).toBe(
      first.adaptive?.unchangedStreak,
    );
    expect(second.adaptive?.intervalSeconds).toBe(
      first.adaptive?.intervalSeconds,
    );
    expect(second.nextPollAt?.getTime()).toBe(first.nextPollAt?.getTime());
  });

  it("falls back to the flat advance when adaptivity is disabled", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "adaptivity-off",
      intervalSeconds: BASE,
      config: { adaptive: { enabled: false } },
      nextPollAt: new Date(T0.getTime() - 1000),
    });
    const claimed = await claimDueTargets(handle.db, { now: T0, limit: 100 });
    expect(claimed.map((t) => t.id)).toContain(target.id);
    const afterClaim = await service.getTarget(target.id);
    // Flat claim advance: now + interval_seconds.
    expect(afterClaim.nextPollAt?.getTime()).toBe(T0.getTime() + BASE * 1000);

    const result = await recordPollSuccess(handle.db, target.id, {
      at: T0,
      changed: false,
      secondsUntilListingEnd: 10,
    });
    expect(result.adaptive).toBeNull();
    expect(result.nextPollAt).toBeNull();
    const stored = await service.getTarget(target.id);
    // next_poll_at keeps the claim's flat advance; no streak state written.
    expect(stored.nextPollAt?.getTime()).toBe(T0.getTime() + BASE * 1000);
    expect(stored.config).toEqual({ adaptive: { enabled: false } });
    expect(stored.lastSuccessAt?.getTime()).toBe(T0.getTime());
  });

  it("keeps the historical flat behaviour when no adaptive facts are given", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "no-adaptive-input",
      intervalSeconds: BASE,
      nextPollAt: new Date(T0.getTime() - 1000),
    });
    await claimDueTargets(handle.db, { now: T0, limit: 100 });
    const result = await recordPollSuccess(handle.db, target.id, { at: T0 });
    expect(result).toEqual({ adaptive: null, nextPollAt: null });
    const stored = await service.getTarget(target.id);
    expect(stored.nextPollAt?.getTime()).toBe(T0.getTime() + BASE * 1000);
    expect(stored.config).toEqual({});
  });

  it("still reports unknown targets on the adaptive path", async () => {
    await expect(
      recordPollSuccess(handle.db, "00000000-0000-4000-8000-000000000000", {
        changed: true,
      }),
    ).rejects.toThrow(MarketNotFoundError);
  });

  it("survives a monitor-service update of an unrelated field", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "config-round-trip",
      intervalSeconds: BASE,
    });
    await recordPollSuccess(handle.db, target.id, {
      at: new Date(T0.getTime() + 7_200_000),
      changed: false,
    });
    // Re-validating the config through the service must accept the
    // namespaced adaptive key rather than rejecting it as unknown.
    const renamed = await service.updateTarget(target.id, {
      name: "config-round-trip-2",
      config: (await service.getTarget(target.id)).config,
    });
    expect(adaptiveOf(renamed.config).unchangedStreak).toBe(1);
  });
});

describe("collectAdaptiveSignals", () => {
  it("derives events, hash deltas, and auction proximity from existing tables", async () => {
    const target = await service.createTarget({
      targetType: "ebay_item",
      name: "signal-source",
      intervalSeconds: BASE,
      config: { externalItemId: "signal-1" },
    });
    const now = new Date(T0.getTime() + 10_800_000);
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: `signal-${randomUUID()}`,
        seenAt: now,
        listingType: "auction",
        listingEndsAt: new Date(now.getTime() + 600_000),
      },
    });
    await linkItemToMonitor(handle.db, {
      monitorTargetId: target.id,
      marketplaceItemId: item.id,
      at: now,
    });

    // Three observations: two hash deltas, one repeat (no delta).
    const hashes = ["h1", "h2", "h2", "h3"];
    for (const [index, rawStateHash] of hashes.entries()) {
      await recordObservationBatch({
        db: handle.db,
        batch: {
          observationBatchId: randomUUID(),
          observedAt: new Date(now.getTime() - (hashes.length - index) * 60_000),
          source: "test",
          items: [
            {
              marketplaceItemId: item.id,
              price: `${10 + index}.00`,
              rawStateHash,
            },
          ],
        },
      });
    }
    await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      monitorTargetId: target.id,
      previous: { observedAt: new Date(now.getTime() - 120_000), price: "12.00" },
      current: { observedAt: new Date(now.getTime() - 60_000), price: "9.00" },
      detectedAt: new Date(now.getTime() - 60_000),
    });

    const signals = await collectAdaptiveSignals(handle.db, target.id, { now });
    // price_changed + price_dropped from one transition.
    expect(signals.recentEventCount).toBe(2);
    expect(signals.recentChangeCount).toBe(2);
    expect(signals.secondsUntilListingEnd).toBeCloseTo(600, 0);
    expect(signals.windowSeconds).toBe(3600);

    // A window that excludes the history sees nothing.
    const narrow = await collectAdaptiveSignals(handle.db, target.id, {
      now,
      windowSeconds: 30,
    });
    expect(narrow.recentEventCount).toBe(0);
    expect(narrow.recentChangeCount).toBe(0);

    // deriveSignals wires those numbers into the policy: activity 4 (warm,
    // 1/2) loses to the 10-minute auction end (near-end, 1/4).
    const result = await recordPollSuccess(handle.db, target.id, {
      at: now,
      changed: true,
      deriveSignals: true,
    });
    expect(result.adaptive?.tier).toBe("auction_near_end");
    expect(result.adaptive?.intervalSeconds).toBe(BASE / 4);

    await expect(
      collectAdaptiveSignals(handle.db, target.id, { now, windowSeconds: 0 }),
    ).rejects.toThrow(MarketValidationError);
  });

  it("returns zeroes and no auction signal for a target with no history", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "no-history",
      intervalSeconds: BASE,
    });
    expect(await collectAdaptiveSignals(handle.db, target.id)).toEqual({
      recentEventCount: 0,
      recentChangeCount: 0,
      secondsUntilListingEnd: null,
      windowSeconds: 3600,
    });
  });
});
