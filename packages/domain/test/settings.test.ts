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
  SettingValidationError,
  authOnboardingOidcPromptDismissedSetting,
  authProvisioningSetting,
  createSettingsService,
  defineSetting,
  findRegisteredSetting,
  caaPolicySetting,
  cloudflareRateBudgetSetting,
  documentsMediaLimitsSetting,
  documentsParserIdSetting,
  inventoryMediaLimitsSetting,
  deriveGatusPushFactKey,
  GATUS_PUSH_FACT_SLUGS,
  GATUS_PUSH_SECRET_KEY,
  gatusPushFactKeys,
  gatusPushSetting,
  gatusRateBudgetSetting,
  integrationsEnabledSetting,
  monitorObservationCapsSetting,
  orderPayloadRetentionSetting,
  providerWritePolicySetting,
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
      value: { mode: "keep", afterDays: 180 },
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

  // -------------------------------------------------------------------------
  // Key-addressed write path (loxep-fev) — what `/settings/application`'s edit
  // dialog reaches: a KEY plus a value of unknown shape.
  // -------------------------------------------------------------------------

  it("findRegisteredSetting resolves the registry's own definition", () => {
    expect(findRegisteredSetting(pollingDefaults.key)).toBe(pollingDefaults);
    expect(findRegisteredSetting("test.never_declared")).toBeUndefined();
  });

  it("setByKey rejects a key nothing registered, writing nothing", async () => {
    await expect(
      service.setByKey("test.not_a_setting", { anything: true }, {}),
    ).rejects.toBeInstanceOf(SettingNotRegisteredError);
    const rows = await handle.pool.query(
      "select 1 from application_settings where key = $1",
      ["test.not_a_setting"],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("setByKey rejects wrong shapes, unknown properties, and wrong types", async () => {
    const key = monitorObservationCapsSetting.key;
    // Wrong type for a field.
    await expect(
      service.setByKey(
        key,
        { watchlistItemsPerPoll: "20", searchItemsPerPoll: 50 },
        { actorUserId: actorId },
      ),
    ).rejects.toBeInstanceOf(SettingValidationError);
    // Out of range.
    await expect(
      service.setByKey(
        key,
        { watchlistItemsPerPoll: 0, searchItemsPerPoll: 50 },
        { actorUserId: actorId },
      ),
    ).rejects.toBeInstanceOf(SettingValidationError);
    // Unknown property — the shipped schemas are strictObject.
    await expect(
      service.setByKey(
        key,
        { watchlistItemsPerPoll: 20, searchItemsPerPoll: 50, extra: 1 },
        { actorUserId: actorId },
      ),
    ).rejects.toBeInstanceOf(SettingValidationError);
    // Not an object at all.
    await expect(
      service.setByKey(key, "20", { actorUserId: actorId }),
    ).rejects.toBeInstanceOf(SettingValidationError);

    // The message names the offending path so the operator's dialog can show it.
    await expect(
      service.setByKey(key, { watchlistItemsPerPoll: 20 }, {}),
    ).rejects.toThrow(/searchItemsPerPoll/);

    // Nothing was persisted and nothing was audited by any of the above.
    const rows = await handle.pool.query(
      "select 1 from application_settings where key = $1",
      [key],
    );
    expect(rows.rowCount).toBe(0);
    const audits = await handle.pool.query(
      "select 1 from audit_events where resource_id = $1",
      [key],
    );
    expect(audits.rowCount).toBe(0);
  });

  it("setByKey round-trips a valid value and audits it like set()", async () => {
    const entry = await service.setByKey(
      monitorObservationCapsSetting.key,
      { watchlistItemsPerPoll: 25, searchItemsPerPoll: 75 },
      { actorUserId: actorId, requestId: "req-setbykey-1" },
    );
    expect(entry).toMatchObject({
      key: monitorObservationCapsSetting.key,
      description: monitorObservationCapsSetting.description,
      schemaVersion: monitorObservationCapsSetting.schemaVersion,
      isSet: true,
      value: { watchlistItemsPerPoll: 25, searchItemsPerPoll: 75 },
      updatedByUserId: actorId,
    });
    expect(entry.updatedAt).toBeInstanceOf(Date);

    // The typed reader (the worker's path) sees the same value.
    await expect(
      service.get(monitorObservationCapsSetting),
    ).resolves.toEqual({
      watchlistItemsPerPoll: 25,
      searchItemsPerPoll: 75,
    });

    // A second write upserts the one row and audits an update, not a create.
    await service.setByKey(
      monitorObservationCapsSetting.key,
      { watchlistItemsPerPoll: 30, searchItemsPerPoll: 80 },
      { actorUserId: actorId },
    );
    const rows = await handle.pool.query<{ count: number }>(
      "select count(*)::int as count from application_settings where key = $1",
      [monitorObservationCapsSetting.key],
    );
    expect(rows.rows[0]?.count).toBe(1);

    const audits = await handle.pool.query<{
      action: string;
      request_id: string | null;
      actor_user_id: string;
    }>(
      `select * from audit_events
        where resource_type = 'application_setting' and resource_id = $1
        order by occurred_at asc`,
      [monitorObservationCapsSetting.key],
    );
    expect(audits.rowCount).toBe(2);
    expect(audits.rows[0]?.action).toBe("settings.create");
    expect(audits.rows[0]?.request_id).toBe("req-setbykey-1");
    expect(audits.rows[0]?.actor_user_id).toBe(actorId);
    expect(audits.rows[1]?.action).toBe("settings.update");
  });

  it("setByKey validates a non-object setting's schema too", async () => {
    await expect(
      service.setByKey(displayName.key, "", {}),
    ).rejects.toBeInstanceOf(SettingValidationError);
    const entry = await service.setByKey(displayName.key, "Ops Loxep", {
      actorUserId: actorId,
    });
    expect(entry.value).toBe("Ops Loxep");
    await expect(service.get(displayName)).resolves.toBe("Ops Loxep");
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

describe("Phase 7 infrastructure settings", () => {
  /**
   * Open question 2 is OWNER-REVIEW-CRITICAL and was resolved PROVISIONAL per
   * its own recommendation with one amendment: **no default issuer list.**
   *
   * A wrong CAA record silently breaks certificate renewal and the failure
   * surfaces at expiry, not at write time. This assertion is what stops a
   * future edit from "helpfully" seeding `letsencrypt.org` and turning an
   * unreviewed guess into published policy.
   */
  it("ships the CAA policy EMPTY and unreviewed, never a guessed issuer list", () => {
    expect(caaPolicySetting.key).toBe("infrastructure.caa_policy");
    expect(caaPolicySetting.defaultValue).toEqual({
      reviewed: false,
      issuers: [],
      wildcardIssuers: [],
      iodef: null,
    });
  });

  it("keeps 'reviewed' independent of the issuer list", () => {
    // An empty REVIEWED policy ("no CA may issue for these names") is a
    // legitimate deliberate stance and must be distinguishable from "nobody
    // has looked at this yet". Deriving one from the other would collapse them.
    const parsed = caaPolicySetting.schema.parse({
      reviewed: true,
      issuers: [],
      wildcardIssuers: [],
      iodef: null,
    });
    expect(parsed.reviewed).toBe(true);
  });

  it("claims only a fraction of Cloudflare's per-user account ceiling", () => {
    // Cloudflare allows 1200 requests per five minutes PER USER — four per
    // second — shared with the operator's own dashboard.
    expect(cloudflareRateBudgetSetting.key).toBe(
      "integration.cloudflare.rate_budget",
    );
    expect(cloudflareRateBudgetSetting.defaultValue.refillPerSecond).toBeLessThan(
      1200 / 300,
    );
  });
});

describe("documents.media_limits setting (loxep-cd3.2, M2)", () => {
  it("mirrors inventoryMediaLimitsSetting's shape and default exactly", () => {
    expect(documentsMediaLimitsSetting.key).toBe("documents.media_limits");
    expect(documentsMediaLimitsSetting.schemaVersion).toBe(1);
    expect(documentsMediaLimitsSetting.defaultValue).toEqual(
      inventoryMediaLimitsSetting.defaultValue,
    );
    expect(documentsMediaLimitsSetting.defaultValue).toEqual({
      maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
    });
  });

  it("is registered", () => {
    expect(registeredApplicationSettings).toContain(documentsMediaLimitsSetting);
  });

  it("rejects an oversized cap and an empty MIME allowlist", () => {
    expect(
      documentsMediaLimitsSetting.schema.safeParse({
        maxBytes: 10 * 1024 * 1024,
        allowedMimeTypes: ["image/png"],
      }).success,
    ).toBe(true);
    expect(
      documentsMediaLimitsSetting.schema.safeParse({
        maxBytes: 300 * 1024 * 1024,
        allowedMimeTypes: ["image/png"],
      }).success,
    ).toBe(false);
    expect(
      documentsMediaLimitsSetting.schema.safeParse({
        maxBytes: 10 * 1024 * 1024,
        allowedMimeTypes: [],
      }).success,
    ).toBe(false);
  });
});

describe("documents.parser_id setting (loxep-cd3.4, M4)", () => {
  it("defaults to the manual-assisted backend — an install upgrades into OCR explicitly", () => {
    expect(documentsParserIdSetting.key).toBe("documents.parser_id");
    expect(documentsParserIdSetting.schemaVersion).toBe(1);
    expect(documentsParserIdSetting.defaultValue).toEqual({ parserId: "manual" });
  });

  it("is registered", () => {
    expect(registeredApplicationSettings).toContain(documentsParserIdSetting);
  });

  it("accepts any non-empty parser id — the ParserRegistry, not this schema, is the source of truth for which ids exist", () => {
    expect(
      documentsParserIdSetting.schema.safeParse({ parserId: "ocr_tesseract" }).success,
    ).toBe(true);
    expect(documentsParserIdSetting.schema.safeParse({ parserId: "" }).success).toBe(false);
    expect(documentsParserIdSetting.schema.safeParse({}).success).toBe(false);
  });
});

describe("Phase 8 milestone 2 Gatus push setting", () => {
  // Ships disabled with no base URL/key, the same "unreviewed/unconfigured
  // must not look like ready" discipline caaPolicySetting uses — a push job
  // that read this setting with nothing set must have something to no-op on.
  it("ships disabled with no base URL or endpoint key, mode 'single'", () => {
    expect(gatusPushSetting.key).toBe("infrastructure.gatus_push");
    expect(gatusPushSetting.defaultValue).toEqual({
      enabled: false,
      baseUrl: null,
      endpointKey: null,
      mode: "single",
    });
  });

  // loxep-4ah: `mode` is an ADDITIVE field — a value stored before this field
  // existed (no `mode` key at all) must still parse, defaulting to 'single'
  // so an existing installation's behavior never silently changes underneath
  // it.
  it("backfills 'mode: single' when parsing a value stored before the field existed", () => {
    const parsed = gatusPushSetting.schema.safeParse({
      enabled: true,
      baseUrl: "https://gatus.example.com",
      endpointKey: "core_loxep",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mode).toBe("single");
  });

  it("accepts 'facts' mode and rejects an unrecognized mode", () => {
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: "https://gatus.example.com",
        endpointKey: "core_loxep",
        mode: "facts",
      }).success,
    ).toBe(true);
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: "https://gatus.example.com",
        endpointKey: "core_loxep",
        mode: "both",
      }).success,
    ).toBe(false);
  });

  it("accepts a well-formed GROUP_ENDPOINT key and rejects a malformed one", () => {
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: "https://gatus.example.com",
        endpointKey: "core_loxep",
      }).success,
    ).toBe(true);
    // No underscore separating group from endpoint.
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: "https://gatus.example.com",
        endpointKey: "loxep",
      }).success,
    ).toBe(false);
    // Not a URL.
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: "not-a-url",
        endpointKey: "core_loxep",
      }).success,
    ).toBe(false);
    // Unknown property — strictObject.
    expect(
      gatusPushSetting.schema.safeParse({
        enabled: true,
        baseUrl: null,
        endpointKey: null,
        token: "nope",
      }).success,
    ).toBe(false);
  });

  it("is registered", () => {
    expect(registeredApplicationSettings).toContain(gatusPushSetting);
  });

  it("derives five stable, distinct fact keys from a base endpoint key, in a fixed order", () => {
    expect(GATUS_PUSH_FACT_SLUGS).toEqual([
      "worker-backlog",
      "sync-freshness",
      "notifications",
      "drift",
      "readiness",
    ]);
    expect(deriveGatusPushFactKey("core_loxep", "worker-backlog")).toBe(
      "core_loxep-worker-backlog",
    );
    const keys = gatusPushFactKeys("core_loxep");
    expect(keys).toEqual([
      "core_loxep-worker-backlog",
      "core_loxep-sync-freshness",
      "core_loxep-notifications",
      "core_loxep-drift",
      "core_loxep-readiness",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    // None of the derived keys ever equals the base key itself — the base
    // key is a derivation seed in 'facts' mode, never pushed to directly.
    expect(keys).not.toContain("core_loxep");
  });

  it("stores the push token under a stable, shared secret key", () => {
    // Both @loxep/app (reads it) and apps/web (writes it) import this
    // constant rather than each hard-coding the literal.
    expect(GATUS_PUSH_SECRET_KEY).toBe("infrastructure.gatus_push.default");
  });
});

describe("Phase 8 milestone 4 Gatus read-adapter rate budget", () => {
  it("mirrors the adapter's own suggested token-bucket default", () => {
    // packages/integrations/gatus/src/rate-budget.ts's
    // GATUS_SUGGESTED_CAPACITY/GATUS_SUGGESTED_REFILL_PER_SECOND — this
    // module cannot import an integration package, so the values are
    // duplicated as literals, the same way ebayRateBudgetSetting's are.
    expect(gatusRateBudgetSetting.key).toBe("integration.gatus.rate_budget");
    expect(gatusRateBudgetSetting.defaultValue).toEqual({
      capacity: 10,
      refillPerSecond: 2,
    });
  });

  it("is registered", () => {
    expect(registeredApplicationSettings).toContain(gatusRateBudgetSetting);
  });

  it("rejects a non-positive refill rate and an oversized capacity", () => {
    expect(
      gatusRateBudgetSetting.schema.safeParse({ capacity: 10, refillPerSecond: 0 })
        .success,
    ).toBe(false);
    expect(
      gatusRateBudgetSetting.schema.safeParse({ capacity: 5000, refillPerSecond: 2 })
        .success,
    ).toBe(false);
  });
});

describe("integrations.enabled catalog-visibility setting (loxep-dgg)", () => {
  it("is registered under the documented key", () => {
    expect(integrationsEnabledSetting.key).toBe("integrations.enabled");
    expect(registeredApplicationSettings).toContain(integrationsEnabledSetting);
  });

  // PROVISIONAL default (owner note, loxep-dgg): all-on via an EMPTY map, not
  // a curated minimal set — an absent setting must never hide a provider an
  // existing operator already uses. See this setting's own doc comment in
  // settings-defaults.ts for the full reasoning and the "revisit later" note.
  it("ships all-on: an EMPTY map, PROVISIONAL default", () => {
    expect(integrationsEnabledSetting.defaultValue).toEqual({});
  });

  it("accepts a map of arbitrary string ids to booleans", () => {
    expect(
      integrationsEnabledSetting.schema.safeParse({
        ebay: true,
        etsy: false,
        "some-future-provider": true,
      }).success,
    ).toBe(true);
    // The empty default itself must validate.
    expect(integrationsEnabledSetting.schema.safeParse({}).success).toBe(
      true,
    );
  });

  it("rejects non-boolean values and non-object shapes", () => {
    expect(
      integrationsEnabledSetting.schema.safeParse({ ebay: "false" }).success,
    ).toBe(false);
    expect(
      integrationsEnabledSetting.schema.safeParse({ ebay: 0 }).success,
    ).toBe(false);
    expect(integrationsEnabledSetting.schema.safeParse("ebay").success).toBe(
      false,
    );
    expect(integrationsEnabledSetting.schema.safeParse(null).success).toBe(
      false,
    );
    expect(integrationsEnabledSetting.schema.safeParse([]).success).toBe(
      false,
    );
  });

  it("round-trips through the settings service like every other registered setting", async () => {
    const dbName = scratchDbName("loxep_test_domain_integrations_enabled");
    const databaseUrl = await createScratchDb(dbName);
    try {
      await runMigrations({ databaseUrl, logger: silentLogger });
      const handle = createDb(databaseUrl);
      try {
        const service = createSettingsService({ db: handle.db });

        // Unset: default (all-on) applies.
        await expect(
          service.get(integrationsEnabledSetting),
        ).resolves.toEqual({});

        // Explicitly hiding one provider leaves every other id implicitly
        // enabled (absence-means-visible), not just the ones already known.
        const written = await service.set(
          integrationsEnabledSetting,
          { termix: false },
          {},
        );
        expect(written).toEqual({ termix: false });
        await expect(
          service.get(integrationsEnabledSetting),
        ).resolves.toEqual({ termix: false });
      } finally {
        await closeDb(handle);
      }
    } finally {
      await dropScratchDb(dbName);
    }
  });
});

describe("auth.provisioning account provisioning policy (ADR-0024, loxep-x2s)", () => {
  it("is registered under the documented key", () => {
    expect(authProvisioningSetting.key).toBe("auth.provisioning");
    expect(registeredApplicationSettings).toContain(authProvisioningSetting);
  });

  // CONFIRMED default (owner ruling 2026-08-15, loxep-yk8, resolving the
  // question loxep-x2s was filed to ask): closed for BOTH methods, with
  // @loxep/auth force-opening provisioning while the installation has no admin
  // user at all so a new deployment can still bootstrap itself. See this
  // setting's own doc comment and ADR-0024 for the asymmetry argument and for
  // why the `oidc`-defaults-to-'open' split was rejected in favor of the
  // onboarding card (auth.onboarding_oidc_prompt_dismissed, below).
  it("ships closed for both methods, with no allowlist and no claim mapping", () => {
    expect(authProvisioningSetting.defaultValue).toEqual({
      newUsers: { magicLink: "closed", oidc: "closed" },
      magicLinkEmailDomains: [],
      oidcAdminClaim: { claim: null, adminValues: [], applyOn: "create" },
    });
    // The default must itself validate — it is what an unset installation runs.
    expect(
      authProvisioningSetting.schema.safeParse(authProvisioningSetting.defaultValue)
        .success,
    ).toBe(true);
  });

  it("accepts a fully configured policy", () => {
    expect(
      authProvisioningSetting.schema.safeParse({
        newUsers: { magicLink: "open", oidc: "closed" },
        magicLinkEmailDomains: ["example.com"],
        oidcAdminClaim: {
          claim: "realm_access.roles",
          adminValues: ["loxep-admins"],
          applyOn: "every_sign_in",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown stance, an unknown apply moment, and extra keys", () => {
    const valid = authProvisioningSetting.defaultValue;
    expect(
      authProvisioningSetting.schema.safeParse({
        ...valid,
        newUsers: { magicLink: "invite-only", oidc: "closed" },
      }).success,
    ).toBe(false);
    expect(
      authProvisioningSetting.schema.safeParse({
        ...valid,
        oidcAdminClaim: { claim: "groups", adminValues: [], applyOn: "hourly" },
      }).success,
    ).toBe(false);
    // Deliberately no third "mode" flag: per-method stances are the only
    // representation (ADR-0024 decision 1).
    expect(
      authProvisioningSetting.schema.safeParse({ ...valid, mode: "closed" })
        .success,
    ).toBe(false);
  });

  it("rejects blank domains and blank admin values", () => {
    const valid = authProvisioningSetting.defaultValue;
    expect(
      authProvisioningSetting.schema.safeParse({
        ...valid,
        magicLinkEmailDomains: [""],
      }).success,
    ).toBe(false);
    expect(
      authProvisioningSetting.schema.safeParse({
        ...valid,
        oidcAdminClaim: { claim: "", adminValues: [], applyOn: "create" },
      }).success,
    ).toBe(false);
  });
});

describe("auth.onboarding_oidc_prompt_dismissed (ADR-0024, loxep-yk8)", () => {
  it("is registered under the documented key, defaulting to false", () => {
    expect(authOnboardingOidcPromptDismissedSetting.key).toBe(
      "auth.onboarding_oidc_prompt_dismissed",
    );
    expect(registeredApplicationSettings).toContain(
      authOnboardingOidcPromptDismissedSetting,
    );
    expect(authOnboardingOidcPromptDismissedSetting.defaultValue).toBe(false);
  });

  it("accepts only a bare boolean", () => {
    expect(
      authOnboardingOidcPromptDismissedSetting.schema.safeParse(true).success,
    ).toBe(true);
    expect(
      authOnboardingOidcPromptDismissedSetting.schema.safeParse(false).success,
    ).toBe(true);
    expect(
      authOnboardingOidcPromptDismissedSetting.schema.safeParse("true").success,
    ).toBe(false);
    expect(
      authOnboardingOidcPromptDismissedSetting.schema.safeParse(null).success,
    ).toBe(false);
  });
});

describe("infrastructure.provider_write_policy setting (Pangolin chain design M3, loxep-acj.3)", () => {
  it("is registered under the documented key", () => {
    expect(providerWritePolicySetting.key).toBe(
      "infrastructure.provider_write_policy",
    );
    expect(registeredApplicationSettings).toContain(providerWritePolicySetting);
  });

  // The load-bearing default: an EMPTY map means every connection resolves
  // to 'read_only' (via resolveProviderWritePolicy's own fallback), so a
  // fresh install cannot write to any provider without an explicit, audited
  // flip.
  it("ships EMPTY, so every connection defaults to read_only", () => {
    expect(providerWritePolicySetting.defaultValue).toEqual({});
  });

  it("accepts a map of connection ids to any of the four tiers", () => {
    expect(
      providerWritePolicySetting.schema.safeParse({
        "conn-1": "read_only",
        "conn-2": "additive",
        "conn-3": "access_affecting",
        "conn-4": "lockout_class",
      }).success,
    ).toBe(true);
    expect(providerWritePolicySetting.schema.safeParse({}).success).toBe(true);
  });

  it("rejects an unregistered tier value and non-object shapes", () => {
    expect(
      providerWritePolicySetting.schema.safeParse({ "conn-1": "allow" }).success,
    ).toBe(false);
    expect(
      providerWritePolicySetting.schema.safeParse({ "conn-1": true }).success,
    ).toBe(false);
    expect(providerWritePolicySetting.schema.safeParse("read_only").success).toBe(
      false,
    );
    expect(providerWritePolicySetting.schema.safeParse(null).success).toBe(false);
    expect(providerWritePolicySetting.schema.safeParse([]).success).toBe(false);
  });

  it("round-trips through the settings service, audited like every other write", async () => {
    const dbName = scratchDbName("loxep_test_domain_write_policy");
    const databaseUrl = await createScratchDb(dbName);
    try {
      await runMigrations({ databaseUrl, logger: silentLogger });
      const handle = createDb(databaseUrl);
      try {
        const service = createSettingsService({ db: handle.db });
        const adminId = await insertTestUser(
          handle.db,
          "user_write_policy_admin",
        );

        await expect(
          service.get(providerWritePolicySetting),
        ).resolves.toEqual({});

        const written = await service.set(
          providerWritePolicySetting,
          { "conn-pangolin-1": "additive" },
          { actorUserId: adminId },
        );
        expect(written).toEqual({ "conn-pangolin-1": "additive" });
        await expect(
          service.get(providerWritePolicySetting),
        ).resolves.toEqual({ "conn-pangolin-1": "additive" });

        // settings.ts's write() appends an audit_events row in the SAME
        // transaction as every other registered setting — this setting adds
        // no bespoke auditing, it inherits it.
        const audit = await handle.pool.query<{
          action: string;
          actor_user_id: string | null;
        }>(
          `select action, actor_user_id
             from audit_events
            where resource_type = 'application_setting'
              and resource_id = $1
            order by occurred_at desc
            limit 1`,
          [providerWritePolicySetting.key],
        );
        expect(audit.rows[0]?.action).toBe("settings.create");
        expect(audit.rows[0]?.actor_user_id).toBe(adminId);
      } finally {
        await closeDb(handle);
      }
    } finally {
      await dropScratchDb(dbName);
    }
  });
});
