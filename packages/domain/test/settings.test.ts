/**
 * Settings registry/service integration tests against a real PostgreSQL
 * (docker/compose.dev.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  SettingNotRegisteredError,
  createSettingsService,
  defineSetting,
  orderPayloadRetentionSetting,
  registeredApplicationSettings,
} from "../src/index.ts";
import type { SettingsService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const pollingDefaults = defineSetting({
  key: "test.polling_defaults",
  schema: z.strictObject({
    intervalMinutes: z.number().int().min(1).max(1440),
    jitterSeconds: z.number().int().min(0).default(30),
  }),
  description: "Default polling cadence for monitor dispatch",
  schemaVersion: 1,
  defaultValue: { intervalMinutes: 15, jitterSeconds: 30 },
});

const displayName = defineSetting({
  key: "test.display_name",
  schema: z.string().min(1),
  description: "Installation display name",
  schemaVersion: 1,
  defaultValue: "Loxep",
});

describe("settings service", () => {
  const dbName = scratchDbName("loxep_test_domain_settings");
  let handle: DbHandle;
  let service: SettingsService;
  let actorId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createSettingsService({ db: handle.db });
    actorId = await insertTestUser(handle.db, "user_settings_actor");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("returns the default value when no row exists", async () => {
    await expect(service.get(pollingDefaults)).resolves.toEqual({
      intervalMinutes: 15,
      jitterSeconds: 30,
    });
  });

  it("validates through Zod before persistence and rejects invalid values", async () => {
    await expect(
      service.set(
        pollingDefaults,
        // Invalid: below minimum.
        { intervalMinutes: 0, jitterSeconds: 30 },
        { actorUserId: actorId },
      ),
    ).rejects.toThrow();

    // Nothing was persisted and no audit event was appended.
    const rows = await handle.pool.query(
      "select * from application_settings where key = $1",
      [pollingDefaults.key],
    );
    expect(rows.rowCount).toBe(0);
    const audits = await handle.pool.query(
      "select * from audit_events where resource_id = $1",
      [pollingDefaults.key],
    );
    expect(audits.rowCount).toBe(0);
  });

  it("sets, upserts, and reads back a validated value with metadata", async () => {
    await service.set(
      pollingDefaults,
      { intervalMinutes: 30, jitterSeconds: 10 },
      { actorUserId: actorId, requestId: "req-settings-1" },
    );
    await expect(service.get(pollingDefaults)).resolves.toEqual({
      intervalMinutes: 30,
      jitterSeconds: 10,
    });

    const rows = await handle.pool.query<{
      schema_version: number;
      updated_by_user_id: string;
      updated_at: Date;
    }>("select * from application_settings where key = $1", [
      pollingDefaults.key,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.schema_version).toBe(1);
    expect(rows.rows[0]?.updated_by_user_id).toBe(actorId);
    expect(rows.rows[0]?.updated_at).toBeInstanceOf(Date);

    // Second write updates the same row (upsert, still one row).
    await service.set(
      pollingDefaults,
      { intervalMinutes: 45, jitterSeconds: 5 },
      { actorUserId: actorId },
    );
    const after = await handle.pool.query(
      "select count(*)::int as count from application_settings where key = $1",
      [pollingDefaults.key],
    );
    expect(after.rows[0]?.count).toBe(1);
  });

  it("appends redacted audit events with before/after and request id", async () => {
    const audits = await handle.pool.query<{
      action: string;
      resource_type: string;
      actor_user_id: string;
      request_id: string | null;
      before: unknown;
      after: { value?: { intervalMinutes?: number } };
    }>(
      `select * from audit_events
        where resource_type = 'application_setting' and resource_id = $1
        order by occurred_at asc`,
      [pollingDefaults.key],
    );
    expect(audits.rowCount).toBe(2);
    expect(audits.rows[0]?.action).toBe("settings.create");
    expect(audits.rows[0]?.before).toBeNull();
    expect(audits.rows[0]?.request_id).toBe("req-settings-1");
    expect(audits.rows[0]?.actor_user_id).toBe(actorId);
    expect(audits.rows[1]?.action).toBe("settings.update");
    expect(audits.rows[1]?.before).toEqual({
      value: { intervalMinutes: 30, jitterSeconds: 10 },
      schemaVersion: 1,
    });
    expect(audits.rows[1]?.after.value?.intervalMinutes).toBe(45);
  });

  it("rejects reads and writes for unregistered definitions", async () => {
    const rogue = {
      key: "test.unregistered",
      schema: z.string(),
      description: "not registered",
      schemaVersion: 1,
      defaultValue: "nope",
    };
    await expect(service.set(rogue, "value", {})).rejects.toBeInstanceOf(
      SettingNotRegisteredError,
    );
    await expect(service.get(rogue)).rejects.toBeInstanceOf(
      SettingNotRegisteredError,
    );

    // A same-key copy that did not come from defineSetting is also rejected.
    const imposter = { ...pollingDefaults };
    await expect(
      service.set(imposter, { intervalMinutes: 5, jitterSeconds: 1 }, {}),
    ).rejects.toBeInstanceOf(SettingNotRegisteredError);
  });

  it("lists registered keys with metadata and current values", async () => {
    const entries = await service.list();
    const polling = entries.find((entry) => entry.key === pollingDefaults.key);
    expect(polling).toMatchObject({
      description: "Default polling cadence for monitor dispatch",
      schemaVersion: 1,
      isSet: true,
      value: { intervalMinutes: 45, jitterSeconds: 5 },
      updatedByUserId: actorId,
    });
    const name = entries.find((entry) => entry.key === displayName.key);
    expect(name).toMatchObject({
      isSet: false,
      value: "Loxep",
      updatedByUserId: null,
      updatedAt: null,
    });
  });

  it("lists every SHIPPED setting, so /settings can render it unchanged", async () => {
    const entries = await service.list();
    const keys = entries.map((entry) => entry.key);
    for (const definition of registeredApplicationSettings) {
      expect(keys).toContain(definition.key);
    }

    // ADR-0021's setting in particular: `/settings/application` renders
    // whatever `list()` returns, so registration IS the surface wiring — no
    // web code change is involved, and this assertion is what proves it.
    const retention = entries.find(
      (entry) => entry.key === orderPayloadRetentionSetting.key,
    );
    expect(retention).toMatchObject({
      key: "commerce.order_payload_retention",
      schemaVersion: 1,
      isSet: false,
      value: { mode: "redact", afterDays: 180 },
    });
  });

  it("accepts both retention modes and rejects anything else", async () => {
    expect(
      orderPayloadRetentionSetting.schema.safeParse({
        mode: "keep",
        afterDays: 180,
      }).success,
    ).toBe(true);
    // No hard-delete mode exists, by design (ADR-0021 #1 and #4).
    expect(
      orderPayloadRetentionSetting.schema.safeParse({
        mode: "delete",
        afterDays: 180,
      }).success,
    ).toBe(false);
    expect(
      orderPayloadRetentionSetting.schema.safeParse({
        mode: "redact",
        afterDays: 0,
      }).success,
    ).toBe(false);

    const stored = await service.set(
      orderPayloadRetentionSetting,
      { mode: "keep", afterDays: 30 },
      { actorUserId: null, requestId: null },
    );
    expect(stored).toEqual({ mode: "keep", afterDays: 30 });
    expect(await service.get(orderPayloadRetentionSetting)).toEqual({
      mode: "keep",
      afterDays: 30,
    });
  });

  it("rejects duplicate registration of the same key", () => {
    expect(() =>
      defineSetting({
        key: pollingDefaults.key,
        schema: z.string(),
        description: "duplicate",
        schemaVersion: 1,
        defaultValue: "",
      }),
    ).toThrow(/already registered/);
  });
});
