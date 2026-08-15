/**
 * External-resource companion-link service tests (loxep-v5r.3): register,
 * attach, list, and detach, plus the idempotency guarantee the unique
 * constraint (`resource_links_resource_purpose_uq`, migration 0004,
 * loxep-dyx) exists to provide, and the orphan-cleanup behavior `detachLink`
 * documents.
 *
 * Also covers `upsertExternalResource` (loxep-uhs, migration 0021): the
 * concurrent-discovery regression the partial
 * `external_resources_provider_type_external_id_uq` index exists to close —
 * two genuinely concurrent adapter sweeps observing the same provider object
 * must collapse to one row, not one row per sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  DomainValidationError,
  createResourceLinksService,
} from "../src/index.ts";
import type { ResourceLinksService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const TARGET_A = "00000000-0000-4000-8000-0000000000a1";
const TARGET_B = "00000000-0000-4000-8000-0000000000b2";

describe("resource links service", () => {
  const dbName = scratchDbName("loxep_test_domain_resource_links");
  let handle: DbHandle;
  let service: ResourceLinksService;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createResourceLinksService({ db: handle.db });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("registers an external resource with no attachment yet", async () => {
    const resource = await service.registerExternalResource({
      provider: "gatus",
      externalType: "dashboard",
      url: "https://gatus.example.test/status",
      title: "Fleet status page",
    });
    expect(resource.id).toBeTruthy();
    expect(resource.provider).toBe("gatus");
    expect(resource.title).toBe("Fleet status page");
    expect(resource.metadata).toEqual({});

    const links = await service.listLinksFor("hosting_target", TARGET_A);
    expect(links).toEqual([]);
  });

  it("createLink registers and attaches in one call, then lists it", async () => {
    const link = await service.createLink({
      provider: "beszel",
      externalType: "hub",
      url: "https://beszel.example.test/",
      title: "Beszel hub",
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "metrics_console",
    });
    expect(link.provider).toBe("beszel");
    expect(link.resourceType).toBe("hosting_target");
    expect(link.resourceId).toBe(TARGET_A);
    expect(link.purpose).toBe("metrics_console");

    const links = await service.listLinksFor("hosting_target", TARGET_A);
    expect(links).toHaveLength(1);
    expect(links[0]?.externalResourceId).toBe(link.externalResourceId);
    expect(links[0]?.url).toBe("https://beszel.example.test/");
  });

  it("attachLink is idempotent on the (resource, type, id, purpose) unique key", async () => {
    const resource = await service.registerExternalResource({
      provider: "dockhand",
      externalType: "environment",
      url: "https://dockhand.example.test/",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "container_console",
    });
    // At-least-once retry of the same attach must not double the row.
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "container_console",
    });

    const links = await service.listLinksFor("hosting_target", TARGET_B);
    expect(links).toHaveLength(1);
  });

  it("the same external resource can carry two different purposes on the same record", async () => {
    const resource = await service.registerExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      url: "https://gatus.example.test/endpoint/1",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "uptime_check",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "status_page",
    });

    const links = await service.listLinksFor("hosting_target", TARGET_B);
    const purposes = links
      .filter((link) => link.externalResourceId === resource.id)
      .map((link) => link.purpose)
      .sort();
    expect(purposes).toEqual(["status_page", "uptime_check"]);
  });

  it("listLinksFor only returns links for the requested resource", async () => {
    const linksForA = await service.listLinksFor("hosting_target", TARGET_A);
    const linksForB = await service.listLinksFor("hosting_target", TARGET_B);
    expect(linksForA.every((link) => link.resourceId === TARGET_A)).toBe(true);
    expect(linksForB.every((link) => link.resourceId === TARGET_B)).toBe(true);
  });

  it("rejects an unregistered resource_type", async () => {
    await expect(
      service.listLinksFor(
        // @ts-expect-error deliberately invalid at the type level too
        "not_a_real_resource_type",
        TARGET_A,
      ),
    ).rejects.toThrow(DomainValidationError);
  });

  it("rejects a non-URL value", async () => {
    await expect(
      service.registerExternalResource({
        provider: "gatus",
        externalType: "endpoint",
        url: "not-a-url",
      }),
    ).rejects.toThrow(DomainValidationError);
  });

  it("rejects blank provider/purpose", async () => {
    await expect(
      service.registerExternalResource({
        provider: "  ",
        externalType: "endpoint",
        url: "https://example.test",
      }),
    ).rejects.toThrow(DomainValidationError);

    const resource = await service.registerExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      url: "https://example.test/blank-purpose",
    });
    await expect(
      service.attachLink({
        externalResourceId: resource.id,
        resourceType: "hosting_target",
        resourceId: TARGET_A,
        purpose: "   ",
      }),
    ).rejects.toThrow(DomainValidationError);
  });

  it("detachLink removes the attachment and, once orphaned, the external_resources row", async () => {
    const link = await service.createLink({
      provider: "tailscale",
      externalType: "device",
      url: "https://login.tailscale.com/admin/machines/host-01",
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "private_network",
    });

    let links = await service.listLinksFor("hosting_target", TARGET_A);
    expect(links.some((row) => row.externalResourceId === link.externalResourceId)).toBe(
      true,
    );

    await service.detachLink({
      externalResourceId: link.externalResourceId,
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "private_network",
    });

    links = await service.listLinksFor("hosting_target", TARGET_A);
    expect(links.some((row) => row.externalResourceId === link.externalResourceId)).toBe(
      false,
    );

    // The external_resources row itself is gone too — the row raw-queried
    // through registerExternalResource's own insert path must now be absent.
    const row = await handle.db.query.externalResources.findFirst({
      where: (table, { eq }) => eq(table.id, link.externalResourceId),
    });
    expect(row).toBeUndefined();
  });

  it("detachLink keeps the external_resources row alive while another link still references it", async () => {
    const resource = await service.registerExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      url: "https://gatus.example.test/shared",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "uptime_check",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "uptime_check",
    });

    await service.detachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "uptime_check",
    });

    const row = await handle.db.query.externalResources.findFirst({
      where: (table, { eq }) => eq(table.id, resource.id),
    });
    expect(row).toBeDefined();

    const remainingLinks = await service.listLinksFor("hosting_target", TARGET_B);
    expect(remainingLinks.some((link) => link.externalResourceId === resource.id)).toBe(
      true,
    );
  });

  it("detachLink is idempotent when the link no longer exists", async () => {
    await expect(
      service.detachLink({
        externalResourceId: "00000000-0000-4000-8000-000000000000",
        resourceType: "hosting_target",
        resourceId: TARGET_A,
        purpose: "gone_already",
      }),
    ).resolves.toBeUndefined();
  });

  it("two concurrent upserts of the same (provider, external_type, external_id) collapse to one row and the later metadata wins", async () => {
    // Simulates two overlapping discovery sweeps racing to record the same
    // Beszel system. Without the partial unique index + ON CONFLICT target,
    // this would double the row (and the integration_health subject it
    // becomes) every time two sweeps overlapped.
    const [first, second] = await Promise.all([
      service.upsertExternalResource({
        provider: "beszel",
        externalType: "system",
        externalId: "concurrent-system-1",
        url: "https://beszel.example.test/system/concurrent-system-1",
        title: "sweep A",
        metadata: { cpuPercent: 10 },
      }),
      service.upsertExternalResource({
        provider: "beszel",
        externalType: "system",
        externalId: "concurrent-system-1",
        url: "https://beszel.example.test/system/concurrent-system-1",
        title: "sweep B",
        metadata: { cpuPercent: 20 },
      }),
    ]);
    expect(first.id).toBe(second.id);

    const rows = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, "beszel"),
          eq(table.externalType, "system"),
          eq(table.externalId, "concurrent-system-1"),
        ),
    });
    expect(rows).toHaveLength(1);
    // Whichever call's UPDATE committed last is the row's final state — the
    // regression this test guards against is a SECOND ROW, not which of the
    // two racing writers happened to win; assert the invariant, not the
    // scheduler-dependent winner.
    expect(["sweep A", "sweep B"]).toContain(rows[0]?.title);
    expect([10, 20]).toContain((rows[0]?.metadata as { cpuPercent: number }).cpuPercent);
  });

  it("upsertExternalResource is idempotent on a repeated sequential call, and the newer metadata wins", async () => {
    const first = await service.upsertExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      externalId: "sequential-endpoint-1",
      url: "https://gatus.example.test/endpoint/sequential-1",
      title: "first observation",
      metadata: { status: "up" },
    });
    const second = await service.upsertExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      externalId: "sequential-endpoint-1",
      url: "https://gatus.example.test/endpoint/sequential-1",
      title: "second observation",
      metadata: { status: "down" },
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("second observation");
    expect(second.metadata).toEqual({ status: "down" });
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.updatedAt.getTime(),
    );

    const rows = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, "gatus"),
          eq(table.externalType, "endpoint"),
          eq(table.externalId, "sequential-endpoint-1"),
        ),
    });
    expect(rows).toHaveLength(1);
  });

  it("two rows with a NULL external_id and the same provider/type both insert, unaffected by the partial index", async () => {
    const a = await service.registerExternalResource({
      provider: "manual",
      externalType: "wiki_page",
      url: "https://wiki.example.test/page/one",
    });
    const b = await service.registerExternalResource({
      provider: "manual",
      externalType: "wiki_page",
      url: "https://wiki.example.test/page/two",
    });

    expect(a.id).not.toBe(b.id);
    expect(a.externalId).toBeNull();
    expect(b.externalId).toBeNull();

    const rows = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.provider, "manual"),
          eq(table.externalType, "wiki_page"),
          isNull(table.externalId),
        ),
    });
    expect(rows).toHaveLength(2);
  });

  it("upsertExternalResource rejects a null/absent/blank externalId", async () => {
    await expect(
      service.upsertExternalResource({
        provider: "gatus",
        externalType: "endpoint",
        url: "https://gatus.example.test/endpoint/no-id",
      }),
    ).rejects.toThrow(DomainValidationError);

    await expect(
      service.upsertExternalResource({
        provider: "gatus",
        externalType: "endpoint",
        externalId: null,
        url: "https://gatus.example.test/endpoint/null-id",
      }),
    ).rejects.toThrow(DomainValidationError);

    await expect(
      service.upsertExternalResource({
        provider: "gatus",
        externalType: "endpoint",
        externalId: "   ",
        url: "https://gatus.example.test/endpoint/blank-id",
      }),
    ).rejects.toThrow(DomainValidationError);
  });

  // ---------------------------------------------------------------------------
  // getExternalResource / listUnattachedByProvider (loxep-y64 slice 3, the
  // operator-confirmed attach picker's read side)
  // ---------------------------------------------------------------------------

  it("getExternalResource returns the row by id, or null when it does not exist", async () => {
    const resource = await service.registerExternalResource({
      provider: "beszel",
      externalType: "system",
      externalId: "get-me",
      url: "https://beszel.example.test/system/get-me",
      title: "web-1",
    });

    const found = await service.getExternalResource(resource.id);
    expect(found?.id).toBe(resource.id);
    expect(found?.title).toBe("web-1");

    const missing = await service.getExternalResource(
      "00000000-0000-4000-8000-00000000dead",
    );
    expect(missing).toBeNull();
  });

  it("listUnattachedByProvider lists only rows with zero resource_links, scoped to the given provider", async () => {
    const unattached = await service.upsertExternalResource({
      provider: "beszel",
      externalType: "system",
      externalId: "picker-unattached",
      url: "https://beszel.example.test/system/picker-unattached",
      title: "db-1",
    });
    const attached = await service.upsertExternalResource({
      provider: "beszel",
      externalType: "system",
      externalId: "picker-attached",
      url: "https://beszel.example.test/system/picker-attached",
      title: "app-1",
    });
    await service.attachLink({
      externalResourceId: attached.id,
      resourceType: "hosting_target",
      resourceId: TARGET_A,
      purpose: "host_metrics",
    });
    // A different provider must never show up in beszel's own list.
    await service.registerExternalResource({
      provider: "gatus",
      externalType: "endpoint",
      url: "https://gatus.example.test/endpoint/picker-noise",
    });

    const candidates = await service.listUnattachedByProvider("beszel");
    const ids = candidates.map((row) => row.id);
    expect(ids).toContain(unattached.id);
    expect(ids).not.toContain(attached.id);
    expect(candidates.every((row) => row.provider === "beszel")).toBe(true);
  });

  it("a re-discovered resource becomes a fresh unattached candidate once its only attachment is detached", async () => {
    const resource = await service.upsertExternalResource({
      provider: "beszel",
      externalType: "system",
      externalId: "picker-reoffer",
      url: "https://beszel.example.test/system/picker-reoffer",
    });
    await service.attachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "host_metrics",
    });
    expect(
      (await service.listUnattachedByProvider("beszel")).map((row) => row.id),
    ).not.toContain(resource.id);

    // detachLink deletes the external_resources row once its last link is
    // gone (see that verb's own doc) — so this is not the same row
    // reappearing, it is the NEXT sweep's upsert re-registering the system.
    await service.detachLink({
      externalResourceId: resource.id,
      resourceType: "hosting_target",
      resourceId: TARGET_B,
      purpose: "host_metrics",
    });
    expect(await service.getExternalResource(resource.id)).toBeNull();

    const rediscovered = await service.upsertExternalResource({
      provider: "beszel",
      externalType: "system",
      externalId: "picker-reoffer",
      url: "https://beszel.example.test/system/picker-reoffer",
    });
    expect(
      (await service.listUnattachedByProvider("beszel")).map((row) => row.id),
    ).toContain(rediscovered.id);
  });
});
