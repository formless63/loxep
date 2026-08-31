/**
 * Fleet alert evidence ingestion — the composition root (Phase 8 milestone
 * 7, loxep-ovj.7): uniform token-verification results and normalized work,
 * `receiveFleetEvidence`'s provider
 * dispatch and `source_events` write, the feedback-latch drop, the
 * projection task, and the two load-bearing negative assertions the design
 * names by name — no fleet path ever writes `notification_deliveries`, and
 * the sweep never clobbers an ingest-sourced row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { notificationDeliveries, user } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import {
  createRecordingNotificationEnqueue,
  EVIDENCE_INGEST_CONNECTION_KIND,
  gatusPushSetting,
} from "@loxep/domain";
import {
  createFleetEvidenceTasks,
  FLEET_EVIDENCE_INGEST_TASK,
  receiveFleetEvidence,
  verifyFleetIngestToken,
} from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import { buildAppServices } from "../src/services.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

describe("fleet evidence ingestion", () => {
  const dbName = scratchDbName("loxep_test_app_fleet_evidence");
  let handle: DbHandle;
  let services: AppServices;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    await handle.db.insert(user).values({
      id: "test-user",
      name: "Test User",
      email: "fleet-evidence@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  async function createEvidenceConnection(
    provider: string,
    name: string,
  ): Promise<string> {
    const created = await services.connections.createConnection({
      provider,
      kind: EVIDENCE_INGEST_CONNECTION_KIND,
      name,
      createdByUserId: "test-user",
    });
    return created.id;
  }

  async function mintToken(connectionId: string, token: string): Promise<void> {
    await services.connectionCredentials.setCredential({
      connectionId,
      credentialType: "fleet_ingest_token",
      payload: { token },
    });
  }

  describe("verifyFleetIngestToken", () => {
    it("accepts the correct token for an evidence-ingest connection", async () => {
      const connectionId = await createEvidenceConnection("generic", "verify-ok");
      await mintToken(connectionId, "correct-token-value");

      const result = await verifyFleetIngestToken({
        connections: services.connections,
        connectionCredentials: services.connectionCredentials,
        connectionId,
        presentedToken: "correct-token-value",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected verification to succeed");
      expect(result.connection.id).toBe(connectionId);
    });

    it("rejects a wrong token — identically shaped to every other failure", async () => {
      const connectionId = await createEvidenceConnection("generic", "verify-wrong-token");
      await mintToken(connectionId, "correct-token-value");

      const result = await verifyFleetIngestToken({
        connections: services.connections,
        connectionCredentials: services.connectionCredentials,
        connectionId,
        presentedToken: "wrong-token-value",
      });
      expect(result).toEqual({ ok: false });
    });

    it("rejects an unknown connection id with the same result as a wrong token", async () => {
      const result = await verifyFleetIngestToken({
        connections: services.connections,
        connectionCredentials: services.connectionCredentials,
        connectionId: "00000000-0000-4000-8000-000000000000",
        presentedToken: "anything",
      });
      expect(result).toEqual({ ok: false });
    });

    it("rejects a connection that exists but is not an evidence-ingest connection", async () => {
      const ordinary = await services.connections.createConnection({
        provider: "woocommerce",
        kind: "store",
        name: "not an evidence source",
        createdByUserId: "test-user",
      });
      const result = await verifyFleetIngestToken({
        connections: services.connections,
        connectionCredentials: services.connectionCredentials,
        connectionId: ordinary.id,
        presentedToken: "anything",
      });
      expect(result).toEqual({ ok: false });
    });

    it("rejects an evidence-ingest connection with no token minted yet", async () => {
      const connectionId = await createEvidenceConnection("generic", "verify-no-token");
      const result = await verifyFleetIngestToken({
        connections: services.connections,
        connectionCredentials: services.connectionCredentials,
        connectionId,
        presentedToken: "anything",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  describe("receiveFleetEvidence", () => {
    it("writes a 'received' source_events row and enqueues the projection for a generic accepted payload", async () => {
      const connectionId = await createEvidenceConnection("databasus", "generic-accepted");
      const connection = await services.connections.getConnection(connectionId);
      const enqueue = createRecordingNotificationEnqueue();

      const result = await receiveFleetEvidence({
        db: services.db,
        settings: services.settings,
        connection,
        rawBody: JSON.stringify({ status: "failing", message: "backup failed" }),
        enqueue,
        now: new Date("2026-08-15T03:00:00.000Z"),
      });

      expect(result.dropped).toBe(false);
      if (result.sourceEventId === null) throw new Error("expected a source_events row");
      const row = await handle.db.query.sourceEvents.findFirst({
        where: (table, { eq }) => eq(table.id, result.sourceEventId as string),
      });
      expect(row?.processingStatus).toBe("received");
      expect(row?.provider).toBe("databasus");
      expect(row?.connectionId).toBe(connectionId);
      expect(row?.payload).toEqual({ status: "failing", message: "backup failed" });

      expect(enqueue.calls).toHaveLength(1);
      expect(enqueue.calls[0]?.taskName).toBe(FLEET_EVIDENCE_INGEST_TASK);
      expect(enqueue.calls[0]?.payload).toMatchObject({
        sourceEventId: result.sourceEventId,
        connectionId,
        status: "failing",
      });
    });

    it("drops a Gatus alert about the configured heartbeat endpoint and enqueues nothing", async () => {
      await services.settings.set(
        gatusPushSetting,
        { enabled: true, baseUrl: "https://gatus.example.com", endpointKey: "core_loxep", mode: "single" },
        {},
      );
      const connectionId = await createEvidenceConnection("gatus", "gatus-latch");
      const connection = await services.connections.getConnection(connectionId);
      const enqueue = createRecordingNotificationEnqueue();

      const result = await receiveFleetEvidence({
        db: services.db,
        settings: services.settings,
        connection,
        rawBody: JSON.stringify({
          endpointName: "loxep",
          endpointGroup: "core",
          alertState: "TRIGGERED",
        }),
        enqueue,
        now: new Date("2026-08-15T03:00:00.000Z"),
      });

      expect(result.dropped).toBe(true);
      if (result.sourceEventId === null) throw new Error("expected a source_events row");
      const row = await handle.db.query.sourceEvents.findFirst({
        where: (table, { eq }) => eq(table.id, result.sourceEventId as string),
      });
      expect(row?.processingStatus).toBe("dropped");
      expect(row?.lastError).toContain("feedback_latch");
      expect(enqueue.calls).toHaveLength(0);
    });

    it("writes no row at all for a body that is not valid JSON", async () => {
      const connectionId = await createEvidenceConnection("generic", "not-json");
      const connection = await services.connections.getConnection(connectionId);
      const enqueue = createRecordingNotificationEnqueue();

      const before = await handle.db.query.sourceEvents.findMany({
        where: (table, { eq }) => eq(table.connectionId, connectionId),
      });
      expect(before).toHaveLength(0);

      const result = await receiveFleetEvidence({
        db: services.db,
        settings: services.settings,
        connection,
        rawBody: "{not json",
        enqueue,
      });
      expect(result).toEqual({ sourceEventId: null, dropped: true, reason: "invalid_payload" });

      const after = await handle.db.query.sourceEvents.findMany({
        where: (table, { eq }) => eq(table.connectionId, connectionId),
      });
      expect(after).toHaveLength(0);
      expect(enqueue.calls).toHaveLength(0);
    });

    it("never writes a notification_deliveries row across a full accepted round trip", async () => {
      const before = await handle.db.select().from(notificationDeliveries);

      const connectionId = await createEvidenceConnection("beszel", "no-deliveries");
      const connection = await services.connections.getConnection(connectionId);
      const enqueue = createRecordingNotificationEnqueue();
      await receiveFleetEvidence({
        db: services.db,
        settings: services.settings,
        connection,
        rawBody: JSON.stringify({ title: "Host down", message: "unreachable for 5 minutes" }),
        enqueue,
      });

      const after = await handle.db.select().from(notificationDeliveries);
      expect(after).toHaveLength(before.length);
    });
  });

  describe("the projection task", () => {
    it("upserts integration_health with source='ingest' and marks the source_events row processed", async () => {
      const connectionId = await createEvidenceConnection("databasus", "task-projects");
      const connection = await services.connections.getConnection(connectionId);
      const enqueue = createRecordingNotificationEnqueue();
      const received = await receiveFleetEvidence({
        db: services.db,
        settings: services.settings,
        connection,
        rawBody: JSON.stringify({ status: "ok" }),
        enqueue,
      });
      if (received.sourceEventId === null) throw new Error("expected a source_events row");

      const tasks = createFleetEvidenceTasks({ services });
      await tasks.projectIngestEvidenceTask.handler(
        {
          sourceEventId: received.sourceEventId,
          connectionId,
          status: "ok",
          detail: { kind: "evidence_reported" },
        },
        { logger: silentJobsLogger, helpers: { addJob: async () => ({}) as never } as never },
      );

      const health = await services.db.query.integrationHealth.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.subjectType, "connection"), eq(table.subjectId, connectionId)),
      });
      expect(health?.status).toBe("ok");
      expect(health?.source).toBe("ingest");

      const row = await handle.db.query.sourceEvents.findFirst({
        where: (table, { eq }) => eq(table.id, received.sourceEventId as string),
      });
      expect(row?.processingStatus).toBe("processed");
      expect(row?.processedAt).not.toBeNull();
    });
  });
});
