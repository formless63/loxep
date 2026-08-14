/**
 * Default subject-registry probe behavior (loxep-ovj.1): the design's
 * "unreachable from Loxep" (`'unknown'`) vs "failing" distinction, exercised
 * per subject type with an injected `HealthFetch` double — no real network
 * I/O anywhere in this file.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import {
  connections,
  externalResources,
  notificationEndpoints,
  storageBackends,
} from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import { createDefaultHealthSubjectRegistry } from "../src/index.ts";
import type { HealthFetch, HealthSubjectRegistry } from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

function fetchStub(
  handler: (url: string) => { ok: boolean; status: number; body: string } | "network-error",
): HealthFetch {
  return async (url) => {
    const result = handler(url);
    if (result === "network-error") throw new Error("simulated network failure");
    return { ok: result.ok, status: result.status, text: async () => result.body };
  };
}

describe("default health subject registry", () => {
  const dbName = scratchDbName("loxep_test_domain_health_default_probes");
  let handle: DbHandle;
  let tmpRoot: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    tmpRoot = await mkdtemp(join(tmpdir(), "loxep-health-probe-"));
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("connection", () => {
    it("reports 'unknown' for a connection that has never succeeded or errored", async () => {
      const registry = createDefaultHealthSubjectRegistry();
      const [row] = await handle.db
        .insert(connections)
        .values({ provider: "ebay", kind: "seller", name: "Never synced", status: "active" })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const outcome = await registry.connection?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail?.["kind"]).toBe("never_succeeded");
    });

    it("reports 'ok' once a success is recorded", async () => {
      const registry = createDefaultHealthSubjectRegistry();
      const [row] = await handle.db
        .insert(connections)
        .values({
          provider: "ebay",
          kind: "seller",
          name: "Healthy",
          status: "active",
          lastSuccessAt: new Date(),
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const outcome = await registry.connection?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("ok");
    });

    it("returns null for a deleted subject so the sweep clears its row", async () => {
      const registry = createDefaultHealthSubjectRegistry();
      const outcome = await registry.connection?.probe(
        handle.db,
        "00000000-0000-4000-8000-0000000000ff",
      );
      expect(outcome).toBeNull();
    });
  });

  describe("notification_endpoint (ntfy)", () => {
    async function makeEndpoint(baseUrl: string) {
      const [row] = await handle.db
        .insert(notificationEndpoints)
        .values({
          provider: "ntfy",
          name: "Health probe fixture",
          enabled: true,
          config: { baseUrl, topic: "loxep-test" },
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      return row;
    }

    it("reports 'ok' when /v1/health responds healthy", async () => {
      const endpoint = await makeEndpoint("https://ntfy.example.test");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub((url) => {
          expect(url).toBe("https://ntfy.example.test/v1/health");
          return { ok: true, status: 200, body: JSON.stringify({ healthy: true }) };
        }),
      });
      const outcome = await registry.notification_endpoint?.probe(handle.db, endpoint.id);
      expect(outcome?.status).toBe("ok");
    });

    it("reports 'failing' on an explicit unhealthy body, not 'unknown'", async () => {
      const endpoint = await makeEndpoint("https://ntfy.example.test");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => ({
          ok: true,
          status: 200,
          body: JSON.stringify({ healthy: false }),
        })),
      });
      const outcome = await registry.notification_endpoint?.probe(handle.db, endpoint.id);
      expect(outcome?.status).toBe("failing");
    });

    it("reports 'failing' on a definite HTTP error response", async () => {
      const endpoint = await makeEndpoint("https://ntfy.example.test");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => ({ ok: false, status: 503, body: "" })),
      });
      const outcome = await registry.notification_endpoint?.probe(handle.db, endpoint.id);
      expect(outcome?.status).toBe("failing");
    });

    it("reports 'unknown' — not 'failing' — on a network-level failure", async () => {
      const endpoint = await makeEndpoint("https://unreachable.example.test");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => "network-error"),
      });
      const outcome = await registry.notification_endpoint?.probe(handle.db, endpoint.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail?.["kind"]).toBe("unreachable");
    });

    it("never sends an Authorization header or any token in the probe request", async () => {
      const endpoint = await makeEndpoint("https://ntfy.example.test");
      let capturedInit: unknown;
      const fetchImpl: HealthFetch = async (url, init) => {
        capturedInit = init;
        return { ok: true, status: 200, text: async () => JSON.stringify({ healthy: true }) };
      };
      const registry = createDefaultHealthSubjectRegistry({ fetchImpl });
      await registry.notification_endpoint?.probe(handle.db, endpoint.id);
      expect(capturedInit).not.toHaveProperty("headers");
    });
  });

  describe("storage_backend", () => {
    it("local: reports 'ok' when rootDir exists and is a directory", async () => {
      const [row] = await handle.db
        .insert(storageBackends)
        .values({
          name: "Local fixture",
          driver: "local",
          enabled: true,
          config: { rootDir: tmpRoot },
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const registry = createDefaultHealthSubjectRegistry();
      const outcome = await registry.storage_backend?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("ok");
    });

    it("local: reports 'failing' — not 'unknown' — for a missing directory", async () => {
      const [row] = await handle.db
        .insert(storageBackends)
        .values({
          name: "Local fixture missing",
          driver: "local",
          enabled: true,
          config: { rootDir: join(tmpRoot, "does-not-exist") },
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const registry = createDefaultHealthSubjectRegistry();
      const outcome = await registry.storage_backend?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail?.["kind"]).toBe("fs_error");
    });

    it("s3: reports 'ok' on any HTTP response, without sending credentials", async () => {
      const [row] = await handle.db
        .insert(storageBackends)
        .values({
          name: "S3 fixture",
          driver: "s3",
          enabled: true,
          config: {
            endpoint: "https://s3.example.test",
            region: "us-east-1",
            bucket: "loxep",
            forcePathStyle: true,
          },
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const registry = createDefaultHealthSubjectRegistry({
        // A 403 is still a response — reachability, not authorization, is
        // what this probe answers.
        fetchImpl: fetchStub(() => ({ ok: false, status: 403, body: "" })),
      });
      const outcome = await registry.storage_backend?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("ok");
    });

    it("s3: reports 'unknown' on a network-level failure", async () => {
      const [row] = await handle.db
        .insert(storageBackends)
        .values({
          name: "S3 fixture unreachable",
          driver: "s3",
          enabled: true,
          config: {
            endpoint: "https://unreachable.example.test",
            region: "us-east-1",
            bucket: "loxep",
            forcePathStyle: true,
          },
        })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      const registry: HealthSubjectRegistry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => "network-error"),
      });
      const outcome = await registry.storage_backend?.probe(handle.db, row.id);
      expect(outcome?.status).toBe("unknown");
    });
  });

  describe("external_resource (loxep-ovj.3 — tier-2 companion-link reachability)", () => {
    async function makeLink(provider: string, url: string) {
      const [row] = await handle.db
        .insert(externalResources)
        .values({ provider, externalType: "fixture", url })
        .returning();
      if (row === undefined) throw new Error("fixture insert failed");
      return row;
    }

    it("only lists candidates for providers the registry marks tier-2-probeable", async () => {
      const beszel = await makeLink("beszel", "https://beszel.example.test/system/abc");
      const tailscale = await makeLink("tailscale", "https://api.tailscale.com/device/xyz");
      const registry = createDefaultHealthSubjectRegistry();
      const candidates = await registry.external_resource?.listCandidates(handle.db);
      const ids = candidates?.map((candidate) => candidate.subjectId) ?? [];
      expect(ids).toContain(beszel.id);
      expect(ids).not.toContain(tailscale.id);
    });

    it("probes the link's URL ORIGIN plus the registry's health path, unauthenticated", async () => {
      const link = await makeLink("gatus", "https://gatus.example.test/endpoints/some-key");
      let capturedUrl: string | undefined;
      let capturedInit: unknown;
      const fetchImpl: HealthFetch = async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return { ok: true, status: 200, text: async () => "OK" };
      };
      const registry = createDefaultHealthSubjectRegistry({ fetchImpl });
      const outcome = await registry.external_resource?.probe(handle.db, link.id);
      expect(capturedUrl).toBe("https://gatus.example.test/health");
      expect(capturedInit).not.toHaveProperty("headers");
      expect(outcome?.status).toBe("ok");
    });

    it("reports 'failing' on a definite HTTP error response", async () => {
      const link = await makeLink("beszel", "https://beszel.example.test/system/def");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => ({ ok: false, status: 502, body: "" })),
      });
      const outcome = await registry.external_resource?.probe(handle.db, link.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail?.["kind"]).toBe("http_error");
    });

    it("reports 'unknown' — not 'failing' — on a network-level failure", async () => {
      const link = await makeLink("dockhand", "https://dockhand.example.test/env/1");
      const registry = createDefaultHealthSubjectRegistry({
        fetchImpl: fetchStub(() => "network-error"),
      });
      const outcome = await registry.external_resource?.probe(handle.db, link.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail?.["kind"]).toBe("unreachable");
    });

    it("returns null for a deleted subject so the sweep clears its row", async () => {
      const registry = createDefaultHealthSubjectRegistry();
      const outcome = await registry.external_resource?.probe(
        handle.db,
        "00000000-0000-4000-8000-0000000000fe",
      );
      expect(outcome).toBeNull();
    });
  });
});
