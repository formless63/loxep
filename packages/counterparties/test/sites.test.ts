/**
 * Sites: addresses and places where work happens, owned by the counterparty.
 *
 * Migration 0011 ships `counterparty_sites` alongside its first consumer
 * (`projects`); this is the counterparty-side service half of that slice. See
 * `sites.ts`'s module header for why sites live in THIS package rather than a
 * future `@loxep/work` package.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CounterpartyNotFoundError,
  CounterpartyValidationError,
  createCounterpartiesService,
  createRolesService,
  createSitesService,
} from "../src/index.ts";
import type {
  CounterpartiesService,
  RolesService,
  SitesService,
} from "../src/index.ts";
import { auditEventsFor, createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("counterparty sites", () => {
  let scratch: ScratchDb;
  let parties: CounterpartiesService;
  let roles: RolesService;
  let sites: SitesService;
  let acmeId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_sites");
    parties = createCounterpartiesService({ db: scratch.handle.db });
    roles = createRolesService({ db: scratch.handle.db });
    sites = createSitesService({ db: scratch.handle.db });
    const acme = await parties.create({
      kind: "organization",
      displayName: "Acme Roofing",
    });
    acmeId = acme.id;
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("creates a site with a generated ST-<year>-NNNN code", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Main Warehouse",
      siteKind: "service",
    });
    expect(site.siteCode).toMatch(/^ST-\d{4}-\d{4}$/);
    expect(site.active).toBe(true);
    expect(site.counterpartyId).toBe(acmeId);
  });

  it("accepts an explicit site code", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Billing Address",
      siteKind: "billing",
      siteCode: "ST-EXPLICIT-1",
    });
    expect(site.siteCode).toBe("ST-EXPLICIT-1");
  });

  it("rejects a duplicate site code", async () => {
    await sites.create({
      counterpartyId: acmeId,
      name: "First",
      siteKind: "other",
      siteCode: "ST-DUP-TEST",
    });
    await expect(
      sites.create({
        counterpartyId: acmeId,
        name: "Second",
        siteKind: "other",
        siteCode: "ST-DUP-TEST",
      }),
    ).rejects.toThrow(/ST-DUP-TEST/);
  });

  it("rejects latitude without longitude, and vice versa", async () => {
    await expect(
      sites.create({
        counterpartyId: acmeId,
        name: "Bad Coords",
        siteKind: "service",
        latitude: 40.7128,
      }),
    ).rejects.toThrow(CounterpartyValidationError);
    await expect(
      sites.create({
        counterpartyId: acmeId,
        name: "Bad Coords 2",
        siteKind: "service",
        longitude: -74.006,
      }),
    ).rejects.toThrow(CounterpartyValidationError);
  });

  it("accepts latitude and longitude together", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Job Site",
      siteKind: "service",
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(Number(site.latitude)).toBeCloseTo(40.7128, 4);
    expect(Number(site.longitude)).toBeCloseTo(-74.006, 4);
  });

  it("rejects an unknown site kind at the boundary", async () => {
    await expect(
      sites.create({
        counterpartyId: acmeId,
        name: "Bad Kind",
        // @ts-expect-error deliberately invalid for the test
        siteKind: "warehouse",
      }),
    ).rejects.toThrow(CounterpartyValidationError);
  });

  it("updates fields, including clearing an address line back to null", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Update Target",
      siteKind: "shipping",
      addressLine1: "123 Main St",
      country: "us",
    });
    const updated = await sites.update({
      siteId: site.id,
      addressLine1: null,
      country: "gb",
    });
    expect(updated.addressLine1).toBeNull();
    expect(updated.country).toBe("GB");
    // Untouched fields survive the partial update.
    expect(updated.name).toBe("Update Target");
    expect(updated.siteKind).toBe("shipping");
  });

  it("refuses an update that would leave latitude/longitude mismatched", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Coord Update Target",
      siteKind: "service",
      latitude: 10,
      longitude: 20,
    });
    await expect(
      sites.update({ siteId: site.id, latitude: null }),
    ).rejects.toThrow(CounterpartyValidationError);
  });

  it("deactivates and reactivates without deleting the row", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Toggle Target",
      siteKind: "service",
    });
    const deactivated = await sites.deactivate({ siteId: site.id });
    expect(deactivated.active).toBe(false);
    // Still readable — never deleted.
    await expect(sites.get(site.id)).resolves.toMatchObject({
      id: site.id,
      active: false,
    });
    const reactivated = await sites.reactivate({ siteId: site.id });
    expect(reactivated.active).toBe(true);
  });

  it("listForCounterparty excludes inactive sites by default", async () => {
    const cp = await parties.create({
      kind: "organization",
      displayName: "List Test Co",
    });
    const active = await sites.create({
      counterpartyId: cp.id,
      name: "Active Site",
      siteKind: "service",
    });
    const inactive = await sites.create({
      counterpartyId: cp.id,
      name: "Inactive Site",
      siteKind: "service",
    });
    await sites.deactivate({ siteId: inactive.id });

    const defaultList = await sites.listForCounterparty(cp.id);
    expect(defaultList.map((row) => row.id)).toEqual([active.id]);

    const fullList = await sites.listForCounterparty(cp.id, {
      includeInactive: true,
    });
    expect(fullList.map((row) => row.id).sort()).toEqual(
      [active.id, inactive.id].sort(),
    );
  });

  it("raises CounterpartyNotFoundError for an unknown site", async () => {
    await expect(
      sites.get("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(CounterpartyNotFoundError);
  });

  it("records audit events for create, update, deactivate, and reactivate", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Audit Target",
      siteKind: "service",
    });
    await sites.update({ siteId: site.id, name: "Audit Target Renamed" });
    await sites.deactivate({ siteId: site.id });
    await sites.reactivate({ siteId: site.id });

    const added = await auditEventsFor(scratch, "counterparty.site_added");
    expect(added.some((event) => event.resourceId === acmeId)).toBe(true);

    const updated = await auditEventsFor(scratch, "counterparty.site_updated");
    expect(updated.length).toBeGreaterThan(0);

    const deactivated = await auditEventsFor(
      scratch,
      "counterparty.site_deactivated",
    );
    expect(deactivated.length).toBeGreaterThan(0);

    const reactivated = await auditEventsFor(
      scratch,
      "counterparty.site_reactivated",
    );
    expect(reactivated.length).toBeGreaterThan(0);
  });

  it("a role can name a billing site alongside a billing contact", async () => {
    const site = await sites.create({
      counterpartyId: acmeId,
      name: "Role Billing Site",
      siteKind: "billing",
    });
    const granted = await roles.grant({
      counterpartyId: acmeId,
      role: "customer",
      billingSiteId: site.id,
    });
    expect(granted.billingSiteId).toBe(site.id);

    // Clearing it back to null is a normal upsert field, same as billingContactId.
    const cleared = await roles.grant({
      counterpartyId: acmeId,
      role: "customer",
      billingSiteId: null,
    });
    expect(cleared.billingSiteId).toBeNull();
  });
});
