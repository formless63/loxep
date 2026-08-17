/**
 * User-preferences registry/service integration tests against a real
 * PostgreSQL (docker/compose.dev.yml) — the loxep-lbj sibling of
 * settings.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  UserPreferenceNotRegisteredError,
  UserPreferenceValidationError,
  createUserPreferencesService,
  defineUserPreference,
  findRegisteredUserPreference,
  dashboardPinnedPagesPreference,
  MAX_PINNED_PAGES,
  registeredUserPreferences,
} from "../src/index.ts";
import type { UserPreferencesService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const favoriteColor = defineUserPreference({
  key: "test.favorite_color",
  schema: z.strictObject({ color: z.string().min(1) }),
  defaultValue: { color: "blue" },
});

describe("user preferences service", () => {
  const dbName = scratchDbName("loxep_test_domain_user_preferences");
  let handle: DbHandle;
  let service: UserPreferencesService;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createUserPreferencesService({ db: handle.db });
    userA = await insertTestUser(handle.db, "user_prefs_a");
    userB = await insertTestUser(handle.db, "user_prefs_b");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("returns the default value when no row exists", async () => {
    await expect(service.get(userA, favoriteColor)).resolves.toEqual({
      color: "blue",
    });
  });

  it("validates through Zod before persistence — safeParse is the sole authority", async () => {
    await expect(
      service.set(userA, favoriteColor, { color: "" }),
    ).rejects.toBeInstanceOf(UserPreferenceValidationError);
    const rows = await handle.pool.query(
      "select 1 from user_preferences where user_id = $1 and key = $2",
      [userA, favoriteColor.key],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("sets, upserts, and reads back a validated value", async () => {
    await service.set(userA, favoriteColor, { color: "red" });
    await expect(service.get(userA, favoriteColor)).resolves.toEqual({
      color: "red",
    });

    // Second write upserts the one row, keyed on (user_id, key).
    await service.set(userA, favoriteColor, { color: "green" });
    const rows = await handle.pool.query<{ count: number }>(
      "select count(*)::int as count from user_preferences where user_id = $1 and key = $2",
      [userA, favoriteColor.key],
    );
    expect(rows.rows[0]?.count).toBe(1);
    await expect(service.get(userA, favoriteColor)).resolves.toEqual({
      color: "green",
    });
  });

  it("scopes reads/writes to the given user id — never a cross-user leak", async () => {
    await service.set(userA, favoriteColor, { color: "purple" });
    // userB never wrote this key, so still sees the default.
    await expect(service.get(userB, favoriteColor)).resolves.toEqual({
      color: "blue",
    });
    await service.set(userB, favoriteColor, { color: "orange" });
    await expect(service.get(userA, favoriteColor)).resolves.toEqual({
      color: "purple",
    });
    await expect(service.get(userB, favoriteColor)).resolves.toEqual({
      color: "orange",
    });
  });

  it("rejects reads and writes for unregistered definitions", async () => {
    const rogue = {
      key: "test.unregistered_pref",
      schema: z.string(),
      defaultValue: "nope",
    };
    await expect(service.get(userA, rogue)).rejects.toBeInstanceOf(
      UserPreferenceNotRegisteredError,
    );
    await expect(
      service.set(userA, rogue, "value"),
    ).rejects.toBeInstanceOf(UserPreferenceNotRegisteredError);

    // A same-key copy that did not come from defineUserPreference is also rejected.
    const imposter = { ...favoriteColor };
    await expect(
      service.set(userA, imposter, { color: "teal" }),
    ).rejects.toBeInstanceOf(UserPreferenceNotRegisteredError);
  });

  it("findRegisteredUserPreference resolves the registry's own definition", () => {
    expect(findRegisteredUserPreference(favoriteColor.key)).toBe(favoriteColor);
    expect(findRegisteredUserPreference("test.never_declared")).toBeUndefined();
  });

  it("rejects duplicate registration of the same key", () => {
    expect(() =>
      defineUserPreference({
        key: favoriteColor.key,
        schema: z.string(),
        defaultValue: "",
      }),
    ).toThrow(/already registered/);
  });
});

describe("dashboard.pinned_pages preference (loxep-lbj)", () => {
  it("is registered under the documented key with an empty-array default", () => {
    expect(dashboardPinnedPagesPreference.key).toBe("dashboard.pinned_pages");
    expect(dashboardPinnedPagesPreference.defaultValue).toEqual([]);
    expect(registeredUserPreferences).toContain(dashboardPinnedPagesPreference);
  });

  it("accepts a well-formed pin list", () => {
    expect(
      dashboardPinnedPagesPreference.schema.safeParse([
        { title: "Overview", url: "/market/overview", icon: "dashboard", workspaceId: "market" },
        { title: "Expenses", url: "/finance/expenses", icon: "fees", workspaceId: "finance" },
      ]).success,
    ).toBe(true);
    // The default value must itself validate.
    expect(
      dashboardPinnedPagesPreference.schema.safeParse(
        dashboardPinnedPagesPreference.defaultValue,
      ).success,
    ).toBe(true);
  });

  it("rejects entries missing fields, wrong types, and unknown properties (strict)", () => {
    expect(
      dashboardPinnedPagesPreference.schema.safeParse([{ title: "Bad" }]).success,
    ).toBe(false);
    expect(
      dashboardPinnedPagesPreference.schema.safeParse([
        { title: "Bad", url: 1, icon: "dashboard", workspaceId: "market" },
      ]).success,
    ).toBe(false);
    expect(
      dashboardPinnedPagesPreference.schema.safeParse([
        {
          title: "Extra",
          url: "/market/overview",
          icon: "dashboard",
          workspaceId: "market",
          extra: true,
        },
      ]).success,
    ).toBe(false);
  });

  it("rejects a list longer than the cap", () => {
    const overCap = Array.from({ length: MAX_PINNED_PAGES + 1 }, (_, index) => ({
      title: `Page ${index}`,
      url: `/market/item-${index}`,
      icon: "dashboard",
      workspaceId: "market",
    }));
    expect(dashboardPinnedPagesPreference.schema.safeParse(overCap).success).toBe(false);
    const atCap = overCap.slice(0, MAX_PINNED_PAGES);
    expect(dashboardPinnedPagesPreference.schema.safeParse(atCap).success).toBe(true);
  });

  it("round-trips through the service like every other registered preference", async () => {
    const dbName = scratchDbName("loxep_test_domain_pinned_pages");
    const databaseUrl = await createScratchDb(dbName);
    try {
      await runMigrations({ databaseUrl, logger: silentLogger });
      const handle = createDb(databaseUrl);
      try {
        const service = createUserPreferencesService({ db: handle.db });
        const userId = await insertTestUser(handle.db, "user_pinned_pages");

        await expect(
          service.get(userId, dashboardPinnedPagesPreference),
        ).resolves.toEqual([]);

        const pins = [
          { title: "Overview", url: "/market/overview", icon: "dashboard", workspaceId: "market" },
        ];
        const written = await service.set(userId, dashboardPinnedPagesPreference, pins);
        expect(written).toEqual(pins);
        await expect(
          service.get(userId, dashboardPinnedPagesPreference),
        ).resolves.toEqual(pins);
      } finally {
        await closeDb(handle);
      }
    } finally {
      await dropScratchDb(dbName);
    }
  });
});
