/**
 * `container-hosts.ts` against real PostgreSQL: `declareIntent` (the
 * request-scoped write + transactional enqueue), `reconcile` (the whole
 * `infrastructure.reconcile-container-host` read -> diff -> apply -> record
 * flow, including the self-retiring identity write-back and the
 * `provider_operations` create guard's read-back branch), and
 * `listDeclaredTargets` (Milestone D's drift-cadence subject list).
 *
 * `applyHost` is never exercised against a real Dockhand instance anywhere in
 * this repo — see hb7's own LIVE note. Every test here drives a stub
 * `ContainerHostProviderPort`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createSettingsService, providerWritePolicySetting } from "@loxep/domain";
import {
  InfrastructureValidationError,
  ProviderCallError,
  RECONCILE_CONTAINER_HOST_TASK,
  containerHostJobKey,
  containerHostSecretKey,
  createContainerHostsService,
  createRecordingEnqueue,
} from "../src/index.ts";
import type {
  ContainerHostApplyResult,
  ContainerHostOperation,
  ContainerHostProviderCapabilities,
  ContainerHostProviderPort,
  ContainerHostSecretPayload,
  ContainerHostSecretReader,
  ContainerHostsService,
  ObservedContainerHost,
  TransactionalContainerHostSecretWriter,
} from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_container_hosts");
let handle: DbHandle;
let dockhandConnectionId = "";
/** A second Dockhand connection left at the default `read_only` write-policy tier — the write-authorization gate tests' subject. */
let readOnlyDockhandConnectionId = "";

async function insertDockhandConnection(name: string): Promise<string> {
  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('dockhand', 'fleet_observability', $1, 'active', '{"dockhand":{"baseUrl":"https://dockhand.test"}}')
     returning id`,
    [name],
  );
  const id = connection.rows[0]?.id;
  if (id === undefined) throw new Error("connection insert returned no row");
  return id;
}

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  dockhandConnectionId = await insertDockhandConnection("Dockhand (test)");
  readOnlyDockhandConnectionId = await insertDockhandConnection("Dockhand (read-only, test)");

  // Every test in this file EXCEPT the "write-authorization gate" describe
  // block below predates the gate and expects an apply to just work — set
  // this connection's policy permissive ONCE so those tests need no change.
  // The gate's own tests use `readOnlyDockhandConnectionId`, deliberately
  // left at the default `read_only` tier.
  const settings = createSettingsService({ db: handle.db });
  await settings.set(providerWritePolicySetting, { [dockhandConnectionId]: "additive" }, {});
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function insertHostingTarget(
  options: { name?: string; decommissioned?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const n = options.name ?? nextName("target");
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, decommissioned_at)
     values ($1, 'direct_reverse_proxy', $2)
     returning id`,
    [n, options.decommissioned === true ? new Date() : null],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("hosting target insert returned no row");
  return { id, name: n };
}

async function readExternalResource(
  externalResourceId: string,
): Promise<{ externalId: string | null; metadata: Record<string, unknown> }> {
  const result = await handle.pool.query<{ external_id: string | null; metadata: unknown }>(
    `select external_id, metadata from external_resources where id = $1`,
    [externalResourceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("external_resources row not found");
  return { externalId: row.external_id, metadata: row.metadata as Record<string, unknown> };
}

async function providerOperationRow(
  key: string,
): Promise<{ status: string; attempts: number } | null> {
  const result = await handle.pool.query<{ status: string; attempts: number }>(
    `select status, attempts from provider_operations where idempotency_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

class StubContainerHostProviderError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

interface StubProviderOptions {
  observed?: ObservedContainerHost[];
  failReadOnce?: { kind: string; message: string };
  failApplyOnce?: { kind: string; message: string };
  applyResultExternalHostId?: string;
  /**
   * Returned starting from the SECOND `read()` call only, replacing
   * `observed`/whatever `apply()` has since synthesized — the seam the
   * "stuck-pending create, resolved by read-back" tests use to simulate a
   * provider where the FIRST read (the plan's own diff) still shows nothing,
   * but a FRESH read (the ledger's read-back branch) now shows the host a
   * crashed prior attempt actually created — the scenario `provider_operations`
   * exists for.
   */
  fromSecondReadOn?: ObservedContainerHost[];
}

function createStubProvider(options: StubProviderOptions = {}): ContainerHostProviderPort & {
  readonly applyCalls: readonly ContainerHostOperation[];
  readonly readCallCount: number;
} {
  let observedHosts = options.observed ?? [];
  const applyCalls: ContainerHostOperation[] = [];
  let readCallCount = 0;
  let failReadOnce = options.failReadOnce;
  let failApplyOnce = options.failApplyOnce;
  let created = 0;

  return {
    async read() {
      readCallCount += 1;
      if (failReadOnce !== undefined) {
        const failure = failReadOnce;
        failReadOnce = undefined;
        throw new StubContainerHostProviderError(failure.kind, failure.message);
      }
      if (readCallCount >= 2 && options.fromSecondReadOn !== undefined) {
        return options.fromSecondReadOn;
      }
      return observedHosts;
    },
    async apply(operation): Promise<ContainerHostApplyResult> {
      applyCalls.push(operation);
      if (failApplyOnce !== undefined) {
        const failure = failApplyOnce;
        failApplyOnce = undefined;
        throw new StubContainerHostProviderError(failure.kind, failure.message);
      }
      created += 1;
      // A REAL provider's next read reflects exactly what was just applied —
      // not a hardcoded stand-in — because several tests below depend on a
      // second reconcile finding NO further drift once a create/update has
      // landed (proving the identity write-back closes the loop, not just
      // that `apply` was called once).
      if (operation.kind === "create") {
        const externalHostId = options.applyResultExternalHostId ?? `stub-host-${created}`;
        const host = operation.host;
        observedHosts = [
          ...observedHosts.filter((h) => h.externalHostId !== externalHostId),
          {
            externalHostId,
            name: host.name,
            connectionType: host.connectionType,
            host: host.host ?? null,
            port: host.port ?? null,
            protocol: host.protocol ?? null,
            socketPath: host.socketPath ?? null,
            tlsConfigured: Boolean(host.tlsCa ?? host.tlsCert ?? host.tlsKey),
            tlsSkipVerify: host.tlsSkipVerify ?? null,
            labels: host.labels ?? [],
            publicIp: host.publicIp ?? null,
            hawserConfigured: Boolean(host.hawserToken),
            hawserLastSeen: null,
            updatedAt: null,
          },
        ];
        return { kind: "create", name: host.name, status: "applied", externalHostId };
      }
      const existing = observedHosts.find((h) => h.externalHostId === operation.externalHostId);
      const merged: ObservedContainerHost = {
        externalHostId: operation.externalHostId,
        name: operation.host.name ?? existing?.name ?? "unknown",
        connectionType: operation.host.connectionType ?? existing?.connectionType ?? "direct",
        host: operation.host.host !== undefined ? (operation.host.host ?? null) : (existing?.host ?? null),
        port: operation.host.port !== undefined ? (operation.host.port ?? null) : (existing?.port ?? null),
        protocol:
          operation.host.protocol !== undefined
            ? (operation.host.protocol ?? null)
            : (existing?.protocol ?? null),
        socketPath:
          operation.host.socketPath !== undefined
            ? (operation.host.socketPath ?? null)
            : (existing?.socketPath ?? null),
        tlsConfigured: existing?.tlsConfigured ?? false,
        tlsSkipVerify:
          operation.host.tlsSkipVerify !== undefined
            ? (operation.host.tlsSkipVerify ?? null)
            : (existing?.tlsSkipVerify ?? null),
        labels: operation.host.labels ?? existing?.labels ?? [],
        publicIp:
          operation.host.publicIp !== undefined
            ? (operation.host.publicIp ?? null)
            : (existing?.publicIp ?? null),
        hawserConfigured: existing?.hawserConfigured ?? false,
        hawserLastSeen: existing?.hawserLastSeen ?? null,
        updatedAt: null,
      };
      observedHosts = [
        ...observedHosts.filter((h) => h.externalHostId !== operation.externalHostId),
        merged,
      ];
      return {
        kind: "update",
        name: merged.name,
        status: "applied",
        externalHostId: operation.externalHostId,
      };
    },
    capabilities(): ContainerHostProviderCapabilities {
      return {
        provider: "dockhand",
        hostRegistration: true,
        containerLifecycle: false,
        metricHistory: false,
        bearerTokenAuth: false,
        connectionTypes: ["socket", "direct", "hawser-standard", "hawser-edge"],
      };
    },
    get applyCalls() {
      return applyCalls;
    },
    get readCallCount() {
      return readCallCount;
    },
  };
}

function createRecordingSecretReader(
  material: Record<string, ContainerHostSecretPayload | undefined> = {},
): ContainerHostSecretReader & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const reader = (async (secretKey: string) => {
    calls.push(secretKey);
    const found = material[secretKey];
    if (found === undefined) throw new Error(`no secret stored for ${secretKey}`);
    return found;
  }) as ContainerHostSecretReader & { calls: string[] };
  Object.defineProperty(reader, "calls", { value: calls, enumerable: true });
  return reader;
}

function createRecordingSecretWriter(): TransactionalContainerHostSecretWriter & {
  readonly writes: readonly { secretKey: string; payload: ContainerHostSecretPayload }[];
} {
  const writes: { secretKey: string; payload: ContainerHostSecretPayload }[] = [];
  const writer = (async (_tx, input) => {
    writes.push({ secretKey: input.secretKey, payload: input.payload });
    return { id: input.secretKey };
  }) as TransactionalContainerHostSecretWriter & {
    writes: { secretKey: string; payload: ContainerHostSecretPayload }[];
  };
  Object.defineProperty(writer, "writes", { value: writes, enumerable: true });
  return writer;
}

/** Keeps only scalar fields — every `reconcile()` call below injects this as its required `redact`. */
function scalarRedactor(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return { value: null };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
}

function service(options: { secrets?: ContainerHostSecretReader }): {
  svc: ContainerHostsService;
  writer: ReturnType<typeof createRecordingSecretWriter>;
  enqueue: ReturnType<typeof createRecordingEnqueue>;
} {
  const writer = createRecordingSecretWriter();
  const enqueue = createRecordingEnqueue();
  const svc = createContainerHostsService({
    db: handle.db,
    writeSecret: writer,
    readSecret: options.secrets ?? createRecordingSecretReader(),
    enqueue,
  });
  return { svc, writer, enqueue };
}

describe("declareIntent", () => {
  it("writes a fresh link with no externalId yet, and enqueues an apply/intent_change run", async () => {
    const target = await insertHostingTarget();
    const { svc, enqueue } = service({});

    const result = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
      socketPath: "/var/run/docker.sock",
    });

    const row = await readExternalResource(result.externalResourceId);
    expect(row.externalId).toBeNull();
    expect(row.metadata["connectionType"]).toBe("socket");
    expect(row.metadata["desiredAt"]).toBeTypeOf("string");

    expect(result.jobKey).toBe(
      containerHostJobKey(RECONCILE_CONTAINER_HOST_TASK, target.id),
    );
    expect(enqueue.calls).toEqual([
      {
        taskName: RECONCILE_CONTAINER_HOST_TASK,
        payload: { hostingTargetId: target.id, mode: "apply", trigger: "intent_change" },
        jobKey: result.jobKey,
      },
    ]);
  });

  it("writes secret material only when the operator supplied some", async () => {
    const target = await insertHostingTarget();
    const { svc, writer } = service({});

    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "direct",
      host: "10.0.0.5",
    });
    expect(writer.writes).toEqual([]);

    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "direct",
      host: "10.0.0.5",
      tlsKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    });
    expect(writer.writes).toEqual([
      {
        secretKey: containerHostSecretKey(target.id),
        payload: { tlsKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
      },
    ]);
  });

  it("edits the SAME row in place on a second call — never a duplicate link", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});

    const first = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const second = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "direct",
      host: "10.0.0.9",
    });

    expect(second.externalResourceId).toBe(first.externalResourceId);
    const row = await readExternalResource(first.externalResourceId);
    expect(row.metadata["connectionType"]).toBe("direct");
  });

  it("refuses to register a decommissioned target", async () => {
    const target = await insertHostingTarget({ decommissioned: true });
    const { svc } = service({});
    await expect(
      svc.declareIntent({
        hostingTargetId: target.id,
        connectionId: dockhandConnectionId,
        url: "https://dockhand.test",
        connectionType: "socket",
      }),
    ).rejects.toBeInstanceOf(InfrastructureValidationError);
  });
});

describe("reconcile — no declared intent", () => {
  it("skips a target with no dockhand host-intent link at all", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    const result = await svc.reconcile(target.id, {
      mode: "check",
      trigger: "manual",
      provider: createStubProvider(),
      redact: scalarRedactor,
    });
    expect(result).toEqual({
      runId: null,
      status: "skipped",
      mode: "check",
      operationCount: 0,
      applied: 0,
      unmatchedObservedCount: 0,
      writePolicyBlockedReason: null,
    });
  });

  it("skips a decommissioned target even with declared intent", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    await handle.pool.query(
      `update hosting_targets set decommissioned_at = now() where id = $1`,
      [target.id],
    );
    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider: createStubProvider(),
      redact: scalarRedactor,
    });
    expect(result.status).toBe("skipped");
  });
});

describe("reconcile create — the provider_operations guard", () => {
  it("creates a new host, ledgers it, and self-retires the externalHostId onto the link", async () => {
    const target = await insertHostingTarget();
    const secretKey = containerHostSecretKey(target.id);
    const secrets = createRecordingSecretReader({
      [secretKey]: { hawserToken: "should-not-apply-to-socket" },
    });
    const { svc } = service({ secrets });
    const declared = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
      socketPath: "/var/run/docker.sock",
    });

    const provider = createStubProvider({ observed: [] });
    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "intent_change",
      provider,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("succeeded");
    expect(result.applied).toBe(1);
    expect(provider.applyCalls).toHaveLength(1);
    expect(provider.applyCalls[0]?.kind).toBe("create");
    expect(secrets.calls).toContain(secretKey);
    if (provider.applyCalls[0]?.kind === "create") {
      expect(provider.applyCalls[0].host.hawserToken).toBe("should-not-apply-to-socket");
    }

    const row = await readExternalResource(declared.externalResourceId);
    expect(row.externalId).not.toBeNull();
    expect(row.metadata["lastAppliedAt"]).toBeTypeOf("string");

    const key = `dockhand:host.create:${target.id}`;
    const op = await providerOperationRow(key);
    expect(op?.status).toBe("succeeded");
  });

  it("does not double-create on a retried run — the identity has already self-retired", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const provider = createStubProvider({ observed: [] });

    await svc.reconcile(target.id, { mode: "apply", trigger: "intent_change", provider, redact: scalarRedactor });
    expect(provider.applyCalls).toHaveLength(1);

    const result = await svc.reconcile(target.id, { mode: "apply", trigger: "manual", provider, redact: scalarRedactor });
    expect(result.operationCount).toBe(0);
    expect(provider.applyCalls).toHaveLength(1);
  });

  it("resolves a stuck-pending create via read-back — the ledger's ideal, readable case", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const key = `dockhand:host.create:${target.id}`;
    await handle.pool.query(
      `insert into provider_operations (idempotency_key, provider, operation, status)
       values ($1, 'dockhand', 'host.create', 'pending')`,
      [key],
    );
    const provider = createStubProvider({
      // The FIRST read (the plan's own diff) shows nothing — as far as
      // Loxep's normal reconcile flow knows, this host does not exist yet,
      // which is exactly why the plan decides "create" and the ledger check
      // is reached at all.
      observed: [],
      // A FRESH read, taken only inside the ledger's `needs_read_back`
      // branch, reveals what a crashed prior attempt actually created.
      fromSecondReadOn: [
        {
          externalHostId: "already-created-host",
          name: target.name,
          connectionType: "socket",
          host: null,
          port: null,
          protocol: null,
          socketPath: "/var/run/docker.sock",
          tlsConfigured: false,
          tlsSkipVerify: null,
          labels: [],
          publicIp: null,
          hawserConfigured: false,
          hawserLastSeen: null,
          updatedAt: null,
        },
      ],
    });

    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("succeeded");
    expect(provider.applyCalls).toHaveLength(0);
    const op = await providerOperationRow(key);
    expect(op?.status).toBe("succeeded");
  });

  it("fails the pending row when the read-back finds nothing — safe to retry next run", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const key = `dockhand:host.create:${target.id}`;
    await handle.pool.query(
      `insert into provider_operations (idempotency_key, provider, operation, status)
       values ($1, 'dockhand', 'host.create', 'pending')`,
      [key],
    );
    const provider = createStubProvider({ observed: [] });

    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      redact: scalarRedactor,
    });
    expect(result.status).toBe("succeeded");
    expect(result.applied).toBe(0);
    const op = await providerOperationRow(key);
    expect(op?.status).toBe("failed");
  });
});

describe("reconcile update — convergent, no ledger row", () => {
  it("applies field drift without touching provider_operations", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    const declared = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "direct",
      host: "10.0.0.9",
      port: 2376,
      protocol: "https",
    });
    // Simulate an already-registered host: write the externalId directly,
    // the same way a prior successful reconcile would have.
    await handle.pool.query(
      `update external_resources set external_id = 'existing-host-1' where id = $1`,
      [declared.externalResourceId],
    );

    const provider = createStubProvider({
      observed: [
        {
          externalHostId: "existing-host-1",
          name: target.name,
          connectionType: "direct",
          host: "10.0.0.1",
          port: 2376,
          protocol: "https",
          socketPath: null,
          tlsConfigured: false,
          tlsSkipVerify: null,
          labels: [],
          publicIp: null,
          hawserConfigured: false,
          hawserLastSeen: null,
          updatedAt: null,
        },
      ],
    });

    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      redact: scalarRedactor,
    });
    expect(result.applied).toBe(1);
    expect(provider.applyCalls[0]?.kind).toBe("update");
    const op = await providerOperationRow(`dockhand:host.update:${target.id}`);
    expect(op).toBeNull();

    const row = await readExternalResource(declared.externalResourceId);
    expect(row.externalId).toBe("existing-host-1");
  });

  it("never resends secret material once already-registered, on a manual reconcile", async () => {
    const target = await insertHostingTarget();
    const secretKey = containerHostSecretKey(target.id);
    const secrets = createRecordingSecretReader({
      [secretKey]: { tlsKey: "SHOULD-NEVER-BE-READ-HERE" },
    });
    const { svc } = service({ secrets });
    const declared = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "direct",
      host: "10.0.0.9",
      port: 2376,
      publicIp: "203.0.113.20",
    });
    await handle.pool.query(
      `update external_resources set external_id = 'existing-host-2' where id = $1`,
      [declared.externalResourceId],
    );

    const provider = createStubProvider({
      observed: [
        {
          externalHostId: "existing-host-2",
          name: target.name,
          connectionType: "direct",
          host: "10.0.0.9",
          port: 2376,
          protocol: null,
          socketPath: null,
          tlsConfigured: true,
          tlsSkipVerify: null,
          labels: [],
          publicIp: null,
          hawserConfigured: false,
          hawserLastSeen: null,
          updatedAt: null,
        },
      ],
    });

    await svc.reconcile(target.id, { mode: "apply", trigger: "manual", provider, redact: scalarRedactor });

    expect(secrets.calls).toEqual([]);
    if (provider.applyCalls[0]?.kind === "update") {
      expect(JSON.stringify(provider.applyCalls[0].host)).not.toContain("tlsKey");
    }
  });
});

describe("check mode", () => {
  it("never applies, and never touches application secrets", async () => {
    const target = await insertHostingTarget();
    const secrets = createRecordingSecretReader();
    const { svc } = service({ secrets });
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const provider = createStubProvider({ observed: [] });

    const result = await svc.reconcile(target.id, { mode: "check", trigger: "poll", provider, redact: scalarRedactor });

    expect(result.status).toBe("succeeded");
    expect(provider.applyCalls).toHaveLength(0);
    expect(secrets.calls).toEqual([]);
  });

  it("self-retires the identity on a bootstrap NAME match even without applying", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    const declared = await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const provider = createStubProvider({
      observed: [
        {
          externalHostId: "matched-by-name",
          name: target.name,
          connectionType: "socket",
          host: null,
          port: null,
          protocol: null,
          socketPath: null,
          tlsConfigured: false,
          tlsSkipVerify: null,
          labels: [],
          publicIp: null,
          hawserConfigured: false,
          hawserLastSeen: null,
          updatedAt: null,
        },
      ],
    });

    const result = await svc.reconcile(target.id, { mode: "check", trigger: "poll", provider, redact: scalarRedactor });
    expect(result.operationCount).toBe(0);
    expect(result.applied).toBe(0);

    const row = await readExternalResource(declared.externalResourceId);
    expect(row.externalId).toBe("matched-by-name");
  });
});

describe("provider read failure", () => {
  it("records a failed run and throws a ProviderCallError", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const provider = createStubProvider({
      failReadOnce: { kind: "auth", message: "bad session" },
    });

    await expect(
      svc.reconcile(target.id, { mode: "check", trigger: "manual", provider, redact: scalarRedactor }),
    ).rejects.toBeInstanceOf(ProviderCallError);

    const runRow = await handle.pool.query<{ status: string }>(
      `select status from reconcile_runs where subject_type = 'hosting_target' and subject_id = $1 order by started_at desc limit 1`,
      [target.id],
    );
    expect(runRow.rows[0]?.status).toBe("failed");
  });
});

describe("listDeclaredTargets", () => {
  it("lists only targets with DECLARED intent — never a discovery-only auto-attach", async () => {
    const declaredTarget = await insertHostingTarget();
    const discoveryOnlyTarget = await insertHostingTarget();
    const { svc } = service({});

    await svc.declareIntent({
      hostingTargetId: declaredTarget.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    // A Milestone B discovery auto-attach: a link with NO `desired` metadata
    // at all, the shape `projectDockhandResources` writes.
    await handle.pool.query(
      `insert into external_resources (provider, external_type, external_id, connection_id, url, metadata)
       values ('dockhand', 'environment', 'discovery-only-1', $1, 'https://dockhand.test', '{"connectionType":"socket"}')`,
      [dockhandConnectionId],
    );
    const discoveryOnlyResource = await handle.pool.query<{ id: string }>(
      `select id from external_resources where external_id = 'discovery-only-1'`,
    );
    await handle.pool.query(
      `insert into resource_links (external_resource_id, resource_type, resource_id, purpose)
       values ($1, 'hosting_target', $2, 'container_console')`,
      [discoveryOnlyResource.rows[0]?.id, discoveryOnlyTarget.id],
    );

    const declared = await svc.listDeclaredTargets();
    const ids = declared.map((row) => row.hostingTargetId);
    expect(ids).toContain(declaredTarget.id);
    expect(ids).not.toContain(discoveryOnlyTarget.id);
  });

  it("excludes a decommissioned target even with declared intent", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    await handle.pool.query(
      `update hosting_targets set decommissioned_at = now() where id = $1`,
      [target.id],
    );

    const declared = await svc.listDeclaredTargets();
    expect(declared.map((row) => row.hostingTargetId)).not.toContain(target.id);
  });

  it("orders never-reconciled targets before ones with a run history", async () => {
    const older = await insertHostingTarget();
    const neverRun = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: older.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    await svc.declareIntent({
      hostingTargetId: neverRun.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    await svc.reconcile(older.id, {
      mode: "check",
      trigger: "manual",
      provider: createStubProvider({ observed: [] }),
      redact: scalarRedactor,
    });

    const declared = await svc.listDeclaredTargets();
    const orderedIds = declared.map((row) => row.hostingTargetId);
    expect(orderedIds.indexOf(neverRun.id)).toBeLessThan(orderedIds.indexOf(older.id));
  });
});

describe("listRuns", () => {
  it("returns this target's reconcile-container-host runs only", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: dockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    await svc.reconcile(target.id, {
      mode: "check",
      trigger: "manual",
      provider: createStubProvider({ observed: [] }),
      redact: scalarRedactor,
    });

    const runs = await svc.listRuns(target.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.subjectId === target.id)).toBe(true);
    expect(runs.every((run) => run.kind === "reconcile-container-host")).toBe(true);
  });
});

describe("the write-authorization gate (loxep-47o.10, joining Cloudflare/Purelymail/Pangolin)", () => {
  it("blocks a create when the connection's policy is the default read_only", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: readOnlyDockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });

    const provider = createStubProvider();
    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      actorIsAdmin: true,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("partial");
    expect(result.writePolicyBlockedReason).toBe("write_policy");
    expect(result.applied).toBe(0);
    expect(provider.applyCalls).toHaveLength(0);

    const steps = await handle.pool.query<{ step: string; status: string }>(
      `select step, status from reconcile_run_steps where run_id = $1 order by sequence`,
      [result.runId],
    );
    expect(
      steps.rows.some((row) => row.step === "apply.blocked" && row.status === "blocked"),
    ).toBe(true);

    const run = await handle.pool.query<{ status: string }>(
      `select status from reconcile_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.status).toBe("partial");
  });

  it("blocks an update the same way a create is blocked", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: readOnlyDockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
      socketPath: "/var/run/docker.sock",
    });
    // Already "registered" at the provider under a different socket path, so
    // the plan produces an UPDATE rather than a create.
    const provider = createStubProvider({
      observed: [
        {
          externalHostId: "already-there",
          name: target.name,
          connectionType: "socket",
          host: null,
          port: null,
          protocol: null,
          socketPath: "/var/run/docker-old.sock",
          tlsConfigured: false,
          tlsSkipVerify: null,
          labels: [],
          publicIp: null,
          hawserConfigured: false,
          hawserLastSeen: null,
          updatedAt: null,
        },
      ],
    });
    await svc.reconcile(target.id, {
      mode: "check",
      trigger: "manual",
      provider,
      redact: scalarRedactor,
    });

    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      actorIsAdmin: true,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("partial");
    expect(result.writePolicyBlockedReason).toBe("write_policy");
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("applies once the connection's policy is flipped to a non-read_only tier", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: readOnlyDockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });

    const settings = createSettingsService({ db: handle.db });
    await settings.set(
      providerWritePolicySetting,
      { [readOnlyDockhandConnectionId]: "additive" },
      {},
    );

    const provider = createStubProvider();
    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      actorIsAdmin: true,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("succeeded");
    expect(result.writePolicyBlockedReason).toBeNull();
    expect(result.applied).toBe(1);
    expect(provider.applyCalls).toHaveLength(1);
  });

  it("check mode is never gated, even at the default read_only policy", async () => {
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: readOnlyDockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });

    const provider = createStubProvider();
    const result = await svc.reconcile(target.id, {
      mode: "check",
      trigger: "manual",
      provider,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("succeeded");
    expect(result.writePolicyBlockedReason).toBeNull();
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("a poll trigger may still apply this tier-1 write once the tier allows it — no rule-3 refusal", async () => {
    // Rule 3 (write-policy.ts) forbids a sweep/poll trigger from applying a
    // tier >= 2 write, unconditionally. Dockhand's host create/update is
    // tier 1 (additive) — structurally permitted from `poll`, matching the
    // module doc's note that this is the deliberate seam a future dynamic-IP
    // auto-apply is expected to use.
    const target = await insertHostingTarget();
    const { svc } = service({});
    await svc.declareIntent({
      hostingTargetId: target.id,
      connectionId: readOnlyDockhandConnectionId,
      url: "https://dockhand.test",
      connectionType: "socket",
    });
    const settings = createSettingsService({ db: handle.db });
    await settings.set(
      providerWritePolicySetting,
      { [readOnlyDockhandConnectionId]: "additive" },
      {},
    );

    const provider = createStubProvider();
    const result = await svc.reconcile(target.id, {
      mode: "apply",
      trigger: "poll",
      provider,
      redact: scalarRedactor,
    });

    expect(result.status).toBe("succeeded");
    expect(result.writePolicyBlockedReason).toBeNull();
    expect(provider.applyCalls).toHaveLength(1);
  });
});
