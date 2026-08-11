/**
 * Monitor scheduling integration tests (loxep-ubx.1) against real
 * PostgreSQL/TimescaleDB: CRUD + config validation, SKIP LOCKED claim
 * atomicity under concurrency, and backoff bookkeeping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  MAX_BACKOFF_SECONDS,
  MarketNotFoundError,
  MarketValidationError,
  backoffSeconds,
  claimDueTargets,
  createMonitorService,
  recordPollFailure,
  recordPollSuccess,
} from "../src/index.ts";
import type { MonitorService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_monitors");
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

describe("backoffSeconds", () => {
  it("doubles per consecutive error and caps at one hour", () => {
    expect(backoffSeconds(60, 1)).toBe(120);
    expect(backoffSeconds(60, 2)).toBe(240);
    expect(backoffSeconds(60, 5)).toBe(1920);
    expect(backoffSeconds(60, 6)).toBe(MAX_BACKOFF_SECONDS);
    expect(backoffSeconds(60, 50)).toBe(MAX_BACKOFF_SECONDS);
    expect(backoffSeconds(7200, 0)).toBe(MAX_BACKOFF_SECONDS);
  });
});

describe("monitor target CRUD", () => {
  it("creates, reads, updates, and deletes a target", async () => {
    const created = await service.createTarget({
      targetType: "ebay_item",
      name: "watch one listing",
      intervalSeconds: 300,
      config: { externalItemId: "1234567890" },
    });
    expect(created.enabled).toBe(true);
    expect(created.priority).toBe(0);
    expect(created.consecutiveErrors).toBe(0);
    expect(created.nextPollAt).toBeInstanceOf(Date);
    expect(created.config).toEqual({ externalItemId: "1234567890" });

    const fetched = await service.getTarget(created.id);
    expect(fetched.name).toBe("watch one listing");

    const updated = await service.updateTarget(created.id, {
      name: "renamed",
      intervalSeconds: 600,
      priority: 5,
      enabled: false,
    });
    expect(updated.name).toBe("renamed");
    expect(updated.intervalSeconds).toBe(600);
    expect(updated.priority).toBe(5);
    expect(updated.enabled).toBe(false);
    // Untouched fields survive the update.
    expect(updated.config).toEqual({ externalItemId: "1234567890" });

    await service.deleteTarget(created.id);
    await expect(service.getTarget(created.id)).rejects.toThrow(
      MarketNotFoundError,
    );
  });

  it("validates config per target type", async () => {
    await expect(
      service.createTarget({
        targetType: "ebay_item",
        name: "missing external id",
        intervalSeconds: 300,
        config: {},
      }),
    ).rejects.toThrow(MarketValidationError);
    await expect(
      service.createTarget({
        targetType: "ebay_watchlist",
        name: "unexpected key",
        intervalSeconds: 300,
        config: { externalItemId: "not-allowed-here" },
      }),
    ).rejects.toThrow(MarketValidationError);
    // Watchlist accepts an empty config.
    const watchlist = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "my watchlist",
      intervalSeconds: 300,
    });
    expect(watchlist.config).toEqual({});
  });

  it("rejects unknown target types and bad intervals", async () => {
    await expect(
      service.createTarget({
        // @ts-expect-error — intentionally invalid target type
        targetType: "ebay_search",
        name: "later phase",
        intervalSeconds: 300,
      }),
    ).rejects.toThrow();
    await expect(
      service.createTarget({
        targetType: "ebay_watchlist",
        name: "zero interval",
        intervalSeconds: 0,
      }),
    ).rejects.toThrow();
  });

  it("re-validates config against a changed target type", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "will become item monitor",
      intervalSeconds: 300,
    });
    // Changing type without a valid config for that type must fail.
    await expect(
      service.updateTarget(target.id, { targetType: "ebay_item" }),
    ).rejects.toThrow(MarketValidationError);
    const updated = await service.updateTarget(target.id, {
      targetType: "ebay_item",
      config: { externalItemId: "999" },
    });
    expect(updated.targetType).toBe("ebay_item");
  });
});

describe("claimDueTargets", () => {
  async function createDueTargets(count: number, prefix: string) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const target = await service.createTarget({
        targetType: "ebay_watchlist",
        name: `${prefix}-${i}`,
        intervalSeconds: 60,
        nextPollAt: new Date(Date.now() - 1000),
      });
      ids.push(target.id);
    }
    return ids;
  }

  it("two concurrent claims over 10 due targets partition them disjointly", async () => {
    const ids = await createDueTargets(10, "claim-race");
    const now = new Date();
    // Two separate pooled connections claim concurrently; SKIP LOCKED must
    // partition the due set with no overlap and no loss.
    const [a, b] = await Promise.all([
      claimDueTargets(handle.db, { now, limit: 10 }),
      claimDueTargets(handle.db, { now, limit: 10 }),
    ]);
    const claimedIds = [...a, ...b]
      .map((t) => t.id)
      .filter((id) => ids.includes(id));
    expect(claimedIds).toHaveLength(10);
    expect(new Set(claimedIds).size).toBe(10);

    // Every claimed target advanced next_poll_at to now + interval.
    for (const target of [...a, ...b]) {
      if (!ids.includes(target.id)) continue;
      expect(target.nextPollAt.getTime()).toBe(now.getTime() + 60_000);
      const row = await service.getTarget(target.id);
      expect(row.nextPollAt?.getTime()).toBe(now.getTime() + 60_000);
    }

    // Re-claiming immediately finds nothing: next_poll_at moved forward.
    const again = await claimDueTargets(handle.db, { now, limit: 100 });
    expect(again.filter((t) => ids.includes(t.id))).toHaveLength(0);
  });

  it("skips disabled, future-scheduled, and backing-off targets", async () => {
    const now = new Date();
    const disabled = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "disabled",
      intervalSeconds: 60,
      enabled: false,
      nextPollAt: new Date(now.getTime() - 1000),
    });
    const future = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "future",
      intervalSeconds: 60,
      nextPollAt: new Date(now.getTime() + 60_000),
    });
    const backingOff = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "backing-off",
      intervalSeconds: 60,
      nextPollAt: new Date(now.getTime() - 1000),
    });
    await recordPollFailure(handle.db, backingOff.id, { at: now });

    const claimed = await claimDueTargets(handle.db, { now, limit: 100 });
    const claimedIds = claimed.map((t) => t.id);
    expect(claimedIds).not.toContain(disabled.id);
    expect(claimedIds).not.toContain(future.id);
    expect(claimedIds).not.toContain(backingOff.id);

    // Once the backoff window has passed, the target is claimable again.
    const afterBackoff = new Date(now.getTime() + 121_000);
    const later = await claimDueTargets(handle.db, {
      now: afterBackoff,
      limit: 100,
    });
    expect(later.map((t) => t.id)).toContain(backingOff.id);
  });

  it("claims lower priority values first when the limit is contended", async () => {
    const now = new Date();
    const low = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "prio-9",
      intervalSeconds: 60,
      priority: 9,
      nextPollAt: new Date(now.getTime() - 1000),
    });
    const high = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "prio-0",
      intervalSeconds: 60,
      priority: 0,
      nextPollAt: new Date(now.getTime() - 1000),
    });
    // Only these two are due at `now`; with limit 1 the smaller priority
    // value wins the claim (Graphile Worker convention).
    const first = await claimDueTargets(handle.db, { now, limit: 1 });
    expect(first.map((t) => t.id)).toEqual([high.id]);
    const second = await claimDueTargets(handle.db, { now, limit: 1 });
    expect(second.map((t) => t.id)).toEqual([low.id]);
  });
});

describe("poll outcome bookkeeping", () => {
  it("recordPollFailure applies capped exponential backoff and recordPollSuccess resets it", async () => {
    const target = await service.createTarget({
      targetType: "ebay_watchlist",
      name: "backoff-math",
      intervalSeconds: 60,
    });
    const at = new Date("2026-08-11T12:00:00.000Z");

    const first = await recordPollFailure(handle.db, target.id, { at });
    expect(first.consecutiveErrors).toBe(1);
    expect(first.backoffUntil.getTime()).toBe(
      at.getTime() + backoffSeconds(60, 1) * 1000,
    );

    const second = await recordPollFailure(handle.db, target.id, { at });
    expect(second.consecutiveErrors).toBe(2);
    expect(second.backoffUntil.getTime()).toBe(
      at.getTime() + backoffSeconds(60, 2) * 1000,
    );

    // Drive to the cap: 60 * 2^6 = 3840 > 3600.
    let last = second;
    for (let i = 3; i <= 6; i += 1) {
      last = await recordPollFailure(handle.db, target.id, { at });
    }
    expect(last.consecutiveErrors).toBe(6);
    expect(last.backoffUntil.getTime()).toBe(
      at.getTime() + MAX_BACKOFF_SECONDS * 1000,
    );

    const successAt = new Date(at.getTime() + 10_000);
    await recordPollSuccess(handle.db, target.id, { at: successAt });
    const row = await service.getTarget(target.id);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.backoffUntil).toBeNull();
    expect(row.lastPollAt?.getTime()).toBe(successAt.getTime());
    expect(row.lastSuccessAt?.getTime()).toBe(successAt.getTime());
  });

  it("throws MarketNotFoundError for unknown targets", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(recordPollSuccess(handle.db, ghost)).rejects.toThrow(
      MarketNotFoundError,
    );
    await expect(recordPollFailure(handle.db, ghost)).rejects.toThrow(
      MarketNotFoundError,
    );
  });
});
