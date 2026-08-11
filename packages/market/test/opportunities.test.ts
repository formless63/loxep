/**
 * Opportunity rules and scoring tests (loxep-7dp.5): the declarative
 * condition-grammar validation matrix, the pure evaluation matrix, first-wins
 * `market_events.rule_id` stamping, rule CRUD, and an end-to-end pass from
 * `deriveMarketEvents` into `evaluateRulesForEvent`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { marketEvents } from "@loxep/db/schema";
import {
  OPPORTUNITY_PAYLOAD_KEY,
  createMonitorService,
  createOpportunityRulesService,
  deriveMarketEvents,
  evaluateRule,
  evaluateRulesForEvent,
  listEnabledRulesForEvaluation,
  opportunityConditionsSchema,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "../src/index.ts";
import type {
  ObservationSnapshot,
  OpportunityContext,
  OpportunityRuleDefinition,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_opportunities");
let handle: DbHandle;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

const t1 = new Date("2026-08-11T10:00:00.000Z");
const t2 = new Date("2026-08-11T10:05:00.000Z");

const ITEM_ID = "00000000-0000-4000-8000-00000000aaaa";
const TARGET_ID = "00000000-0000-4000-8000-00000000bbbb";

function snap(
  fields: Omit<ObservationSnapshot, "observedAt">,
  observedAt = t2,
): ObservationSnapshot {
  return { observedAt, ...fields };
}

function rule(
  conditions: unknown,
  overrides: Partial<OpportunityRuleDefinition> = {},
): OpportunityRuleDefinition {
  return {
    id: "00000000-0000-4000-8000-00000000cccc",
    name: "test rule",
    priority: 0,
    scoreWeight: "1.0000",
    conditions,
    ...overrides,
  };
}

function context(
  previous: ObservationSnapshot | null,
  current: ObservationSnapshot | null,
  event: Partial<OpportunityContext["event"]> = {},
): OpportunityContext {
  return {
    event: {
      eventType: "price_dropped",
      marketplaceItemId: ITEM_ID,
      monitorTargetId: TARGET_ID,
      ...event,
    },
    previousObservation: previous,
    currentObservation: current,
  };
}

describe("condition grammar validation", () => {
  it("accepts every documented group and predicate", () => {
    const parsed = opportunityConditionsSchema.parse({
      eventTypes: ["price_dropped", "restocked"],
      price: { maxPrice: "100.00", minDropAmount: "5", minDropPercent: 10 },
      quantity: { minAvailable: 1, maxAvailable: 10, minIncrease: 2 },
      listing: {
        stateIn: ["active"],
        stateNotIn: ["ended"],
        availabilityIn: ["in_stock"],
        transitionedTo: "active",
      },
      scope: { monitorTargetIds: [TARGET_ID], marketplaceItemIds: [ITEM_ID] },
    });
    expect(parsed.price?.minDropPercent).toBe(10);
  });

  it("rejects empty conditions and empty groups", () => {
    expect(opportunityConditionsSchema.safeParse({}).success).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ price: {} }).success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ quantity: {} }).success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ listing: {} }).success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ scope: {} }).success,
    ).toBe(false);
  });

  it("rejects unknown keys, unknown event types, and duplicates", () => {
    expect(
      opportunityConditionsSchema.safeParse({ nonsense: true }).success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ price: { minPrice: "1" } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ eventTypes: ["exploded"] })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({
        eventTypes: ["price_dropped", "price_dropped"],
      }).success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ eventTypes: [] }).success,
    ).toBe(false);
  });

  it("rejects out-of-range and mistyped predicate values", () => {
    expect(
      opportunityConditionsSchema.safeParse({ price: { minDropPercent: 0 } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ price: { minDropPercent: 101 } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ price: { maxPrice: "cheap" } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ quantity: { minAvailable: 1.5 } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ quantity: { minIncrease: 0 } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ scope: { monitorTargetIds: ["x"] } })
        .success,
    ).toBe(false);
    expect(
      opportunityConditionsSchema.safeParse({ listing: { stateIn: [] } })
        .success,
    ).toBe(false);
  });
});

describe("evaluateRule (pure)", () => {
  it("matches an event-type filter and scores weight * 1", () => {
    const result = evaluateRule(
      rule({ eventTypes: ["price_dropped"] }, { scoreWeight: "2.5000" }),
      context(snap({ price: "10.00" }, t1), snap({ price: "9.00" })),
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(2.5);
    expect(result.reasons).toEqual([
      "eventTypes: price_dropped vs [price_dropped]",
    ]);
  });

  it("does not match a different event type and explains why", () => {
    const result = evaluateRule(
      rule({ eventTypes: ["restocked"] }),
      context(snap({ price: "10.00" }, t1), snap({ price: "9.00" })),
    );
    expect(result).toEqual({
      matched: false,
      score: 0,
      reasons: ["eventTypes: price_dropped vs [restocked]"],
    });
  });

  it("evaluates absolute price thresholds exactly", () => {
    const conditions = { price: { maxPrice: "20.00", minDropAmount: "5" } };
    const matched = evaluateRule(
      rule(conditions),
      context(snap({ price: "25.00" }, t1), snap({ price: "20.00" })),
    );
    expect(matched.matched).toBe(true);
    // Two predicates, weight 1 → 2.
    expect(matched.score).toBe(2);

    const tooSmallDrop = evaluateRule(
      rule(conditions),
      context(snap({ price: "24.99" }, t1), snap({ price: "20.00" })),
    );
    expect(tooSmallDrop.matched).toBe(false);
    expect(tooSmallDrop.reasons).toEqual(["price.minDropAmount: drop 4.99 >= 5"]);

    const overMax = evaluateRule(
      rule(conditions),
      context(snap({ price: "30.00" }, t1), snap({ price: "20.01" })),
    );
    expect(overMax.matched).toBe(false);
    expect(overMax.reasons).toEqual(["price.maxPrice: 20.01 <= 20.00"]);
  });

  it("grades percent drops: contribution = 1 + percent/100", () => {
    const conditions = { price: { minDropPercent: 10 } };
    const twenty = evaluateRule(
      rule(conditions, { scoreWeight: "1.0000" }),
      context(snap({ price: "100.00" }, t1), snap({ price: "80.00" })),
    );
    expect(twenty.matched).toBe(true);
    expect(twenty.score).toBe(1.2);

    const half = evaluateRule(
      rule(conditions, { scoreWeight: "2.0000" }),
      context(snap({ price: "100.00" }, t1), snap({ price: "50.00" })),
    );
    // weight 2 * (1 + 0.5) = 3
    expect(half.score).toBe(3);

    const free = evaluateRule(
      rule(conditions),
      context(snap({ price: "100.00" }, t1), snap({ price: "0" })),
    );
    // Capped at 100% → contribution 2.
    expect(free.score).toBe(2);

    const tooShallow = evaluateRule(
      rule(conditions),
      context(snap({ price: "100.00" }, t1), snap({ price: "95.00" })),
    );
    expect(tooShallow.matched).toBe(false);
    expect(tooShallow.reasons[0]).toContain("5% >= 10%");
  });

  it("treats unknown inputs as failures, never vacuous matches", () => {
    const noPrevious = evaluateRule(
      rule({ price: { minDropPercent: 10 } }),
      context(null, snap({ price: "10.00" })),
    );
    expect(noPrevious.matched).toBe(false);
    expect(noPrevious.reasons).toEqual([
      "price.minDropPercent: both observations must carry a price",
    ]);

    const nullPrice = evaluateRule(
      rule({ price: { maxPrice: "10" } }),
      context(snap({ price: "20.00" }, t1), snap({ price: null })),
    );
    expect(nullPrice.matched).toBe(false);

    const zeroBase = evaluateRule(
      rule({ price: { minDropPercent: 10 } }),
      context(snap({ price: "0" }, t1), snap({ price: "0" })),
    );
    expect(zeroBase.reasons).toEqual([
      "price.minDropPercent: previous price is not positive",
    ]);

    const unknownQuantity = evaluateRule(
      rule({ quantity: { minAvailable: 1 } }),
      context(snap({}, t1), snap({})),
    );
    expect(unknownQuantity.matched).toBe(false);
  });

  it("evaluates quantity thresholds and increases", () => {
    const restock = evaluateRule(
      rule({ quantity: { minIncrease: 3, minAvailable: 2 } }),
      context(
        snap({ quantityAvailable: 0 }, t1),
        snap({ quantityAvailable: 4 }),
      ),
    );
    expect(restock.matched).toBe(true);
    expect(restock.score).toBe(2);

    const tooSmall = evaluateRule(
      rule({ quantity: { minIncrease: 3 } }),
      context(
        snap({ quantityAvailable: 1 }, t1),
        snap({ quantityAvailable: 2 }),
      ),
    );
    expect(tooSmall.matched).toBe(false);

    const capped = evaluateRule(
      rule({ quantity: { maxAvailable: 2 } }),
      context(
        snap({ quantityAvailable: 0 }, t1),
        snap({ quantityAvailable: 5 }),
      ),
    );
    expect(capped.matched).toBe(false);
  });

  it("evaluates listing-state predicates and transitions", () => {
    const active = evaluateRule(
      rule({
        listing: {
          stateIn: ["active"],
          stateNotIn: ["ended"],
          availabilityIn: ["in_stock"],
        },
      }),
      context(
        snap({ listingState: "active" }, t1),
        snap({ listingState: "active", availability: "in_stock" }),
      ),
    );
    expect(active.matched).toBe(true);
    expect(active.score).toBe(3);

    const ended = evaluateRule(
      rule({ listing: { transitionedTo: "ended" } }),
      context(snap({ listingState: "active" }, t1), snap({ listingState: "ended" })),
    );
    expect(ended.matched).toBe(true);

    const alreadyEnded = evaluateRule(
      rule({ listing: { transitionedTo: "ended" } }),
      context(snap({ listingState: "ended" }, t1), snap({ listingState: "ended" })),
    );
    expect(alreadyEnded.matched).toBe(false);

    const unknownState = evaluateRule(
      rule({ listing: { stateNotIn: ["ended"] } }),
      context(snap({}, t1), snap({})),
    );
    expect(unknownState.matched).toBe(false);
  });

  it("scopes by monitor target and marketplace item", () => {
    const scoped = { scope: { monitorTargetIds: [TARGET_ID] } };
    expect(
      evaluateRule(rule(scoped), context(snap({}, t1), snap({}))).matched,
    ).toBe(true);
    expect(
      evaluateRule(
        rule(scoped),
        context(snap({}, t1), snap({}), { monitorTargetId: null }),
      ).matched,
    ).toBe(false);
    expect(
      evaluateRule(
        rule({ scope: { marketplaceItemIds: [ITEM_ID] } }),
        context(snap({}, t1), snap({}), {
          marketplaceItemId: "00000000-0000-4000-8000-00000000dddd",
        }),
      ).matched,
    ).toBe(false);
  });

  it("ANDs every declared predicate and reports all failures", () => {
    const result = evaluateRule(
      rule({
        eventTypes: ["restocked"],
        quantity: { minAvailable: 10 },
      }),
      context(
        snap({ quantityAvailable: 0 }, t1),
        snap({ quantityAvailable: 2 }),
      ),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it("degrades to no-match (never throws) on invalid stored rows", () => {
    expect(evaluateRule(rule({}), context(null, null))).toMatchObject({
      matched: false,
      score: 0,
    });
    expect(
      evaluateRule(rule({ nope: 1 }), context(null, null)).reasons[0],
    ).toContain("invalid conditions");
    expect(
      evaluateRule(
        rule({ eventTypes: ["price_dropped"] }, { scoreWeight: "abc" }),
        context(snap({}, t1), snap({})),
      ).reasons[0],
    ).toContain("invalid score_weight");
  });
});

describe("createOpportunityRulesService", () => {
  it("creates, reads, updates, and deletes with audit snapshots", async () => {
    const service = createOpportunityRulesService({ db: handle.db });
    const created = await service.createRule({
      name: "cheap drops",
      priority: 5,
      scoreWeight: "1.5000",
      conditions: { eventTypes: ["price_dropped"] },
    });
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({
      name: "cheap drops",
      enabled: true,
      priority: 5,
      scoreWeight: "1.5000",
    });
    expect(created.rule.createdByUserId).toBeNull();

    const fetched = await service.getRule(created.rule.id);
    expect(fetched.conditions).toEqual({ eventTypes: ["price_dropped"] });

    const updated = await service.updateRule(created.rule.id, {
      name: "cheap drops (tuned)",
      priority: -1,
      enabled: false,
      scoreWeight: "3.2500",
      conditions: { price: { minDropPercent: 25 } },
    });
    expect(updated.before.name).toBe("cheap drops");
    expect(updated.before.priority).toBe(5);
    expect(updated.after).toMatchObject({
      name: "cheap drops (tuned)",
      priority: -1,
      enabled: false,
      scoreWeight: "3.2500",
    });
    expect(updated.after.conditions).toEqual({ price: { minDropPercent: 25 } });

    const disabledOnly = await service.listRules({ enabled: false });
    expect(disabledOnly.map((row) => row.id)).toContain(created.rule.id);
    const enabledOnly = await service.listRules({ enabled: true });
    expect(enabledOnly.map((row) => row.id)).not.toContain(created.rule.id);

    const deleted = await service.deleteRule(created.rule.id);
    expect(deleted.after).toBeNull();
    expect(deleted.before.id).toBe(created.rule.id);
    await expect(service.getRule(created.rule.id)).rejects.toThrow(
      /unknown opportunity rule/,
    );
  });

  it("rejects invalid input at the service boundary", async () => {
    const service = createOpportunityRulesService({ db: handle.db });
    await expect(
      service.createRule({ name: "bad", conditions: {} }),
    ).rejects.toThrow(/invalid opportunity rule/);
    await expect(
      service.createRule({
        name: "bad weight",
        conditions: { eventTypes: ["restocked"] },
        scoreWeight: "-1",
      }),
    ).rejects.toThrow(/invalid opportunity rule/);
    await expect(
      service.createRule({
        name: "unknown key",
        // Deliberately off-grammar: the service must reject at runtime too.
        conditions: { price: { minPrice: "1" } } as never,
      }),
    ).rejects.toThrow(/invalid opportunity rule/);

    const ok = await service.createRule({
      name: "valid",
      conditions: { eventTypes: ["sold_out"] },
    });
    await expect(service.updateRule(ok.rule.id, {})).rejects.toThrow(
      /invalid opportunity rule patch/,
    );
    await service.deleteRule(ok.rule.id);
  });

  it("orders enabled rules by priority, then age, then id", async () => {
    const service = createOpportunityRulesService({ db: handle.db });
    const low = await service.createRule({
      name: "order-low",
      priority: 10,
      conditions: { eventTypes: ["listing_ended"] },
    });
    const high = await service.createRule({
      name: "order-high",
      priority: -5,
      conditions: { eventTypes: ["listing_ended"] },
    });
    const off = await service.createRule({
      name: "order-off",
      priority: -99,
      enabled: false,
      conditions: { eventTypes: ["listing_ended"] },
    });
    const loaded = await listEnabledRulesForEvaluation(handle.db);
    const ids = loaded.map((row) => row.id);
    expect(ids).not.toContain(off.rule.id);
    expect(ids.indexOf(high.rule.id)).toBeLessThan(ids.indexOf(low.rule.id));
    for (const created of [low, high, off]) {
      await service.deleteRule(created.rule.id);
    }
  });
});

/** Insert one market event directly, bypassing derivation. */
async function seedEvent(options: {
  marketplaceItemId: string;
  eventType: string;
  monitorTargetId?: string | null;
}): Promise<{ id: string; toObservedAt: Date }> {
  const dedupe = `${options.marketplaceItemId}:${options.eventType}:${randomUUID()}`;
  const inserted = await handle.db
    .insert(marketEvents)
    .values({
      marketplaceItemId: options.marketplaceItemId,
      monitorTargetId: options.monitorTargetId ?? null,
      eventType: options.eventType,
      detectedAt: t2,
      fromObservedAt: t1,
      toObservedAt: t2,
      payload: { from: "20.00", to: "10.00" },
      deduplicationKey: dedupe,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error("seed event insert failed");
  return { id: row.id, toObservedAt: row.toObservedAt };
}

describe("evaluateRulesForEvent", () => {
  it("stamps the first matching rule, merges payload, and is replay-safe", async () => {
    const service = createOpportunityRulesService({ db: handle.db });
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: `opp-stamp-${randomUUID()}`,
        seenAt: t1,
      },
    });
    const winner = await service.createRule({
      name: "winner",
      priority: 0,
      scoreWeight: "2.0000",
      conditions: { eventTypes: ["price_dropped"], price: { minDropPercent: 10 } },
    });
    const runnerUp = await service.createRule({
      name: "runner up",
      priority: 7,
      conditions: { eventTypes: ["price_dropped"] },
    });
    const irrelevant = await service.createRule({
      name: "irrelevant",
      priority: -1,
      conditions: { eventTypes: ["restocked"] },
    });

    const event = await seedEvent({
      marketplaceItemId: item.id,
      eventType: "price_dropped",
    });
    const observations = {
      previousObservation: { observedAt: t1, price: "20.00" },
      currentObservation: { observedAt: t2, price: "10.00" },
    };

    const first = await evaluateRulesForEvent(
      handle.db,
      {
        id: event.id,
        marketplaceItemId: item.id,
        monitorTargetId: null,
        eventType: "price_dropped",
        fromObservedAt: t1,
        toObservedAt: t2,
      },
      observations,
    );
    expect(first.stamped).toBe(true);
    expect(first.ruleId).toBe(winner.rule.id);
    expect(first.evaluatedRuleCount).toBeGreaterThanOrEqual(3);
    expect(first.matches.map((match) => match.ruleName)).toEqual([
      "winner",
      "runner up",
    ]);
    // weight 2 * (eventTypes 1 + percent (1 + 50/100)) = 5
    expect(first.matches[0]?.score).toBe(5);

    const stored = await handle.db.query.marketEvents.findFirst({
      where: (table, { eq }) => eq(table.id, event.id),
    });
    expect(stored?.ruleId).toBe(winner.rule.id);
    const payload = stored?.payload as Record<string, unknown>;
    // Derivation payload survives the merge.
    expect(payload["from"]).toBe("20.00");
    expect(payload[OPPORTUNITY_PAYLOAD_KEY]).toMatchObject({
      ruleId: winner.rule.id,
      ruleName: "winner",
      score: 5,
      matchCount: 2,
    });

    // Replay: same result, no new write, stamp untouched.
    const replay = await evaluateRulesForEvent(
      handle.db,
      {
        id: event.id,
        marketplaceItemId: item.id,
        monitorTargetId: null,
        eventType: "price_dropped",
        fromObservedAt: t1,
        toObservedAt: t2,
      },
      observations,
    );
    expect(replay.stamped).toBe(false);
    expect(replay.ruleId).toBe(winner.rule.id);
    expect(replay.matches).toHaveLength(2);

    // Even after the rule set changes, an earlier stamp is never overwritten.
    await service.updateRule(winner.rule.id, { enabled: false });
    const afterChange = await evaluateRulesForEvent(
      handle.db,
      {
        id: event.id,
        marketplaceItemId: item.id,
        monitorTargetId: null,
        eventType: "price_dropped",
        fromObservedAt: t1,
        toObservedAt: t2,
      },
      observations,
    );
    expect(afterChange.matches[0]?.ruleName).toBe("runner up");
    expect(afterChange.stamped).toBe(false);
    expect(afterChange.ruleId).toBe(winner.rule.id);
    const unchanged = await handle.db.query.marketEvents.findFirst({
      where: (table, { eq }) => eq(table.id, event.id),
    });
    expect(
      (unchanged?.payload as Record<string, Record<string, unknown>>)[
        OPPORTUNITY_PAYLOAD_KEY
      ]?.["ruleName"],
    ).toBe("winner");

    for (const created of [winner, runnerUp, irrelevant]) {
      await service.deleteRule(created.rule.id);
    }
  });

  it("stamps nothing when no rule matches, and short-circuits with no rules", async () => {
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: `opp-nomatch-${randomUUID()}`,
        seenAt: t1,
      },
    });
    const event = await seedEvent({
      marketplaceItemId: item.id,
      eventType: "price_dropped",
    });

    const empty = await evaluateRulesForEvent(handle.db, {
      id: event.id,
      marketplaceItemId: item.id,
      monitorTargetId: null,
      eventType: "price_dropped",
      fromObservedAt: t1,
      toObservedAt: t2,
    });
    expect(empty).toMatchObject({
      matches: [],
      ruleId: null,
      stamped: false,
      evaluatedRuleCount: 0,
    });

    const service = createOpportunityRulesService({ db: handle.db });
    const created = await service.createRule({
      name: "never",
      conditions: { eventTypes: ["listing_ended"] },
    });
    const noMatch = await evaluateRulesForEvent(handle.db, {
      id: event.id,
      marketplaceItemId: item.id,
      monitorTargetId: null,
      eventType: "price_dropped",
      fromObservedAt: t1,
      toObservedAt: t2,
    });
    expect(noMatch.matches).toEqual([]);
    expect(noMatch.stamped).toBe(false);
    const stored = await handle.db.query.marketEvents.findFirst({
      where: (table, { eq }) => eq(table.id, event.id),
    });
    expect(stored?.ruleId).toBeNull();
    await service.deleteRule(created.rule.id);
  });
});

describe("integration: deriveMarketEvents -> evaluateRulesForEvent", () => {
  it("scores a realistic drop/sellout/restock sequence", async () => {
    const service = createOpportunityRulesService({ db: handle.db });
    const monitors = createMonitorService({ db: handle.db });
    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "integration target",
      intervalSeconds: 300,
      config: { externalItemId: "integration-1" },
    });
    const item = await upsertMarketplaceItem({
      db: handle.db,
      item: {
        provider: "ebay",
        marketplace: "EBAY_US",
        externalItemId: `opp-integration-${randomUUID()}`,
        seenAt: t1,
      },
    });

    const dealRule = await service.createRule({
      name: "big drop under 100",
      priority: 0,
      scoreWeight: "2.0000",
      conditions: {
        eventTypes: ["price_dropped"],
        price: { maxPrice: "100.00", minDropPercent: 20 },
        scope: { monitorTargetIds: [target.id] },
      },
    });
    const restockRule = await service.createRule({
      name: "restock watch",
      priority: 1,
      conditions: {
        eventTypes: ["restocked"],
        quantity: { minIncrease: 1 },
      },
    });

    // Three observations: t0 baseline, t1 price drop + sellout, t2 restock.
    const t0 = new Date("2026-08-11T09:00:00.000Z");
    const tDrop = new Date("2026-08-11T09:30:00.000Z");
    const tRestock = new Date("2026-08-11T10:30:00.000Z");
    const states = [
      { at: t0, price: "120.00", quantityAvailable: 3 },
      { at: tDrop, price: "80.00", quantityAvailable: 0 },
      { at: tRestock, price: "80.00", quantityAvailable: 5 },
    ];
    for (const state of states) {
      await recordObservationBatch({
        db: handle.db,
        batch: {
          observationBatchId: randomUUID(),
          observedAt: state.at,
          source: "ebay_item",
          items: [
            {
              marketplaceItemId: item.id,
              price: state.price,
              quantityAvailable: state.quantityAvailable,
            },
          ],
        },
      });
    }

    const drop = await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      monitorTargetId: target.id,
      previous: {
        observedAt: t0,
        price: "120.00",
        quantityAvailable: 3,
      },
      current: {
        observedAt: tDrop,
        price: "80.00",
        quantityAvailable: 0,
      },
    });
    expect(drop.inserted.map((row) => row.eventType).sort()).toEqual([
      "price_changed",
      "price_dropped",
      "quantity_changed",
      "sold_out",
    ]);

    const results = new Map<string, number | null>();
    for (const row of drop.inserted) {
      // Observations are loaded from the hypertable, not supplied.
      const evaluation = await evaluateRulesForEvent(handle.db, row);
      results.set(row.eventType, evaluation.matches[0]?.score ?? null);
      if (row.eventType === "price_dropped") {
        expect(evaluation.stamped).toBe(true);
        expect(evaluation.ruleId).toBe(dealRule.rule.id);
      } else {
        expect(evaluation.matches).toEqual([]);
      }
    }
    // 120 → 80 is a 33.3333% drop over four predicates (eventTypes, maxPrice,
    // minDropPercent, scope): 2 * (1 + 1 + (1 + 0.3333) + 1) = 8.6666
    expect(results.get("price_dropped")).toBe(8.6666);
    expect(results.get("sold_out")).toBeNull();

    const restock = await deriveMarketEvents({
      db: handle.db,
      marketplaceItemId: item.id,
      monitorTargetId: target.id,
      previous: { observedAt: tDrop, price: "80.00", quantityAvailable: 0 },
      current: { observedAt: tRestock, price: "80.00", quantityAvailable: 5 },
    });
    const restockEvent = restock.inserted.find(
      (row) => row.eventType === "restocked",
    );
    expect(restockEvent).toBeDefined();
    const restockEvaluation = await evaluateRulesForEvent(
      handle.db,
      restockEvent!,
    );
    expect(restockEvaluation.stamped).toBe(true);
    expect(restockEvaluation.ruleId).toBe(restockRule.rule.id);
    expect(restockEvaluation.matches[0]?.score).toBe(2);

    // The seam: matches are returned for the caller to bridge to delivery;
    // nothing here enqueued anything.
    const deliveries = await handle.db.query.notificationDeliveries.findMany({});
    expect(deliveries).toHaveLength(0);

    // Deleting a matched rule never blocks (`rule_id` is an attribution
    // stamp, not an FK) — unlike the monitor target, whose `market_events`
    // references intentionally RESTRICT its deletion.
    for (const created of [dealRule, restockRule]) {
      await service.deleteRule(created.rule.id);
    }
    const survivingStamp = await handle.db.query.marketEvents.findFirst({
      where: (table, { eq }) => eq(table.id, restockEvent!.id),
    });
    expect(survivingStamp?.ruleId).toBe(restockRule.rule.id);
    await expect(monitors.deleteTarget(target.id)).rejects.toThrow();
  });
});
