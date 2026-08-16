/**
 * Infrastructure MAIL composition-root wiring (Phase 7 milestone 2,
 * loxep-lmy.2) through the REAL Graphile Worker runtime and the REAL composed
 * registry:
 *
 * ```text
 * infrastructure.ensure-mail-domain job
 *   -> the composed task registry -> @loxep/app's mail branch
 *   -> resolve the MAIL connection from mail_domains (never from the payload)
 *   -> the Purelymail adapter, wrapped as a MailProviderPort
 *   -> @loxep/infrastructure createMailSyncService(...).runMailDomainSync(...)
 * ```
 *
 * The ONLY mock is the provider: `services.getPurelymailAdapterForConnection`
 * is replaced with a stub at the `MailProviderPort` boundary — the same "only
 * the touched surface" discipline `infrastructure-poll-executor.test.ts` uses
 * for Cloudflare. PostgreSQL, the real reconciler, the real secrets service
 * (real AES-256-GCM against a real keyring), and the real worker are all the
 * real thing.
 *
 * What this file proves, and why each item earns a place here rather than in
 * `packages/infrastructure`'s own suite:
 *
 * 1. **The three mail tasks are actually registered.** A task that exists and
 *    is never registered is the exact gap milestone 1 shipped with and had to
 *    close afterwards; this asserts it against the composed registry.
 * 2. **There is deliberately NO fourth monitor target type.** Ownership
 *    verification is a bounded, self-terminating poll, which the design
 *    classifies as *not* scheduling. Asserted so that a future reader who goes
 *    looking for the route finds a test explaining its absence.
 * 3. **The structural port re-declaration still matches the adapter.**
 *    `mail-port.ts` promises this is "guarded by a compile-time assignability
 *    test in the composition root's suite"; this file is that suite.
 * 4. **The delegation gate holds end to end**, through the real job, and
 *    spends zero provider calls while it does.
 * 5. **A minted mailbox password never reaches a job payload**, asserted
 *    against the real `graphile_worker.jobs` table rather than a recorder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { addJob, startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { MONITOR_TARGET_TYPES } from "@loxep/market";
import { providerWritePolicySetting } from "@loxep/domain";
import {
  ENSURE_MAIL_DOMAIN_TASK,
  POLL_MAIL_OWNERSHIP_TASK,
  SYNC_MAILBOXES_TASK,
  createMailDomainsService,
  createMailboxTemplatesService,
  createManagedDomainsService,
} from "@loxep/infrastructure";
import type {
  MailDomainsService,
  MailProviderPort,
  MailboxTemplatesService,
  ManagedDomainsService,
} from "@loxep/infrastructure";
import { createPurelymailAdapter } from "@loxep/integration-purelymail";
import {
  createInfrastructureMailTasks,
  mailProviderPortFromPurelymailAdapter,
  purelymailResultRedactor,
} from "../src/infrastructure-mail.ts";
import {
  PURELYMAIL_CREDENTIAL_TYPE,
  PurelymailCredentialsMissingError,
  createPurelymailAdapterFactory,
} from "../src/purelymail.ts";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";

/* ------------------------------------------------- the one provider mock */

interface FakeMailState {
  ownershipCode: string;
  /** Domains the provider has accepted, by name. */
  domains: Map<
    string,
    {
      passesMx: boolean;
      passesSpf: boolean;
      passesDkim: boolean;
      passesDmarc: boolean;
    }
  >;
  users: Set<string>;
  /** Set to make `addDomain` reject, simulating an unresolvable ownership TXT. */
  refuseAddDomainWith: { kind: string; message: string } | null;
  calls: {
    getOwnershipCode: number;
    addDomain: number;
    findDomainByName: number;
    createUser: number;
    recheckDomainDns: number;
  };
}

function fakeMailState(): FakeMailState {
  return {
    ownershipCode: "purelymail-ownership-code-FAKE",
    domains: new Map(),
    users: new Set(),
    refuseAddDomainWith: null,
    calls: {
      getOwnershipCode: 0,
      addDomain: 0,
      findDomainByName: 0,
      createUser: 0,
      recheckDomainDns: 0,
    },
  };
}

/**
 * A stub at the `MailProviderPort` boundary. It records the password it was
 * given ONLY so the containment test can prove that value never reached a job
 * payload — nothing in production has an equivalent.
 */
function fakeMailProvider(
  state: FakeMailState,
  sink: { passwords: string[] },
): MailProviderPort {
  return {
    async getOwnershipCode() {
      state.calls.getOwnershipCode += 1;
      return state.ownershipCode;
    },
    async addDomain(name) {
      state.calls.addDomain += 1;
      if (state.refuseAddDomainWith !== null) {
        const error = new Error(state.refuseAddDomainWith.message) as Error & {
          kind: string;
        };
        error.kind = state.refuseAddDomainWith.kind;
        throw error;
      }
      state.domains.set(name, {
        passesMx: true,
        passesSpf: true,
        passesDkim: true,
        passesDmarc: true,
      });
    },
    async findDomainByName(name) {
      state.calls.findDomainByName += 1;
      const dns = state.domains.get(name);
      if (dns === undefined) return null;
      return { name, allowAccountReset: false, isShared: false, dns };
    },
    async recheckDomainDns() {
      state.calls.recheckDomainDns += 1;
    },
    async createUser(input) {
      state.calls.createUser += 1;
      sink.passwords.push(input.password);
      state.users.add(`${input.userName}@${input.domainName}`);
    },
    async deleteUser(fullAddress) {
      state.users.delete(fullAddress);
    },
    async listUsers() {
      return [...state.users];
    },
    async listRoutingRules() {
      return [];
    },
    async createRoutingRule() {},
    async deleteRoutingRule() {},
    requiredRecords() {
      return [];
    },
    capabilities() {
      return {
        provider: "purelymail",
        routingRules: true,
        catchAll: true,
        suppliesMailboxPassword: false,
        ownershipCodeScope: "account",
        maxListedUsers: 1000,
        requiredRecordCount: 7,
      };
    },
  };
}

const dbName = scratchDbName("loxep_test_app_infra_mail");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let domains: ManagedDomainsService;
let mail: MailDomainsService;
let templates: MailboxTemplatesService;
let mailConnectionId = "";
let dnsConnectionId = "";

const state = fakeMailState();
const passwordSink = { passwords: [] as string[] };
const invalidated: string[] = [];

/** The mail tasks, for `addJob`'s typed enqueue. The REGISTRY runs its own. */
let tasks: ReturnType<typeof createInfrastructureMailTasks>;

async function runsFor(
  domainId: string,
): Promise<Array<{ kind: string; status: string; trigger: string }>> {
  const rows = await handle.pool.query<{
    kind: string;
    status: string;
    trigger: string;
  }>(
    `select kind, status, trigger from reconcile_runs
      where subject_id = $1 and kind in ('sync-mail-domain', 'sync-mailboxes')
      order by started_at`,
    [domainId],
  );
  return rows.rows;
}

async function mailRow(domainId: string): Promise<{
  ownership_code: string | null;
  provider_added_at: Date | null;
  ownership_verified_at: Date | null;
  verify_attempts: number;
  last_verify_error: string | null;
}> {
  const rows = await handle.pool.query<{
    ownership_code: string | null;
    provider_added_at: Date | null;
    ownership_verified_at: Date | null;
    verify_attempts: number;
    last_verify_error: string | null;
  }>(
    `select ownership_code, provider_added_at, ownership_verified_at,
            verify_attempts, last_verify_error
       from mail_domains where domain_id = $1`,
    [domainId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no mail_domains row");
  return row;
}

/** A domain whose registrar delegation is NOT yet confirmed. */
async function undelegatedDomain(name: string): Promise<string> {
  const row = await domains.create({ name, dnsConnectionId });
  await handle.pool.query(
    `update managed_domains
        set external_zone_id = $2, state = 'zone_created',
            provider_zone_status = 'pending'
      where id = $1`,
    [row.id, `zone-${row.id}`],
  );
  await mail.enableMail(row.id, { mailConnectionId });
  return row.id;
}

async function confirmDelegation(domainId: string): Promise<void> {
  await handle.pool.query(
    `update managed_domains
        set provider_zone_status = 'active', delegation_verified_at = now(),
            state = 'zone_active'
      where id = $1`,
    [domainId],
  );
}

async function runEnsure(domainId: string): Promise<void> {
  const before = (await runsFor(domainId)).length;
  await addJob(handle.pool, tasks.ensureMailDomainTask, { domainId });
  await waitFor(
    async () => {
      const rows = await runsFor(domainId);
      return rows.length > before ? rows : undefined;
    },
    { timeoutMs: 30_000, label: `ensure-mail-domain run for ${domainId}` },
  );
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  const provider = fakeMailProvider(state, passwordSink);
  services = {
    ...real,
    getPurelymailAdapterForConnection: async (id) => ({
      connectionId: id,
      sourceAccountKey: "purelymail:purelymail.test",
      // The stub stands in for the ADAPTER; the executor wraps whatever it is
      // given in `mailProviderPortFromPurelymailAdapter`, so the stub is
      // shaped as the port and cast at this one seam.
      adapter: provider as never,
      minIntervalSeconds: 3600,
    }),
    invalidatePurelymailAdapter: (id) => {
      invalidated.push(id);
    },
  };

  composition = buildWorkerRegistry({
    config,
    services,
    logger: silentJobsLogger,
  });
  tasks = createInfrastructureMailTasks({ services });

  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: composition.registry,
    cronItems: [],
  });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "infra-mail@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const dns = await services.connections.createConnection({
    provider: "cloudflare",
    kind: "dns",
    name: "test Cloudflare account",
    config: { cloudflare: { accountId: "acct_test" } },
    createdByUserId: "test-user",
  });
  dnsConnectionId = dns.id;

  const mailConnection = await services.connections.createConnection({
    provider: "purelymail",
    kind: "mail",
    name: "test Purelymail account",
    // No config block at all: Purelymail exposes no account identifier, so
    // there is genuinely nothing non-secret to store. See purelymail.ts.
    config: {},
    createdByUserId: "test-user",
  });
  mailConnectionId = mailConnection.id;

  // Write-authorization gate (Pangolin chain design M3, loxep-acj.3): this
  // connection defaults to read_only, and this suite tests the delegation/
  // provisioning FLOW, not the gate itself (write-policy.ts and
  // mail-sync.test.ts's own "write-authorization gate" describe block own
  // that). Flip it once, admin-equivalent, so every test below exercises the
  // flow exactly as it did before the gate existed.
  await services.settings.set(
    providerWritePolicySetting,
    { [mailConnectionId]: "additive" },
    {},
  );

  domains = createManagedDomainsService({ db: handle.db });
  mail = createMailDomainsService({ db: handle.db });
  templates = createMailboxTemplatesService({ db: handle.db });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("mail task registration", () => {
  it("registers all three mail tasks in the COMPOSED registry", () => {
    // Milestone 1 shipped an executor that was not routed and had to be fixed
    // afterwards. This is the assertion that would have caught it.
    expect(composition.registry.has(ENSURE_MAIL_DOMAIN_TASK)).toBe(true);
    expect(composition.registry.has(POLL_MAIL_OWNERSHIP_TASK)).toBe(true);
    expect(composition.registry.has(SYNC_MAILBOXES_TASK)).toBe(true);
  });

  it("adds NO fourth monitor target type — ownership verification is a bounded poll", () => {
    // The design's "Where recurring cadence lives" section puts ownership
    // verification in the `bounded poll` row and states that row is NOT
    // scheduling. A `monitor_targets` row is a permanent cadence, and this
    // work ends the moment the domain verifies — it would leave a dead row per
    // domain forever. Asserted so the absence reads as a decision.
    expect(MONITOR_TARGET_TYPES).not.toContain("infrastructure_mail_verify");
    expect(
      MONITOR_TARGET_TYPES.filter((type) => type.includes("mail")),
    ).toEqual([]);
  });

  it("names the tasks exactly as the design's job graph does", () => {
    expect(ENSURE_MAIL_DOMAIN_TASK).toBe("infrastructure.ensure-mail-domain");
    expect(POLL_MAIL_OWNERSHIP_TASK).toBe("infrastructure.poll-mail-ownership");
    expect(SYNC_MAILBOXES_TASK).toBe("infrastructure.sync-mailboxes");
  });
});

describe("the structural port re-declaration", () => {
  it("accepts a REAL PurelymailAdapter where a MailProviderPort is required", () => {
    // The compile-time half of the guarantee `mail-port.ts` promises: if the
    // adapter and the re-declared port ever drift, THIS LINE stops compiling,
    // and a test failure is a much better messenger than a production sync.
    const adapter = createPurelymailAdapter({
      apiToken: "fake-purelymail-token-for-assignability-only",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const port: MailProviderPort =
      mailProviderPortFromPurelymailAdapter(adapter);
    expect(typeof port.addDomain).toBe("function");
    expect(typeof port.findDomainByName).toBe("function");
    expect(typeof port.createUser).toBe("function");
    expect(typeof port.requiredRecords).toBe("function");
  });

  it("forwards through explicit method calls, so adapter `this` survives", () => {
    // `findDomainByName` calls `listDomains` internally. A destructured
    // forward would lose the binding and fail only at runtime, in production,
    // on the read-back path that exists to prevent a duplicate create.
    const adapter = createPurelymailAdapter({
      apiToken: "fake-purelymail-token-for-binding-check",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ type: "success", result: { domains: [] } }),
          { status: 200 },
        ),
    });
    const port = mailProviderPortFromPurelymailAdapter(adapter);
    return expect(port.findDomainByName("example.test")).resolves.toBeNull();
  });

  it("redacts to an allow-list that has no password shape at all", () => {
    const summary = purelymailResultRedactor({
      localPart: "postmaster",
      created: true,
      password: "PASSWORD-MARKER-SHOULD-NOT-SURVIVE",
      secret: "also-not-this",
    });
    expect(JSON.stringify(summary)).not.toContain("PASSWORD-MARKER");
    expect(JSON.stringify(summary)).not.toContain("also-not-this");
    expect(summary["localPart"]).toBe("postmaster");
    expect(summary["passwordOmitted"]).toBe(true);
  });
});

describe("the delegation gate, end to end through the real job", () => {
  it("waits without spending a single provider call, and records that as SUCCESS", async () => {
    const domainId = await undelegatedDomain("gate-a.test");
    const addBefore = state.calls.addDomain;

    await runEnsure(domainId);

    const runs = await runsFor(domainId);
    expect(runs.at(-1)).toMatchObject({
      kind: "sync-mail-domain",
      // Correctly waiting for a registrar is not a failure. Recording it as
      // one would light up every health indicator in the product for an
      // entirely normal condition that lasts days.
      status: "succeeded",
      trigger: "intent_change",
    });
    expect(state.calls.addDomain).toBe(addBefore);

    const row = await mailRow(domainId);
    // The ownership code IS fetched before the gate — it is an account-level
    // read at the MAIL provider, and its TXT record has to be published and
    // propagating before delegation completes for the rest to be quick.
    expect(row.ownership_code).toBe(state.ownershipCode);
    expect(row.provider_added_at).toBeNull();
    // No attempt was made, so none is counted.
    expect(row.verify_attempts).toBe(0);
  });

  it("resumes and completes once the registrar delegation lands", async () => {
    const domainId = await undelegatedDomain("gate-b.test");

    // Run 1: gated.
    await runEnsure(domainId);
    expect((await mailRow(domainId)).provider_added_at).toBeNull();

    // The human does the thing at the registrar; the DNS provider notices.
    await confirmDelegation(domainId);

    // Run 2: the same job, unchanged, now gets further. That is the whole
    // property — no separate "resume" path exists, because there is nothing to
    // resume from except the database.
    await runEnsure(domainId);

    const row = await mailRow(domainId);
    expect(row.provider_added_at).not.toBeNull();
    expect(row.ownership_verified_at).not.toBeNull();
    expect(row.last_verify_error).toBeNull();

    const domain = await handle.pool.query<{ state: string }>(
      `select state from managed_domains where id = $1`,
      [domainId],
    );
    expect(domain.rows[0]?.state).toBe("mail_pending");
  });
});

describe("a minted mailbox password", () => {
  it("reaches the provider and application_secrets, and NO job payload", async () => {
    const domainId = await undelegatedDomain("mailbox-a.test");
    await confirmDelegation(domainId);
    await runEnsure(domainId);

    const template = await templates.create({
      name: "standard addresses (test)",
      entries: [{ localPart: "postmaster", kind: "mailbox" }],
    });
    await mail.applyTemplate(domainId, template.id);

    const before = passwordSink.passwords.length;
    await addJob(handle.pool, tasks.syncMailboxesTask, { domainId });
    await waitFor(
      async () =>
        passwordSink.passwords.length > before
          ? passwordSink.passwords.length
          : undefined,
      { timeoutMs: 30_000, label: `mailbox create for ${domainId}` },
    );

    const password = passwordSink.passwords.at(-1);
    expect(password).toBeTypeOf("string");
    expect((password as string).length).toBeGreaterThan(20);

    // It IS stored, under the design's documented key convention, with the
    // new bundle purpose — write-only, but stored, so a future ADR on reveal
    // is an additive change rather than a migration.
    const mailboxRow = await handle.pool.query<{
      id: string;
      secret_id: string | null;
    }>(
      `select id, secret_id from mailboxes
        where domain_id = $1 and local_part = 'postmaster'`,
      [domainId],
    );
    const secretId = mailboxRow.rows[0]?.secret_id;
    expect(secretId).toBeTypeOf("string");
    const secret = await handle.pool.query<{
      secret_key: string;
      purpose: string;
    }>(`select secret_key, purpose from application_secrets where id = $1`, [
      secretId,
    ]);
    expect(secret.rows[0]?.purpose).toBe("mailbox_password");
    expect(secret.rows[0]?.secret_key).toBe(
      `infrastructure.mailbox.${mailboxRow.rows[0]?.id}`,
    );

    // And it is in NO job payload. Graphile Worker payloads sit in a table in
    // cleartext and survive failure; Configuration & Secrets rule 5 is the one
    // this domain is most likely to break by accident, because every task here
    // needs a credential and the payload is the convenient place to put it.
    // Scanned by DISCOVERY rather than by naming one column: graphile-worker
    // moved the payload between a table and a view across versions, and a
    // hardcoded column name would turn this assertion into a silent no-op the
    // next time it moves. Every json column the queue owns is checked.
    const jsonColumns = await handle.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'graphile_worker'
          and data_type in ('json', 'jsonb')`,
    );
    expect(jsonColumns.rowCount).toBeGreaterThan(0);
    for (const column of jsonColumns.rows) {
      const values = await handle.pool.query<{ blob: string | null }>(
        `select string_agg("${column.column_name}"::text, ' ') as blob
           from graphile_worker."${column.table_name}"`,
      );
      expect(values.rows[0]?.blob ?? "").not.toContain(password as string);
    }

    // Nor in any run step or ledger summary.
    const steps = await handle.pool.query<{ req: unknown; res: unknown }>(
      `select s.request_summary as req, s.response_summary as res
         from reconcile_run_steps s
         join reconcile_runs r on r.id = s.run_id
        where r.subject_id = $1`,
      [domainId],
    );
    expect(JSON.stringify(steps.rows)).not.toContain(password as string);

    const ledger = await handle.pool.query<{ summary: unknown }>(
      `select response_summary as summary from provider_operations`,
    );
    expect(JSON.stringify(ledger.rows)).not.toContain(password as string);
  });
});

describe("the Purelymail adapter factory", () => {
  it("refuses a connection belonging to another provider", async () => {
    const factory = createPurelymailAdapterFactory({
      connections: services.connections,
      connectionCredentials: services.connectionCredentials,
    });
    await expect(
      factory.getAdapterForConnection(dnsConnectionId),
    ).rejects.toBeInstanceOf(PurelymailCredentialsMissingError);
  });

  it("reports a missing credential as configuration, not as an outage", async () => {
    const factory = createPurelymailAdapterFactory({
      connections: services.connections,
      connectionCredentials: services.connectionCredentials,
    });
    // The connection exists and has no stored token yet — the ordinary state
    // between creating a connection and pasting a key into the form.
    await expect(
      factory.getAdapterForConnection(mailConnectionId),
    ).rejects.toBeInstanceOf(PurelymailCredentialsMissingError);
  });

  it("builds and caches an adapter once a token is stored", async () => {
    await services.connectionCredentials.setCredential({
      connectionId: mailConnectionId,
      credentialType: PURELYMAIL_CREDENTIAL_TYPE,
      payload: { apiToken: "fake-purelymail-token-for-factory-test" },
    });

    let built = 0;
    const factory = createPurelymailAdapterFactory({
      connections: services.connections,
      connectionCredentials: services.connectionCredentials,
      createAdapter: ({ apiToken }) => {
        built += 1;
        expect(apiToken).toBe("fake-purelymail-token-for-factory-test");
        return {
          baseUrl: "https://purelymail.test",
          sourceAccountKey: "purelymail:purelymail.test",
        } as never;
      },
    });

    const first = await factory.getAdapterForConnection(mailConnectionId);
    const second = await factory.getAdapterForConnection(mailConnectionId);
    expect(built).toBe(1);
    expect(second).toBe(first);
    expect(first.sourceAccountKey).toBe("purelymail:purelymail.test");

    // An hourly floor, because what a mail poll waits for is a human at a
    // registrar. Polling faster cannot make that happen sooner.
    expect(first.minIntervalSeconds).toBe(3600);
    expect(factory.intervalFloorSeconds).toBe(3600);

    factory.invalidate(mailConnectionId);
    await factory.getAdapterForConnection(mailConnectionId);
    expect(built).toBe(2);
  });

  it("never exposes the token through the resolved handle", async () => {
    const factory = createPurelymailAdapterFactory({
      connections: services.connections,
      connectionCredentials: services.connectionCredentials,
      createAdapter: () =>
        ({
          baseUrl: "https://purelymail.test",
          sourceAccountKey: "purelymail:purelymail.test",
        }) as never,
    });
    const resolved = await factory.getAdapterForConnection(mailConnectionId);
    expect(JSON.stringify(resolved)).not.toContain(
      "fake-purelymail-token-for-factory-test",
    );
  });
});
