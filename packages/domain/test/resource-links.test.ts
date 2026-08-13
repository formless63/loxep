/**
 * External-resource companion-link service tests (loxep-v5r.3): register,
 * attach, list, and detach, plus the idempotency guarantee the unique
 * constraint (`resource_links_resource_purpose_uq`, migration 0004,
 * loxep-dyx) exists to provide, and the orphan-cleanup behavior `detachLink`
 * documents.
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
});
