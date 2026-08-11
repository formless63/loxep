/**
 * Audit pipeline integration tests: recursive redaction of before/after
 * snapshots, secret-resource payload redaction, and correlation fields.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { REDACTED, createAuditService, redactJson } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const MARKER = "PLAINTEXT-MARKER-audit-8e5d";

describe("redactJson", () => {
  it("redacts sensitive keys recursively through objects and arrays", () => {
    const redacted = redactJson({
      name: "keep-me",
      password: MARKER,
      config: {
        clientSecret: MARKER,
        smtp: { password: MARKER, host: "mail.example.test" },
        entries: [
          { accessToken: MARKER, label: "a" },
          { refreshToken: MARKER, nested: { token: MARKER } },
        ],
      },
      secret_access_key: MARKER,
      "auth-tag": MARKER,
      ciphertext: MARKER,
      nonce: MARKER,
      apiToken: MARKER,
      count: 3,
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toContain(MARKER);
    expect(redacted.name).toBe("keep-me");
    expect(redacted.count).toBe(3);
    expect(redacted.password).toBe(REDACTED);
    const config = redacted.config as {
      clientSecret: unknown;
      smtp: { password: unknown; host: unknown };
      entries: Array<Record<string, unknown>>;
    };
    expect(config.clientSecret).toBe(REDACTED);
    expect(config.smtp.password).toBe(REDACTED);
    expect(config.smtp.host).toBe("mail.example.test");
    expect(config.entries[0]?.accessToken).toBe(REDACTED);
    expect(config.entries[0]?.label).toBe("a");
    expect(config.entries[1]?.refreshToken).toBe(REDACTED);
    expect((config.entries[1]?.nested as Record<string, unknown>).token).toBe(
      REDACTED,
    );
  });

  it("redacts payload keys only for secret resources", () => {
    const value = { payload: MARKER, label: "x" };
    const plain = redactJson(value) as Record<string, unknown>;
    expect(plain.payload).toBe(MARKER);
    const secretResource = redactJson(value, {
      redactPayloadKey: true,
    }) as Record<string, unknown>;
    expect(secretResource.payload).toBe(REDACTED);
    expect(secretResource.label).toBe("x");
  });

  it("passes primitives and null through unchanged", () => {
    expect(redactJson(null)).toBeNull();
    expect(redactJson("plain")).toBe("plain");
    expect(redactJson(42)).toBe(42);
  });
});

describe("audit service", () => {
  const dbName = scratchDbName("loxep_test_domain_audit");
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

  it("appends events with recursive redaction applied to before/after", async () => {
    const audit = createAuditService({ db: handle.db });
    const { id } = await audit.append({
      actorUserId: "historical-user-id",
      action: "connection.update",
      resourceType: "connection",
      resourceId: "conn-1",
      before: {
        name: "old name",
        config: { token: MARKER, endpoints: [{ password: MARKER }] },
      },
      after: {
        name: "new name",
        config: { token: MARKER, endpoints: [{ password: MARKER }] },
      },
      requestId: "req-audit-1",
      metadata: { source: "test", clientSecret: MARKER },
    });
    expect(id).toBeTruthy();

    const rows = await handle.pool.query<{
      actor_user_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      request_id: string;
      occurred_at: Date;
      before: { name: string; config: Record<string, unknown> };
      after: { name: string; config: Record<string, unknown> };
      metadata: Record<string, unknown>;
    }>("select * from audit_events where id = $1", [id]);
    const row = rows.rows[0];
    expect(row?.actor_user_id).toBe("historical-user-id");
    expect(row?.action).toBe("connection.update");
    expect(row?.resource_id).toBe("conn-1");
    expect(row?.request_id).toBe("req-audit-1");
    expect(row?.occurred_at).toBeInstanceOf(Date);
    expect(row?.before.name).toBe("old name");
    expect(row?.after.name).toBe("new name");
    expect(JSON.stringify(row)).not.toContain(MARKER);
    expect(row?.metadata.source).toBe("test");
    expect(row?.metadata.clientSecret).toBe(REDACTED);
  });

  it("redacts payload keys for secret resource types", async () => {
    const audit = createAuditService({ db: handle.db });
    const { id } = await audit.append({
      action: "secret.create",
      resourceType: "application_secret",
      resourceId: "sec-1",
      after: { payload: MARKER, currentVersion: 1 },
    });
    const rows = await handle.pool.query<{
      before: unknown;
      after: { payload: unknown; currentVersion: number };
    }>("select * from audit_events where id = $1", [id]);
    expect(rows.rows[0]?.after.payload).toBe(REDACTED);
    expect(rows.rows[0]?.after.currentVersion).toBe(1);
    expect(rows.rows[0]?.before).toBeNull();
  });

  it("keeps payload keys for non-secret resource types", async () => {
    const audit = createAuditService({ db: handle.db });
    const { id } = await audit.append({
      action: "monitor.update",
      resourceType: "monitor_target",
      resourceId: "mon-1",
      after: { payload: { intervalMinutes: 5 } },
    });
    const rows = await handle.pool.query<{
      after: { payload: { intervalMinutes: number } };
    }>("select * from audit_events where id = $1", [id]);
    expect(rows.rows[0]?.after.payload.intervalMinutes).toBe(5);
  });
});
