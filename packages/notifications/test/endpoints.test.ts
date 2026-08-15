/**
 * Endpoint/rule integration tests (loxep-ubx.4) against real PostgreSQL:
 * config validation, encrypted token storage via application secrets, and
 * rule matching.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  NotificationNotFoundError,
  NotificationValidationError,
  createNotificationService,
  endpointSecretKey,
  matchRules,
} from "../src/index.ts";
import type { NotificationService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertMonitorTarget,
  scratchDbName,
  silentLogger,
  testSecretsService,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_endpoints");
let handle: DbHandle;
let service: NotificationService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  service = createNotificationService({
    db: handle.db,
    secrets: testSecretsService(handle.db),
  });
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

const validConfig = {
  baseUrl: "https://ntfy.example.test",
  topic: "loxep",
};

describe("endpoint CRUD and config validation", () => {
  it("creates/reads/updates/deletes an ntfy endpoint", async () => {
    const created = await service.createEndpoint({
      provider: "ntfy",
      name: "ops phone",
      config: { ...validConfig, priority: "high" },
    });
    expect(created.enabled).toBe(true);
    expect(created.secretId).toBeNull();
    expect(created.config).toEqual({ ...validConfig, priority: "high" });

    const updated = await service.updateEndpoint(created.id, {
      name: "ops phone (renamed)",
      enabled: false,
      config: validConfig,
    });
    expect(updated.name).toBe("ops phone (renamed)");
    expect(updated.enabled).toBe(false);
    expect(updated.config).toEqual(validConfig);

    await service.deleteEndpoint(created.id);
    await expect(service.getEndpoint(created.id)).rejects.toThrow(
      NotificationNotFoundError,
    );
  });

  it("rejects unknown providers and invalid configs", async () => {
    await expect(
      service.createEndpoint({
        provider: "carrier_pigeon",
        name: "nope",
        config: validConfig,
      }),
    ).rejects.toThrow(NotificationValidationError);
    await expect(
      service.createEndpoint({
        provider: "ntfy",
        name: "bad url",
        config: { baseUrl: "not a url", topic: "x" },
      }),
    ).rejects.toThrow(NotificationValidationError);
    await expect(
      service.createEndpoint({
        provider: "ntfy",
        name: "bad topic",
        config: { baseUrl: "https://ntfy.example.test", topic: "has spaces" },
      }),
    ).rejects.toThrow(NotificationValidationError);
    await expect(
      service.createEndpoint({
        provider: "ntfy",
        name: "bad priority",
        config: { ...validConfig, priority: "extreme" },
      }),
    ).rejects.toThrow(NotificationValidationError);
    // Config re-validation applies on update, too.
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "update-validate",
      config: validConfig,
    });
    await expect(
      service.updateEndpoint(endpoint.id, { config: { topic: "only" } }),
    ).rejects.toThrow(NotificationValidationError);
  });
});

describe("endpoint token secrets", () => {
  it("stores the token encrypted under the endpoint's application secret", async () => {
    const token = "tk_super_secret_value";
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "with token",
      config: validConfig,
      token,
    });
    expect(endpoint.secretId).not.toBeNull();
    // Token never lands in the endpoint row/config.
    expect(JSON.stringify(endpoint)).not.toContain(token);

    const secret = await handle.db.query.applicationSecrets.findFirst({
      where: (table, { eq }) =>
        eq(table.secretKey, endpointSecretKey(endpoint.id)),
    });
    expect(secret).toBeDefined();
    expect(secret?.id).toBe(endpoint.secretId);
    expect(secret?.purpose).toBe("token");

    // Ciphertext at rest never contains the plaintext token.
    const versions = await handle.db.query.applicationSecretVersions.findMany({
      where: (table, { eq }) => eq(table.secretId, secret!.id),
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.ciphertext.toString("utf8")).not.toContain(token);

    // Round-trips through the secrets service.
    await expect(service.getEndpointToken(endpoint.id)).resolves.toBe(token);
  });

  it("rotates the token on update and returns null without one", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "rotating",
      config: validConfig,
      token: "tk_v1",
    });
    await service.updateEndpoint(endpoint.id, { token: "tk_v2" });
    await expect(service.getEndpointToken(endpoint.id)).resolves.toBe("tk_v2");
    const secret = await handle.db.query.applicationSecrets.findFirst({
      where: (table, { eq }) =>
        eq(table.secretKey, endpointSecretKey(endpoint.id)),
    });
    expect(secret?.currentVersion).toBe(2);

    // Adding a token later to a token-less endpoint also works.
    const bare = await service.createEndpoint({
      provider: "ntfy",
      name: "bare",
      config: validConfig,
    });
    await expect(service.getEndpointToken(bare.id)).resolves.toBeNull();
    await service.updateEndpoint(bare.id, { token: "tk_added" });
    await expect(service.getEndpointToken(bare.id)).resolves.toBe("tk_added");
  });
});

describe("rule CRUD and matching", () => {
  it("matches enabled rules by event type and monitor target with NULL wildcards", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "rule matching endpoint",
      config: validConfig,
    });
    const monitorA = await insertMonitorTarget(handle.db, "monitor A");
    const monitorB = await insertMonitorTarget(handle.db, "monitor B");

    const wildcard = await service.createRule({
      name: "everything",
      endpointId: endpoint.id,
      eventClass: "market",
    });
    const priceDropsOnly = await service.createRule({
      name: "price drops only",
      endpointId: endpoint.id,
      eventClass: "market",
      eventType: "price_dropped",
    });
    const monitorAOnly = await service.createRule({
      name: "monitor A only",
      endpointId: endpoint.id,
      eventClass: "market",
      monitorTargetId: monitorA,
    });
    const disabled = await service.createRule({
      name: "disabled",
      endpointId: endpoint.id,
      eventClass: "market",
      enabled: false,
    });
    // A rule in ANOTHER class must never match a market event, however wide
    // its other dimensions are (ADR-0023: there is no "any class" wildcard).
    const healthRule = await service.createRule({
      name: "health degradations",
      endpointId: endpoint.id,
      eventClass: "health",
    });

    const idsFor = async (eventType: string, monitorTargetId: string | null) =>
      (await matchRules(handle.db, { eventType, monitorTargetId }))
        .map((rule) => rule.id)
        .sort();

    // price_dropped from monitor A: wildcard + type rule + monitor rule.
    expect(await idsFor("price_dropped", monitorA)).toEqual(
      [wildcard.id, priceDropsOnly.id, monitorAOnly.id].sort(),
    );
    // restocked from monitor B: wildcard only.
    expect(await idsFor("restocked", monitorB)).toEqual([wildcard.id]);
    // Event without a monitor target matches only monitor-agnostic rules.
    expect(await idsFor("price_dropped", null)).toEqual(
      [wildcard.id, priceDropsOnly.id].sort(),
    );
    // Disabled rules never match.
    expect(await idsFor("price_dropped", monitorA)).not.toContain(disabled.id);
    // The class dimension isolates: a health rule never matches a market
    // event, and a market rule never matches a health transition.
    expect(await idsFor("price_dropped", monitorA)).not.toContain(
      healthRule.id,
    );
    const healthMatches = await matchRules(handle.db, {
      eventClass: "health",
      eventType: "health_degraded",
      monitorTargetId: null,
    });
    expect(healthMatches.map((rule) => rule.id)).toEqual([healthRule.id]);
  });

  it("validates rule inputs and updates/deletes rules", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "rule crud endpoint",
      config: validConfig,
    });
    await expect(
      service.createRule({
        name: "unknown event type",
        endpointId: endpoint.id,
        eventClass: "market",
        eventType: "price_exploded",
      }),
    ).rejects.toThrow(/not registered for notification class "market"/);
    // A real event type from the WRONG class is refused too: the pair, not
    // the type alone, is what the registry validates.
    await expect(
      service.createRule({
        name: "cross-class type",
        endpointId: endpoint.id,
        eventClass: "health",
        eventType: "price_dropped",
      }),
    ).rejects.toThrow(/not registered for notification class "health"/);
    await expect(
      service.createRule({
        name: "unknown endpoint",
        endpointId: "00000000-0000-4000-8000-000000000000",
        eventClass: "market",
      }),
    ).rejects.toThrow(NotificationNotFoundError);

    const rule = await service.createRule({
      name: "to update",
      endpointId: endpoint.id,
      eventClass: "market",
      eventType: "restocked",
    });
    const updated = await service.updateRule(rule.id, {
      enabled: false,
      eventType: null,
    });
    expect(updated.enabled).toBe(false);
    expect(updated.eventType).toBeNull();
    // Switching class re-validates the (class, type) pair.
    const reclassed = await service.updateRule(rule.id, {
      eventClass: "health",
      eventType: "health_degraded",
    });
    expect(reclassed.eventClass).toBe("health");
    expect(reclassed.eventType).toBe("health_degraded");
    await expect(
      service.updateRule(rule.id, { eventType: "price_dropped" }),
    ).rejects.toThrow(/not registered for notification class "health"/);
    await service.deleteRule(rule.id);
    await expect(service.getRule(rule.id)).rejects.toThrow(
      NotificationNotFoundError,
    );
  });
});
