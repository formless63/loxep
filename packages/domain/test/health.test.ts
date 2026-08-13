/**
 * `integration_health` service tests (loxep-ovj.1): upsert transitions,
 * listing/filtering, subject clearing, and the `detail` guard. The
 * cross-column DB CHECK itself is asserted directly here too — a green row
 * with a failure streak must be impossible even through raw SQL, not just
 * through this service's own arithmetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { DomainValidationError, createHealthService } from "../src/index.ts";
import type { HealthService } from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const SUBJECT_ID_A = "00000000-0000-4000-8000-0000000000a1";
const SUBJECT_ID_B = "00000000-0000-4000-8000-0000000000b2";
const SUBJECT_ID_C = "00000000-0000-4000-8000-0000000000c3";

describe("health service", () => {
  const dbName = scratchDbName("loxep_test_domain_health");
  let handle: DbHandle;
  let service: HealthService;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createHealthService({ db: handle.db });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("inserts a new health row with consecutive_failures 0 for an ok status", async () => {
    const checkedAt = new Date("2026-01-01T00:00:00.000Z");
    const row = await service.upsertHealth({
      subjectType: "connection",
      subjectId: SUBJECT_ID_A,
      status: "ok",
      source: "probe",
      checkedAt,
    });
    expect(row.status).toBe("ok");
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastSuccessAt?.toISOString()).toBe(checkedAt.toISOString());
    expect(row.lastFailureAt).toBeNull();
  });

  it("increments consecutive_failures across repeated non-ok upserts and resets on ok", async () => {
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-01-01T00:05:00.000Z");
    const t3 = new Date("2026-01-01T00:10:00.000Z");
    const t4 = new Date("2026-01-01T00:15:00.000Z");

    const first = await service.upsertHealth({
      subjectType: "notification_endpoint",
      subjectId: SUBJECT_ID_B,
      status: "failing",
      source: "probe",
      checkedAt: t1,
    });
    expect(first.consecutiveFailures).toBe(1);
    expect(first.lastSuccessAt).toBeNull();
    expect(first.lastFailureAt?.toISOString()).toBe(t1.toISOString());

    const second = await service.upsertHealth({
      subjectType: "notification_endpoint",
      subjectId: SUBJECT_ID_B,
      status: "unknown",
      source: "probe",
      checkedAt: t2,
    });
    expect(second.consecutiveFailures).toBe(2);
    expect(second.lastFailureAt?.toISOString()).toBe(t2.toISOString());

    const recovered = await service.upsertHealth({
      subjectType: "notification_endpoint",
      subjectId: SUBJECT_ID_B,
      status: "ok",
      source: "probe",
      checkedAt: t3,
    });
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastSuccessAt?.toISOString()).toBe(t3.toISOString());
    // last_failure_at is history, not cleared by a recovery.
    expect(recovered.lastFailureAt?.toISOString()).toBe(t2.toISOString());

    const failedAgain = await service.upsertHealth({
      subjectType: "notification_endpoint",
      subjectId: SUBJECT_ID_B,
      status: "failing",
      source: "probe",
      checkedAt: t4,
    });
    // The streak restarts from the recovery, not from the historical total.
    expect(failedAgain.consecutiveFailures).toBe(1);
    expect(failedAgain.lastSuccessAt?.toISOString()).toBe(t3.toISOString());
  });

  it("is a single row per subject — one (subject_type, subject_id) overwritten in place", async () => {
    const rows = await service.listHealth({ subjectType: "notification_endpoint" });
    const matches = rows.filter((row) => row.subjectId === SUBJECT_ID_B);
    expect(matches).toHaveLength(1);
  });

  it("getHealth returns null for an unknown subject and the row for a known one", async () => {
    const missing = await service.getHealth("connection", SUBJECT_ID_B);
    expect(missing).toBeNull();
    const known = await service.getHealth("connection", SUBJECT_ID_A);
    expect(known?.subjectId).toBe(SUBJECT_ID_A);
  });

  it("listHealth filters by status", async () => {
    const failing = await service.listHealth({ status: "failing" });
    expect(failing.every((row) => row.status === "failing")).toBe(true);
    expect(failing.some((row) => row.subjectId === SUBJECT_ID_B)).toBe(true);
  });

  it("clearHealthForSubject deletes exactly the one row", async () => {
    await service.clearHealthForSubject("connection", SUBJECT_ID_A);
    const after = await service.getHealth("connection", SUBJECT_ID_A);
    expect(after).toBeNull();
    // The other subject's row is untouched.
    const other = await service.getHealth("notification_endpoint", SUBJECT_ID_B);
    expect(other).not.toBeNull();
  });

  it("rejects detail carrying a sensitive-shaped key instead of silently redacting it", async () => {
    await expect(
      service.upsertHealth({
        subjectType: "storage_backend",
        subjectId: SUBJECT_ID_A,
        status: "failing",
        source: "probe",
        detail: { token: "sk-should-never-be-here" },
      }),
    ).rejects.toThrow(DomainValidationError);
  });

  it("rejects detail carrying a raw response/header shape", async () => {
    for (const key of ["body", "headers", "response", "html"]) {
      await expect(
        service.upsertHealth({
          subjectType: "storage_backend",
          subjectId: SUBJECT_ID_A,
          status: "failing",
          source: "probe",
          detail: { [key]: "raw provider content" },
        }),
      ).rejects.toThrow(DomainValidationError);
    }
  });

  it("accepts a small, Loxep-owned detail shape", async () => {
    const row = await service.upsertHealth({
      subjectType: "storage_backend",
      subjectId: SUBJECT_ID_A,
      status: "failing",
      source: "probe",
      detail: { kind: "fs_error", code: "ENOENT" },
    });
    expect(row.detail).toEqual({ kind: "fs_error", code: "ENOENT" });
  });

  describe("status transitions (loxep-oii, weave audit finding 5 health half)", () => {
    it("leaves previous_status/status_changed_at null on first insert", async () => {
      const row = await service.upsertHealth({
        subjectType: "connection",
        subjectId: SUBJECT_ID_C,
        status: "ok",
        source: "probe",
        checkedAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      expect(row.previousStatus).toBeNull();
      expect(row.statusChangedAt).toBeNull();
    });

    it("does not record a transition when a same-status upsert repeats", async () => {
      const row = await service.upsertHealth({
        subjectType: "connection",
        subjectId: SUBJECT_ID_C,
        status: "ok",
        source: "probe",
        checkedAt: new Date("2026-07-01T00:05:00.000Z"),
      });
      expect(row.previousStatus).toBeNull();
      expect(row.statusChangedAt).toBeNull();
    });

    it("records previous_status and stamps status_changed_at when status differs", async () => {
      const changedAt = new Date("2026-07-01T00:10:00.000Z");
      const row = await service.upsertHealth({
        subjectType: "connection",
        subjectId: SUBJECT_ID_C,
        status: "degraded",
        source: "probe",
        checkedAt: changedAt,
      });
      expect(row.status).toBe("degraded");
      expect(row.previousStatus).toBe("ok");
      expect(row.statusChangedAt?.toISOString()).toBe(changedAt.toISOString());
    });

    it("leaves previous_status/status_changed_at stable across a non-transition upsert", async () => {
      const transitionAt = new Date("2026-07-01T00:10:00.000Z");
      const row = await service.upsertHealth({
        subjectType: "connection",
        subjectId: SUBJECT_ID_C,
        status: "degraded",
        source: "probe",
        // A later checked_at, same status — must not restamp status_changed_at.
        checkedAt: new Date("2026-07-01T00:15:00.000Z"),
      });
      expect(row.status).toBe("degraded");
      expect(row.previousStatus).toBe("ok");
      expect(row.statusChangedAt?.toISOString()).toBe(transitionAt.toISOString());
    });

    it("advances previous_status to the most recent prior status on a second transition", async () => {
      const secondChangeAt = new Date("2026-07-01T00:20:00.000Z");
      const row = await service.upsertHealth({
        subjectType: "connection",
        subjectId: SUBJECT_ID_C,
        status: "failing",
        source: "probe",
        checkedAt: secondChangeAt,
      });
      expect(row.status).toBe("failing");
      // The prior stored status was "degraded", not the original "ok".
      expect(row.previousStatus).toBe("degraded");
      expect(row.statusChangedAt?.toISOString()).toBe(secondChangeAt.toISOString());
    });
  });

  it("enforces the ok/consecutive_failures biconditional at the database level", async () => {
    await expect(
      handle.db.execute(
        `insert into integration_health
           (subject_type, subject_id, status, source, checked_at, consecutive_failures)
         values ('connection', '${SUBJECT_ID_A}', 'ok', 'probe', now(), 2)
         on conflict (subject_type, subject_id) do update set status = excluded.status,
           consecutive_failures = excluded.consecutive_failures`,
      ),
    ).rejects.toThrow();
  });

  it("enforces the previous_status/status_changed_at pairing CHECK at the database level", async () => {
    await expect(
      handle.db.execute(
        `insert into integration_health
           (subject_type, subject_id, status, source, checked_at, previous_status, status_changed_at)
         values ('connection', '${SUBJECT_ID_A}', 'ok', 'probe', now(), 'degraded', null)`,
      ),
    ).rejects.toThrow();
  });

  it("enforces the previous_status <> status CHECK at the database level", async () => {
    await expect(
      handle.db.execute(
        `insert into integration_health
           (subject_type, subject_id, status, source, checked_at, previous_status, status_changed_at)
         values ('connection', '${SUBJECT_ID_A}', 'ok', 'probe', now(), 'ok', now())`,
      ),
    ).rejects.toThrow();
  });
});
