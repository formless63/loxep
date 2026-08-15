/**
 * `notification_events` ledger tests (loxep-oii / ADR-0023): registry
 * validation of the `(class, type, subject_type)` triple, at-least-once
 * emission, the routing predicate's class dimension, and the explicit
 * detection→delivery bridge with an injected enqueue seam.
 *
 * The schema's own closed CHECKs are asserted through raw SQL too — a class
 * or subject the application does not know must be impossible at the database
 * level, not merely refused by the registry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  DomainValidationError,
  createRecordingNotificationEnqueue,
  notificationEventClasses,
  publishNotificationEvent,
  recordNotificationEvent,
  routeNotificationEvent,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const SUBJECT_A = "00000000-0000-4000-8000-00000000ee01";
const SUBJECT_B = "00000000-0000-4000-8000-00000000ee02";
const SUBJECT_C = "00000000-0000-4000-8000-00000000ee03";

describe("notification events", () => {
  const dbName = scratchDbName("loxep_test_domain_notification_events");
  let handle: DbHandle;
  let endpointId = "";
  let secondEndpointId = "";

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    const inserted = await handle.db.execute<{ id: string }>(
      `insert into notification_endpoints (provider, name, config)
       values ('ntfy', 'ledger test', '{}'::jsonb),
              ('ntfy', 'ledger test 2', '{}'::jsonb)
       returning id`,
    );
    endpointId = String(inserted.rows[0]!["id"]);
    secondEndpointId = String(inserted.rows[1]!["id"]);
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  /** The violated constraint name, from the pg error Drizzle wraps. */
  async function violatedConstraint(statement: string): Promise<string | null> {
    try {
      await handle.db.execute(statement);
    } catch (error) {
      const cause = (error as { cause?: { constraint?: string } }).cause;
      return cause?.constraint ?? null;
    }
    throw new Error("statement unexpectedly succeeded");
  }

  describe("the event-class registry", () => {
    it("refuses an event type its class does not register", async () => {
      await expect(
        recordNotificationEvent(handle.db, {
          eventClass: "health",
          eventType: "price_dropped",
          subjectType: "connection",
          subjectId: SUBJECT_A,
          occurredAt: new Date(),
          deduplicationKey: "invalid:type",
        }),
      ).rejects.toThrow(DomainValidationError);
    });

    it("refuses a subject type its class does not permit", async () => {
      await expect(
        recordNotificationEvent(handle.db, {
          eventClass: "purchase",
          eventType: "purchase_ingested",
          subjectType: "connection",
          subjectId: SUBJECT_A,
          occurredAt: new Date(),
          deduplicationKey: "invalid:subject",
        }),
      ).rejects.toThrow(DomainValidationError);
    });

    it("excludes every fleet subject from the notifiable health subjects", () => {
      // The fleet design's open question 1 ruling, structurally: companion
      // tools alert their own operators and Loxep does not relay them.
      const health = notificationEventClasses.health.subjectTypes;
      expect(health).not.toContain("external_resource");
      expect(health).not.toContain("hosting_target");
      expect(health).not.toContain("managed_domain");
      expect(health).toContain("connection");
    });

    it("refuses an unregistered class at the DATABASE level, not just in the registry", async () => {
      expect(
        await violatedConstraint(
          `insert into notification_events (
             event_class, event_type, subject_type, subject_id, occurred_at,
             deduplication_key)
           values ('gossip', 'whatever', 'connection',
                   '${SUBJECT_A}', now(), 'raw:bad-class')`,
        ),
      ).toBe("notification_events_event_class_check");
    });

    it("refuses an unregistered subject type at the DATABASE level", async () => {
      expect(
        await violatedConstraint(
          `insert into notification_events (
             event_class, event_type, subject_type, subject_id, occurred_at,
             deduplication_key)
           values ('health', 'health_degraded', 'toaster',
                   '${SUBJECT_A}', now(), 'raw:bad-subject')`,
        ),
      ).toBe("notification_events_subject_type_check");
    });

    it("wires the infrastructure class (loxep-oii's own deferred item, closed by loxep-50t)", async () => {
      const infrastructure = notificationEventClasses.infrastructure;
      expect(infrastructure.wired).toBe(true);
      expect(infrastructure.eventTypes).toEqual([
        "drift_found",
        "drift_disappeared",
        "reconcile_run_failed",
      ]);
      expect(infrastructure.subjectTypes).toContain("managed_domain");
      expect(infrastructure.subjectTypes).toContain("reconcile_run");

      const { created } = await recordNotificationEvent(handle.db, {
        eventClass: "infrastructure",
        eventType: "drift_found",
        subjectType: "managed_domain",
        subjectId: SUBJECT_A,
        occurredAt: new Date(),
        payload: { kind: "unexpected", recordType: "A", recordName: "old.example.com" },
        deduplicationKey: "infra-registry:drift_found",
      });
      expect(created).toBe(true);

      await expect(
        recordNotificationEvent(handle.db, {
          eventClass: "infrastructure",
          eventType: "reconcile_run_failed",
          // A drift-shaped subject is not valid for the reconciler failure
          // type's own natural subject — the registry does not care WHICH
          // event type within a class asked, only that the subject type is
          // one the whole class permits, so this actually succeeds; the
          // real guard is exercised by the "refuses a subject type its
          // class does not permit" case above with a genuinely foreign type.
          subjectType: "reconcile_run",
          subjectId: SUBJECT_B,
          occurredAt: new Date(),
          deduplicationKey: "infra-registry:reconcile_run_failed",
        }),
      ).resolves.toMatchObject({ created: true });
    });
  });

  describe("at-least-once emission", () => {
    it("records once and reports created=false on the replay", async () => {
      const input = {
        eventClass: "health" as const,
        eventType: "health_degraded",
        subjectType: "connection" as const,
        subjectId: SUBJECT_B,
        occurredAt: new Date("2026-08-14T10:00:00.000Z"),
        payload: { previousStatus: "ok", status: "failing" },
        deduplicationKey: "health:connection:b:health_degraded:1",
      };
      const first = await recordNotificationEvent(handle.db, input);
      const second = await recordNotificationEvent(handle.db, input);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(first.event.payload).toEqual({
        previousStatus: "ok",
        status: "failing",
      });
      expect(first.event.occurredAt.toISOString()).toBe(
        "2026-08-14T10:00:00.000Z",
      );
    });
  });

  describe("routing", () => {
    it("matches on class, type, and monitor target — with no cross-class wildcard", async () => {
      const rules = await handle.db.execute<{ id: string }>(
        `insert into notification_rules (name, event_class, event_type, endpoint_id)
         values ('any health', 'health', null, '${endpointId}'),
                ('degradations', 'health', 'health_degraded', '${endpointId}'),
                ('recoveries', 'health', 'health_recovered', '${secondEndpointId}'),
                ('any market', 'market', null, '${secondEndpointId}'),
                ('off', 'health', null, '${secondEndpointId}')
         returning id`,
      );
      const offId = String(rules.rows[4]!["id"]);
      await handle.db.execute(
        `update notification_rules set enabled = false where id = '${offId}'`,
      );

      const degraded = await routeNotificationEvent(handle.db, {
        eventClass: "health",
        eventType: "health_degraded",
        monitorTargetId: null,
      });
      expect(degraded.ruleIds).toHaveLength(2);
      expect(degraded.endpointIds).toEqual([endpointId]);
      expect(degraded.ruleIds).not.toContain(offId);

      const recovered = await routeNotificationEvent(handle.db, {
        eventClass: "health",
        eventType: "health_recovered",
        monitorTargetId: null,
      });
      // 'any health' (endpoint 1) + 'recoveries' (endpoint 2). Rule order is
      // (created_at, id) and these rows share a created_at, so compare as a
      // set rather than asserting an order the schema does not promise.
      expect([...recovered.endpointIds].sort()).toEqual(
        [endpointId, secondEndpointId].sort(),
      );

      // A market rule never sees a health event, however wide it is.
      const market = await routeNotificationEvent(handle.db, {
        eventClass: "market",
        eventType: "price_dropped",
        monitorTargetId: null,
      });
      expect(market.endpointIds).toEqual([secondEndpointId]);
    });
  });

  describe("publishNotificationEvent (the explicit bridge)", () => {
    it("records, routes, and enqueues one deliver job per distinct endpoint", async () => {
      const enqueue = createRecordingNotificationEnqueue();
      const published = await publishNotificationEvent({
        executor: handle.db,
        enqueue,
        event: {
          eventClass: "health",
          eventType: "health_recovered",
          subjectType: "storage_backend",
          subjectId: SUBJECT_C,
          occurredAt: new Date("2026-08-14T11:00:00.000Z"),
          payload: { previousStatus: "failing", status: "ok" },
          deduplicationKey: "health:storage_backend:c:health_recovered:1",
        },
      });
      expect(published.created).toBe(true);
      expect([...published.endpointIds].sort()).toEqual(
        [endpointId, secondEndpointId].sort(),
      );
      expect(enqueue.calls).toHaveLength(2);
      expect(enqueue.calls[0]!.taskName).toBe("notifications.deliver");
      const first = published.endpointIds[0]!;
      expect(enqueue.calls[0]!.payload).toEqual({
        notificationEventId: published.event.id,
        endpointId: first,
      });
      expect(enqueue.calls[0]!.jobKey).toBe(
        `notifications.deliver:${published.event.id}:${first}`,
      );
    });

    it("enqueues NOTHING on a replay, so a retried handler cannot notify twice", async () => {
      const enqueue = createRecordingNotificationEnqueue();
      const again = await publishNotificationEvent({
        executor: handle.db,
        enqueue,
        event: {
          eventClass: "health",
          eventType: "health_recovered",
          subjectType: "storage_backend",
          subjectId: SUBJECT_C,
          occurredAt: new Date("2026-08-14T11:00:00.000Z"),
          deduplicationKey: "health:storage_backend:c:health_recovered:1",
        },
      });
      expect(again.created).toBe(false);
      expect(again.endpointIds).toEqual([]);
      expect(enqueue.calls).toHaveLength(0);
    });

    it("records without routing when no enqueue seam is supplied (detection only)", async () => {
      const published = await publishNotificationEvent({
        executor: handle.db,
        event: {
          eventClass: "health",
          eventType: "health_degraded",
          subjectType: "notification_endpoint",
          subjectId: SUBJECT_A,
          occurredAt: new Date("2026-08-14T12:00:00.000Z"),
          deduplicationKey: "health:notification_endpoint:a:degraded:1",
        },
      });
      expect(published.created).toBe(true);
      expect(published.endpointIds).toEqual([]);
      const rows = await handle.db.query.notificationEvents.findMany({
        where: (table, { eq }) =>
          eq(table.deduplicationKey, "health:notification_endpoint:a:degraded:1"),
      });
      expect(rows).toHaveLength(1);
    });
  });
});
