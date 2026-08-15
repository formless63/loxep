/**
 * Fleet evidence ingestion (Phase 8 milestone 7, loxep-ovj.7): the generic
 * (Databasus-class) normalizer, the `fleet_ingest_token` bundle, and — the
 * load-bearing DB-backed rule — that an `evidence_ingest`-kind connection is
 * excluded from the default `connection` health-subject candidate list, so
 * `health.sweep`'s own derived probe can never clobber an `ingest`-sourced
 * row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { connections } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import {
  createDefaultHealthSubjectRegistry,
  createHealthService,
  EVIDENCE_INGEST_CONNECTION_KIND,
  isEvidenceIngestConnectionKind,
  isFleetEvidenceProvider,
  normalizeGenericEvidenceWebhook,
  runHealthSweep,
  validateBundle,
} from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

describe("isEvidenceIngestConnectionKind / isFleetEvidenceProvider", () => {
  it("recognizes exactly the evidence-ingest kind", () => {
    expect(isEvidenceIngestConnectionKind(EVIDENCE_INGEST_CONNECTION_KIND)).toBe(true);
    expect(isEvidenceIngestConnectionKind("fleet_observability")).toBe(false);
  });

  it("recognizes exactly the registered evidence providers", () => {
    expect(isFleetEvidenceProvider("gatus")).toBe(true);
    expect(isFleetEvidenceProvider("beszel")).toBe(true);
    expect(isFleetEvidenceProvider("databasus")).toBe(true);
    expect(isFleetEvidenceProvider("generic")).toBe(true);
    expect(isFleetEvidenceProvider("woocommerce")).toBe(false);
  });
});

describe("fleet_ingest_token bundle", () => {
  it("requires a non-empty token", () => {
    expect(validateBundle("fleet_ingest_token", { token: "abc" })).toEqual({ token: "abc" });
    expect(() => validateBundle("fleet_ingest_token", { token: "" })).toThrow();
    expect(() => validateBundle("fleet_ingest_token", {})).toThrow();
  });
});

describe("normalizeGenericEvidenceWebhook", () => {
  const receivedAt = new Date("2026-08-15T03:00:00.000Z");

  it("accepts a minimal valid payload and defaults occurredAt to receipt time", () => {
    const result = normalizeGenericEvidenceWebhook({ status: "ok" }, { receivedAt });
    expect(result).toEqual({
      drop: false,
      eventType: "evidence_reported",
      externalEventId: null,
      occurredAt: receivedAt,
      status: "ok",
      detail: { kind: "evidence_reported" },
    });
  });

  it("carries a truncated message and an explicit occurredAt through", () => {
    const result = normalizeGenericEvidenceWebhook(
      {
        status: "failing",
        message: "nightly backup failed: connection refused",
        occurredAt: "2026-08-15T02:00:00.000Z",
      },
      { receivedAt },
    );
    expect(result).toEqual({
      drop: false,
      eventType: "evidence_reported",
      externalEventId: null,
      occurredAt: new Date("2026-08-15T02:00:00.000Z"),
      status: "failing",
      detail: {
        kind: "evidence_reported",
        message: "nightly backup failed: connection refused",
      },
    });
  });

  it("drops (never throws) an invalid payload", () => {
    const result = normalizeGenericEvidenceWebhook({ status: "not-a-status" });
    expect(result.drop).toBe(true);
    if (!result.drop) throw new Error("expected a drop");
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejects a raw credential-shaped field via strictObject (no passthrough)", () => {
    const result = normalizeGenericEvidenceWebhook({ status: "ok", token: "sk_leak" });
    expect(result.drop).toBe(true);
  });
});

describe("evidence-ingest connections are excluded from the default connection health sweep", () => {
  const dbName = scratchDbName("loxep_test_domain_fleet_evidence");
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

  it("never lists an evidence_ingest connection as a probe candidate", async () => {
    const [evidenceConnection] = await handle.db
      .insert(connections)
      .values({
        provider: "databasus",
        kind: EVIDENCE_INGEST_CONNECTION_KIND,
        name: "Nightly Databasus backup",
        status: "active",
      })
      .returning();
    const [ordinaryConnection] = await handle.db
      .insert(connections)
      .values({
        provider: "woocommerce",
        kind: "store",
        name: "Ordinary store connection",
        status: "active",
      })
      .returning();
    if (evidenceConnection === undefined || ordinaryConnection === undefined) {
      throw new Error("fixture insert failed");
    }

    const registry = createDefaultHealthSubjectRegistry();
    const connectionEntry = registry.connection;
    if (connectionEntry === undefined) throw new Error("no connection entry registered");
    const candidates = await connectionEntry.listCandidates(handle.db);
    const candidateIds = candidates.map((candidate) => candidate.subjectId);

    expect(candidateIds).toContain(ordinaryConnection.id);
    expect(candidateIds).not.toContain(evidenceConnection.id);
  });

  it("a health.sweep run never overwrites an ingest-sourced row for an evidence_ingest connection", async () => {
    const [evidenceConnection] = await handle.db
      .insert(connections)
      .values({
        provider: "gatus",
        kind: EVIDENCE_INGEST_CONNECTION_KIND,
        name: "Gatus alert evidence",
        status: "active",
      })
      .returning();
    if (evidenceConnection === undefined) throw new Error("fixture insert failed");

    const health = createHealthService({ db: handle.db });
    const checkedAt = new Date("2026-08-15T03:00:00.000Z");
    await health.upsertHealth({
      subjectType: "connection",
      subjectId: evidenceConnection.id,
      status: "failing",
      source: "ingest",
      checkedAt,
      detail: { kind: "alert_triggered" },
    });

    // Run the sweep well past the base probe interval — if this connection
    // were listed, it would be due and would be re-probed as
    // `source: 'probe'`, `status: 'unknown'` (never_succeeded).
    await runHealthSweep({
      db: handle.db,
      health,
      now: new Date(checkedAt.getTime() + 10 * 60_000),
    });

    const row = await health.getHealth("connection", evidenceConnection.id);
    expect(row?.source).toBe("ingest");
    expect(row?.status).toBe("failing");
    expect(row?.checkedAt.toISOString()).toBe(checkedAt.toISOString());
  });
});
