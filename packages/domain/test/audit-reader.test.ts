/**
 * `createAuditReader` (loxep-161) — the SEPARATE read path over
 * `audit_events`, kept structurally apart from the insert-only
 * `createAuditService` (see `src/audit.ts`'s module doc for why). Covers
 * filters (actor/resourceType/resourceId/action/date range), paging, newest-
 * first ordering, and a compile-time proof that the writer's executor type
 * still cannot read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createAuditReader,
  createAuditService,
  type AuditExecutor,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

describe("audit reader", () => {
  const dbName = scratchDbName("loxep_test_domain_audit_reader");
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

  it("compile-time: AuditExecutor (the writer's type) exposes no read verb", () => {
    // This assignment only compiles because `AuditExecutor` is
    // `Pick<LoxepDb, "insert">` — if a future edit widened it to include
    // "query", the `@ts-expect-error` below would itself fail to compile
    // (an unused/incorrect expected-error), catching the regression at
    // `bun run typecheck` rather than trusting convention.
    const writer: AuditExecutor = handle.db;
    expect(typeof writer.insert).toBe("function");
    // @ts-expect-error AuditExecutor is insert-only by construction — it
    // must not carry a `query` property for the writer to read audit_events.
    void writer.query;
  });

  it("filters, paginates, and orders newest-first, with the total across all pages", async () => {
    const audit = createAuditService({ db: handle.db });
    const reader = createAuditReader({ db: handle.db });

    const actorA = "reader-test-actor-a";
    const actorB = "reader-test-actor-b";

    // Five connection.update events for actorA (staggered timestamps via
    // sequential inserts — occurred_at defaults to `new Date()` at insert
    // time, so later inserts sort after earlier ones), one for actorB, one
    // application_secret event for actorA.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { id } = await audit.append({
        actorUserId: actorA,
        action: "connection.update",
        resourceType: "connection",
        resourceId: `conn-${i}`,
        before: { name: `old-${i}` },
        after: { name: `new-${i}` },
      });
      ids.push(id);
      // Ensure strictly increasing occurred_at across inserts even on a
      // fast clock.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await audit.append({
      actorUserId: actorB,
      action: "connection.update",
      resourceType: "connection",
      resourceId: "conn-other",
    });
    await audit.append({
      actorUserId: actorA,
      action: "secret.rotate",
      resourceType: "application_secret",
      resourceId: "sec-reader-1",
    });

    // Actor filter.
    const byActor = await reader.list({ actorUserId: actorA, pageSize: 100 });
    expect(byActor.total).toBe(6);
    expect(byActor.events.every((event) => event.actorUserId === actorA)).toBe(
      true,
    );

    // Resource type filter.
    const byResourceType = await reader.list({
      actorUserId: actorA,
      resourceType: "application_secret",
    });
    expect(byResourceType.total).toBe(1);
    expect(byResourceType.events[0]?.resourceType).toBe("application_secret");

    // Resource id filter.
    const byResourceId = await reader.list({ resourceId: "conn-other" });
    expect(byResourceId.total).toBe(1);
    expect(byResourceId.events[0]?.actorUserId).toBe(actorB);

    // Action filter (substring, case-insensitive).
    const byAction = await reader.list({ actorUserId: actorA, action: "ROTATE" });
    expect(byAction.total).toBe(1);
    expect(byAction.events[0]?.action).toBe("secret.rotate");

    // Date range filter: `from` in the future excludes everything.
    const future = new Date(Date.now() + 60_000);
    const byFutureFrom = await reader.list({ actorUserId: actorA, from: future });
    expect(byFutureFrom.total).toBe(0);

    // Paging: pageSize=2 over the 5 connection.update rows for actorA,
    // newest-first, no overlap/gaps across pages.
    const page0 = await reader.list({
      actorUserId: actorA,
      resourceType: "connection",
      pageSize: 2,
      page: 0,
    });
    const page1 = await reader.list({
      actorUserId: actorA,
      resourceType: "connection",
      pageSize: 2,
      page: 1,
    });
    const page2 = await reader.list({
      actorUserId: actorA,
      resourceType: "connection",
      pageSize: 2,
      page: 2,
    });
    expect(page0.total).toBe(5);
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page0.events).toHaveLength(2);
    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(1);
    const pagedIds = [...page0.events, ...page1.events, ...page2.events].map(
      (event) => event.id,
    );
    expect(new Set(pagedIds).size).toBe(5);

    // Newest-first ordering across the full 5-row set: conn-4 was inserted
    // last, so it comes first.
    const all = await reader.list({
      actorUserId: actorA,
      resourceType: "connection",
      pageSize: 100,
    });
    const occurredAtMs = all.events.map((event) => event.occurredAt.getTime());
    const sortedDesc = [...occurredAtMs].sort((a, b) => b - a);
    expect(occurredAtMs).toEqual(sortedDesc);
    expect(all.events[0]?.resourceId).toBe("conn-4");
    expect(all.events.at(-1)?.resourceId).toBe("conn-0");
  });

  it("returns before/after/metadata already redacted, unchanged from the writer", async () => {
    const audit = createAuditService({ db: handle.db });
    const reader = createAuditReader({ db: handle.db });

    const { id } = await audit.append({
      actorUserId: "reader-test-redaction",
      action: "secret.create",
      resourceType: "application_secret",
      resourceId: "sec-reader-2",
      after: { payload: "should-be-redacted", currentVersion: 1 },
    });

    const result = await reader.list({ resourceId: "sec-reader-2" });
    expect(result.total).toBe(1);
    const row = result.events[0];
    expect(row?.id).toBe(id);
    expect((row?.after as Record<string, unknown> | null)?.payload).toBe(
      "[REDACTED]",
    );
    expect((row?.after as Record<string, unknown> | null)?.currentVersion).toBe(
      1,
    );
  });

  it("empty result set returns total 0 without a second query's worth of rows", async () => {
    const reader = createAuditReader({ db: handle.db });
    const result = await reader.list({ resourceType: "no-such-resource-type" });
    expect(result).toEqual({ events: [], total: 0 });
  });
});
