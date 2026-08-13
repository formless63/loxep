/**
 * The mail reconciler against real PostgreSQL and a stubbed mail provider —
 * the resumable desired-state loop, and above all THE DELEGATION GATE.
 *
 * Mail provisioning contains a step that takes **days and is performed by a
 * human at a registrar**. Nameserver delegation is not something Loxep can wait
 * on, retry into existence, or work around, and the mail provider's ownership
 * check cannot succeed until it completes. So the reconciler advances a domain
 * as far as it currently can, records exactly where it stopped, and returns —
 * every run safe, every run idempotent, and no run "the one that has to work".
 *
 * The three claims this file exists to hold to, because each of them is easy to
 * break in a way nothing else would notice:
 *
 * 1. **A gated run makes ZERO provider calls.** Not "few", not "cheap ones" —
 *    zero, asserted against the stub's counters. It is not a failure, it does
 *    not increment `verify_attempts`, it does not touch `consecutive_errors`,
 *    and the run finishes `succeeded`, because correctly waiting is a success.
 *    Recording it as an error would light up every health indicator in the
 *    product for the entirely normal condition of a domain whose nameservers
 *    were changed twenty minutes ago.
 * 2. **`invalid_request` / `not_found` from `addDomain` are NOT faults.**
 *    Delegation being confirmed does not mean the ownership TXT has propagated
 *    to whatever resolver the mail provider uses. Collapsing those into "the
 *    call failed" is what produces a workflow that looks broken for three days
 *    and then works. `auth` / `rate_limited` / `provider_unavailable` ARE
 *    faults and must throw.
 * 3. **Nothing is ever deleted that Loxep was not told to delete.** A provider
 *    address absent from intent is reported and left alone — the milestone-1
 *    rule for unexpected DNS records, applied where the stakes are higher
 *    because a mailbox holds mail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  MAILBOX_RUN_KIND,
  MAIL_DOMAIN_RUN_KIND,
  MATERIALIZE_RECORDS_TASK,
  ProviderCallError,
  createMailDomainsService,
  createMailSyncService,
  createManagedDomainsService,
  createRecordingEnqueue,
  domainJobKey,
  idempotencyKey,
  isDelegationConfirmed,
  nextState,
} from "../src/index.ts";
import type {
  CreateMailSyncServiceOptions,
  MailDomainsService,
  MailSyncService,
  ManagedDomainsService,
} from "../src/index.ts";
import {
  createRecordingSecretWriter,
  createScratchDb,
  createStubMailProvider,
  dropScratchDb,
  scratchDbName,
  silentLogger,
  type RecordingSecretWriter,
  type StubMailProvider,
  type StubMailProviderOptions,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_mail_sync");
let handle: DbHandle;
let dnsConnectionId = "";
let mailConnectionId = "";
let domains: ManagedDomainsService;
let mail: MailDomainsService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  const dns = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  dnsConnectionId = dns.rows[0]?.id ?? "";
  const mailConnection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('purelymail', 'mail', 'Purelymail (test)', 'active', '{}')
     returning id`,
  );
  mailConnectionId = mailConnection.rows[0]?.id ?? "";

  domains = createManagedDomainsService({ db: handle.db });
  mail = createMailDomainsService({ db: handle.db });
}, 180_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;

interface DomainFixture {
  id: string;
  name: string;
}

/**
 * A domain with mail intent registered, positioned at a chosen point in the
 * provisioning chain.
 *
 * `delegation` is the interesting axis: `"pending"` means the registrar has not
 * finished (no `provider_zone_status`, no `delegation_verified_at`), which is
 * the state a real domain sits in for days.
 */
async function newDomain(
  options: {
    delegation?: "pending" | "zone_active" | "recorded";
    state?: string;
    mailEnabled?: boolean;
  } = {},
): Promise<DomainFixture> {
  seq += 1;
  const name = `mailsync-${seq}.test`;
  const row = await domains.create({ name, dnsConnectionId });
  await mail.enableMail(row.id, { mailConnectionId });

  const delegation = options.delegation ?? "zone_active";
  await handle.pool.query(
    `update managed_domains
        set state = $2,
            external_zone_id = $3,
            provider_zone_status = $4,
            delegation_verified_at = $5,
            mail_enabled = $6
      where id = $1`,
    [
      row.id,
      options.state ?? "records_synced",
      `zone-${seq}`,
      delegation === "zone_active" ? "active" : delegation === "recorded" ? "pending" : null,
      delegation === "recorded" ? new Date() : null,
      options.mailEnabled ?? true,
    ],
  );
  return { id: row.id, name };
}

function newSecrets(): RecordingSecretWriter {
  return createRecordingSecretWriter({ pool: handle.pool });
}

function syncFor(
  provider: StubMailProvider,
  overrides: Partial<CreateMailSyncServiceOptions> = {},
): MailSyncService {
  return createMailSyncService({
    db: handle.db,
    provider,
    secrets: overrides.secrets ?? newSecrets(),
    ...overrides,
  });
}

function stub(options: StubMailProviderOptions = {}): StubMailProvider {
  return createStubMailProvider(options);
}

/** Total provider calls, for "nothing at all was spent" assertions. */
function totalCalls(provider: StubMailProvider): number {
  return Object.values(provider.calls).reduce((sum, n) => sum + n, 0);
}

async function mailRow(domainId: string): Promise<{
  provider_added_at: Date | null;
  ownership_code: string | null;
  ownership_verified_at: Date | null;
  verify_attempts: number;
  last_verify_error: string | null;
  last_verify_at: Date | null;
}> {
  const rows = await handle.pool.query<{
    provider_added_at: Date | null;
    ownership_code: string | null;
    ownership_verified_at: Date | null;
    verify_attempts: number;
    last_verify_error: string | null;
    last_verify_at: Date | null;
  }>(
    `select provider_added_at, ownership_code, ownership_verified_at,
            verify_attempts, last_verify_error, last_verify_at
       from mail_domains where domain_id = $1`,
    [domainId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no mail_domains row");
  return row;
}

async function domainRow(domainId: string): Promise<{
  state: string;
  consecutive_errors: number;
  last_error_code: string | null;
}> {
  const rows = await handle.pool.query<{
    state: string;
    consecutive_errors: number;
    last_error_code: string | null;
  }>(
    `select state, consecutive_errors, last_error_code
       from managed_domains where id = $1`,
    [domainId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no managed_domains row");
  return row;
}

async function runRow(runId: string): Promise<{
  kind: string;
  subject_type: string;
  subject_id: string;
  mode: string;
  status: string;
  trigger: string;
  step_count: number;
  error_summary: string | null;
}> {
  const rows = await handle.pool.query<{
    kind: string;
    subject_type: string;
    subject_id: string;
    mode: string;
    status: string;
    trigger: string;
    step_count: number;
    error_summary: string | null;
  }>(
    `select kind, subject_type, subject_id, mode, status, trigger, step_count, error_summary
       from reconcile_runs where id = $1`,
    [runId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no reconcile_runs row");
  return row;
}

async function stepNames(runId: string): Promise<string[]> {
  const rows = await handle.pool.query<{ step: string }>(
    `select step from reconcile_run_steps where run_id = $1 order by sequence`,
    [runId],
  );
  return rows.rows.map((row) => row.step);
}

async function operationRows(
  keyLike: string,
): Promise<Array<{ idempotency_key: string; status: string; attempts: number }>> {
  const rows = await handle.pool.query<{
    idempotency_key: string;
    status: string;
    attempts: number;
  }>(
    `select idempotency_key, status, attempts from provider_operations
      where idempotency_key like $1 order by idempotency_key`,
    [`%${keyLike}%`],
  );
  return rows.rows;
}

/* ==================================================================== gate */

describe("isDelegationConfirmed — one boolean whose being wrong costs days", () => {
  it("accepts the DNS PROVIDER'S OWN zone status as evidence of delegation", () => {
    expect(
      isDelegationConfirmed({
        delegationVerifiedAt: null,
        providerZoneStatus: "active",
      }),
    ).toBe(true);
  });

  it("accepts Loxep's recorded observation of delegation as evidence too", () => {
    expect(
      isDelegationConfirmed({
        delegationVerifiedAt: new Date(),
        providerZoneStatus: "pending",
      }),
    ).toBe(true);
  });

  it("confirms NOTHING while the provider still says 'pending' and nothing was observed", () => {
    expect(
      isDelegationConfirmed({
        delegationVerifiedAt: null,
        providerZoneStatus: "pending",
      }),
    ).toBe(false);
    expect(
      isDelegationConfirmed({
        delegationVerifiedAt: null,
        providerZoneStatus: null,
      }),
    ).toBe(false);
  });
});

describe("THE DELEGATION GATE — waiting correctly is a SUCCESS", () => {
  it("makes ZERO registration calls while the registrar still delegates elsewhere", async () => {
    // The headline. Every failed verification may count against a provider's
    // rate limits and its own patience, and none of them can succeed yet, so
    // the right number of attempts is none.
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub();
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    expect(result.outcome).toBe("delegation_pending");
    expect(provider.calls.addDomain).toBe(0);
    expect(provider.calls.findDomainByName).toBe(0);
    expect(provider.calls.recheckDomainDns).toBe(0);
  });

  it("finishes the run SUCCEEDED, because 'correctly waited' is not a failure", async () => {
    // Recording this as an error would light up every health indicator in the
    // product for an entirely normal condition.
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub();
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    expect(result.status).toBe("succeeded");
    const run = await runRow(result.runId);
    expect(run.status).toBe("succeeded");
    expect(run.error_summary).toBeNull();
    expect(await stepNames(result.runId)).toEqual([
      "read-intent",
      "fetch-ownership-code",
      "delegation-gate",
    ]);
  });

  it("does NOT increment verify_attempts, because no attempt was made", async () => {
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "poll" });
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "poll" });

    const row = await mailRow(domain.id);
    expect(row.verify_attempts).toBe(0);
    expect(row.last_verify_at).toBeNull();
    expect(row.last_verify_error).toBeNull();
  });

  it("does NOT increment consecutive_errors, because waiting is not an error", async () => {
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub();
    await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    const row = await domainRow(domain.id);
    expect(row.consecutive_errors).toBe(0);
    expect(row.last_error_code).toBeNull();
    // And the domain did not move: the gate advances nothing.
    expect(row.state).toBe("records_synced");
  });

  it("opens as soon as EITHER delegation signal appears", async () => {
    const observed = await newDomain({ delegation: "recorded" });
    const provider = stub();
    const result = await syncFor(provider).runMailDomainSync({
      domainId: observed.id,
      trigger: "poll",
    });
    // `provider_zone_status` is still 'pending' here; the recorded observation
    // is what opened the gate.
    expect(result.outcome).toBe("verified");
    expect(provider.calls.addDomain).toBe(1);
  });

  it("does not re-gate a domain already registered at the provider", async () => {
    // The gate guards registration. Once `provider_added_at` is set, a lost
    // delegation signal must not strand the domain forever.
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub({ domains: [{ name: "" }] });
    provider.registerDomain(domain.name);
    await handle.pool.query(
      `update mail_domains set provider_added_at = now() where domain_id = $1`,
      [domain.id],
    );

    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });
    expect(result.outcome).toBe("verified");
  });
});

describe("THE RESUME CASE — the whole design in one sequence", () => {
  it("resumes across three runs: waiting, then ownership pending, then verified", async () => {
    // (a) the registrar has not finished; (b) it has, but the ownership TXT is
    // not resolvable to the mail provider yet; (c) it is. Days may pass between
    // each. This is the resumability everything else rests on: no run is "the
    // one that has to work", and nothing is lost between them.
    const domain = await newDomain({ delegation: "pending", state: "records_synced" });
    const provider = stub({
      ownershipCode: "resume-code-1",
      failAddDomainWith: {
        kind: "invalid_request",
        message: "domain ownership could not be verified",
      },
    });
    const sync = syncFor(provider);

    /* -- (a) the registrar has not finished ------------------------------ */
    const first = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "intent_change",
    });
    expect(first.outcome).toBe("delegation_pending");
    expect(first.status).toBe("succeeded");
    expect(provider.calls.addDomain).toBe(0);
    // The ownership code was still fetched and stored: the TXT has to be
    // published and propagating BEFORE delegation completes, or the wait
    // afterwards is twice as long.
    expect(first.ownershipCodeFetched).toBe(true);
    expect((await mailRow(domain.id)).ownership_code).toBe("resume-code-1");

    /* -- (b) delegated, but the provider cannot see the TXT yet ---------- */
    await handle.pool.query(
      `update managed_domains set provider_zone_status = 'active' where id = $1`,
      [domain.id],
    );
    const second = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });
    expect(second.status).toBe("partial");
    expect(second.outcome).toBe("ownership_pending");
    expect(provider.calls.addDomain).toBe(1);
    expect(second.verifyAttempts).toBe(1);

    const afterSecond = await mailRow(domain.id);
    expect(afterSecond.verify_attempts).toBe(1);
    expect(afterSecond.last_verify_error).toBe(
      "domain ownership could not be verified",
    );
    expect(afterSecond.last_verify_at).not.toBeNull();
    expect(afterSecond.provider_added_at).toBeNull();
    // NOT a fault: nothing is broken, the answer simply is not available yet.
    expect((await domainRow(domain.id)).consecutive_errors).toBe(0);
    expect((await runRow(second.runId)).status).toBe("partial");

    /* -- (c) the TXT resolves and the provider accepts ------------------- */
    provider.setFailAddDomainWith(undefined);
    const third = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });
    expect(third.status).toBe("succeeded");
    expect(third.outcome).toBe("verified");
    expect(provider.calls.addDomain).toBe(2);
    // The ownership code was NOT re-fetched across three runs.
    expect(provider.calls.getOwnershipCode).toBe(1);

    const afterThird = await mailRow(domain.id);
    expect(afterThird.provider_added_at).not.toBeNull();
    expect(afterThird.ownership_verified_at).not.toBeNull();
    expect(afterThird.last_verify_error).toBeNull();
    expect((await domainRow(domain.id)).state).toBe("mail_pending");
  });
});

describe("the ownership code — an ACCOUNT-level read, deliberately ungated", () => {
  it("is fetched BEFORE the gate, because the TXT must be published first", async () => {
    const domain = await newDomain({ delegation: "pending" });
    const provider = stub({ ownershipCode: "code-before-gate" });
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "manual",
    });

    expect(result.ownershipCodeFetched).toBe(true);
    expect(provider.calls.getOwnershipCode).toBe(1);
    expect((await mailRow(domain.id)).ownership_code).toBe("code-before-gate");
    // ... and it is the ONLY call the gated run made.
    expect(totalCalls(provider)).toBe(1);
  });

  it("is never re-fetched once stored, because one code proves the whole account", async () => {
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);
    const first = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "manual",
    });
    const second = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(first.ownershipCodeFetched).toBe(true);
    expect(second.ownershipCodeFetched).toBe(false);
    expect(provider.calls.getOwnershipCode).toBe(1);
  });

  it("enqueues a re-materialize when the code arrives, because it changes the desired records", async () => {
    const domain = await newDomain({ delegation: "pending" });
    const enqueue = createRecordingEnqueue();
    const provider = stub();
    await syncFor(provider, { enqueue }).runMailDomainSync({
      domainId: domain.id,
      trigger: "manual",
    });

    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]?.taskName).toBe(MATERIALIZE_RECORDS_TASK);
    expect(enqueue.calls[0]?.jobKey).toBe(
      domainJobKey(MATERIALIZE_RECORDS_TASK, domain.id),
    );
    expect(enqueue.calls[0]?.payload).toEqual({ domainId: domain.id });
  });

  it("fails the run and records the fault when the code cannot be fetched at all", async () => {
    const domain = await newDomain();
    const provider = stub({
      failOwnershipCodeWith: { kind: "auth", message: "api key rejected" },
    });
    await expect(
      syncFor(provider).runMailDomainSync({
        domainId: domain.id,
        trigger: "manual",
      }),
    ).rejects.toThrow(ProviderCallError);

    expect((await domainRow(domain.id)).last_error_code).toBe("auth");
    expect((await domainRow(domain.id)).consecutive_errors).toBe(1);
    expect(provider.calls.addDomain).toBe(0);
  });
});

describe("classification — which addDomain failures are FAULTS and which are waiting", () => {
  for (const kind of ["auth", "rate_limited", "provider_unavailable"]) {
    it(`treats ${kind} as a real fault: it throws, fails the run, and counts against health`, async () => {
      // A fault must propagate so the job's backoff applies and connection
      // health reflects it. Swallowing it would retry a revoked key forever.
      const domain = await newDomain();
      const provider = stub({
        failAddDomainWith: { kind, message: `stub ${kind}` },
      });
      const error = await syncFor(provider)
        .runMailDomainSync({ domainId: domain.id, trigger: "poll" })
        .then(
          () => null,
          (raised: unknown) => raised,
        );

      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).kind).toBe(kind);

      const domainAfter = await domainRow(domain.id);
      expect(domainAfter.last_error_code).toBe(kind);
      expect(domainAfter.consecutive_errors).toBe(1);
      // Health is orthogonal to state: a fault never walks the domain back.
      expect(domainAfter.state).toBe("records_synced");
      // A fault is NOT a verification attempt — nothing was proved or
      // disproved about ownership.
      expect((await mailRow(domain.id)).verify_attempts).toBe(0);
    });
  }

  for (const kind of ["invalid_request", "not_found"]) {
    it(`treats ${kind} as 'not yet', not a failure: no throw, and the next run tries again`, async () => {
      // Delegation being confirmed does not mean the ownership TXT has reached
      // the resolver the mail provider uses.
      const domain = await newDomain();
      const provider = stub({
        failAddDomainWith: { kind, message: `stub says ${kind}` },
      });
      const result = await syncFor(provider).runMailDomainSync({
        domainId: domain.id,
        trigger: "poll",
      });

      expect(result.status).toBe("partial");
      expect(result.outcome).toBe("ownership_pending");
      expect(result.verifyAttempts).toBe(1);
      expect((await mailRow(domain.id)).last_verify_error).toBe(
        `stub says ${kind}`,
      );
      // Not a fault: connection health is untouched.
      expect((await domainRow(domain.id)).consecutive_errors).toBe(0);
      expect((await domainRow(domain.id)).last_error_code).toBeNull();
    });
  }

  it("records the failed attempt as a run STEP so an operator can see why it is waiting", async () => {
    const domain = await newDomain();
    const provider = stub({
      failAddDomainWith: { kind: "invalid_request", message: "no TXT found" },
    });
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    const rows = await handle.pool.query<{
      status: string;
      error_code: string | null;
      response_summary: { interpretation?: string } | null;
    }>(
      `select status, error_code, response_summary from reconcile_run_steps
        where run_id = $1 and step = 'register-domain'`,
      [result.runId],
    );
    expect(rows.rows[0]?.status).toBe("failed");
    expect(rows.rows[0]?.error_code).toBe("invalid_request");
    expect(rows.rows[0]?.response_summary?.interpretation).toBe(
      "ownership_pending",
    );
  });
});

describe("idempotency and the provider_operations ledger", () => {
  it("changes NOTHING when run twice from a fully verified state", async () => {
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);

    const first = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "intent_change",
    });
    const before = await mailRow(domain.id);
    const second = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(first.outcome).toBe("verified");
    expect(second.outcome).toBe("verified");
    // One registration, ever.
    expect(provider.calls.addDomain).toBe(1);
    const after = await mailRow(domain.id);
    expect(after.provider_added_at).toEqual(before.provider_added_at);
    expect(after.ownership_verified_at).toEqual(before.ownership_verified_at);
    expect(after.verify_attempts).toBe(0);
  });

  it("writes exactly ONE provider_operations row for a domain's registration", async () => {
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "manual" });
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "sweep" });

    const rows = await operationRows(domain.name);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(
      idempotencyKey("mail", "mail.domain.add", domain.name),
    );
    expect(rows[0]?.status).toBe("succeeded");
  });

  it("SHORT-CIRCUITS an already-succeeded registration instead of calling again", async () => {
    // The ledger, not the `mail_domains` column, is the authority on "did we
    // already do this". Losing the column must not cost a second registration.
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "manual" });

    // Both columns, because `mail_domains_verified_implies_added_check` will
    // not let a domain be "verified but never registered" — the provider
    // cannot have verified a domain it never accepted.
    await handle.pool.query(
      `update mail_domains
          set provider_added_at = null, ownership_verified_at = null
        where domain_id = $1`,
      [domain.id],
    );
    const again = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(provider.calls.addDomain).toBe(1);
    expect(again.outcome).toBe("verified");
    const rows = await handle.pool.query<{
      response_summary: { shortCircuited?: boolean } | null;
    }>(
      `select response_summary from reconcile_run_steps
        where run_id = $1 and step = 'register-domain'`,
      [again.runId],
    );
    expect(rows.rows[0]?.response_summary?.shortCircuited).toBe(true);
    expect((await mailRow(domain.id)).provider_added_at).not.toBeNull();
  });

  it("keys the ledger by PROVIDER NAME, so two mail providers cannot collide", async () => {
    const domain = await newDomain();
    const provider = stub();
    await syncFor(provider, { providerName: "purelymail" }).runMailDomainSync({
      domainId: domain.id,
      trigger: "manual",
    });
    const rows = await operationRows(domain.name);
    expect(rows[0]?.idempotency_key).toBe(
      idempotencyKey("purelymail", "mail.domain.add", domain.name),
    );
  });
});

describe("a PENDING ledger row is resolved by reading the provider back (open question 4)", () => {
  async function forcePending(domainName: string): Promise<string> {
    // The state a worker crash between the ledger insert and the provider call
    // leaves behind: "we may or may not have registered this domain".
    const key = idempotencyKey("mail", "mail.domain.add", domainName);
    await handle.pool.query(
      `insert into provider_operations (idempotency_key, provider, operation, status, attempts)
       values ($1, 'mail', 'mail.domain.add', 'pending', 1)`,
      [key],
    );
    return key;
  }

  it("resolves a pending row to SUCCEEDED when the domain is really there", async () => {
    const domain = await newDomain();
    await forcePending(domain.name);
    const provider = stub();
    provider.registerDomain(domain.name);

    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    // The point: NOT a blind retry. `addDomain` is never called again.
    expect(provider.calls.addDomain).toBe(0);
    expect(await stepNames(result.runId)).toContain("register-domain.read-back");
    expect((await operationRows(domain.name))[0]?.status).toBe("succeeded");
    expect((await mailRow(domain.id)).provider_added_at).not.toBeNull();
    expect(result.outcome).toBe("verified");
  });

  it("resolves a pending row to FAILED when the domain is absent, and retries next run", async () => {
    const domain = await newDomain();
    await forcePending(domain.name);
    const provider = stub();

    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    expect(provider.calls.addDomain).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("ownership_pending");
    expect((await operationRows(domain.name))[0]?.status).toBe("failed");
    expect((await mailRow(domain.id)).provider_added_at).toBeNull();

    // `failed` means nothing was created, so the NEXT run may safely proceed.
    const rerun = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });
    expect(provider.calls.addDomain).toBe(1);
    expect(rerun.outcome).toBe("verified");
  });
});

describe("the provider's own DNS verdict", () => {
  it("asks for a recheck and reports dns_pending until all four checks pass", async () => {
    // The provider's check is asynchronous, so this is a nudge whose result the
    // NEXT run reads — the resumable shape, one level down.
    const domain = await newDomain();
    const provider = stub({ dnsOnRegister: { passesDkim: false } });
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    expect(result.outcome).toBe("dns_pending");
    expect(result.status).toBe("succeeded");
    expect(result.dns).toEqual({
      passesMx: true,
      passesSpf: true,
      passesDkim: false,
      passesDmarc: true,
    });
    expect(provider.calls.recheckDomainDns).toBe(1);
  });

  it("reports verified and asks for NO recheck when all four pass", async () => {
    const domain = await newDomain();
    const provider = stub();
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    expect(result.outcome).toBe("verified");
    expect(provider.calls.recheckDomainDns).toBe(0);
  });

  it("stamps ownership_verified_at and clears the waiting message once the provider lists it", async () => {
    const domain = await newDomain();
    const provider = stub({
      failAddDomainWith: { kind: "not_found", message: "not visible yet" },
    });
    const sync = syncFor(provider);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "poll" });
    expect((await mailRow(domain.id)).last_verify_error).toBe("not visible yet");

    provider.setFailAddDomainWith(undefined);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "poll" });

    const row = await mailRow(domain.id);
    expect(row.ownership_verified_at).not.toBeNull();
    expect(row.last_verify_error).toBeNull();
  });

  it("advances the domain to mail_pending once ownership is verified, and clears the error columns", async () => {
    const domain = await newDomain({ state: "zone_active" });
    await handle.pool.query(
      `update managed_domains set consecutive_errors = 3, last_error_code = 'rate_limited' where id = $1`,
      [domain.id],
    );
    const provider = stub();
    await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });

    const row = await domainRow(domain.id);
    expect(row.state).toBe("mail_pending");
    expect(row.consecutive_errors).toBe(0);
    expect(row.last_error_code).toBeNull();
  });

  it("treats 'registered per the ledger, absent per the provider' as waiting, NOT as a reason to register again", async () => {
    // That is precisely what the ledger exists to prevent.
    const domain = await newDomain();
    await handle.pool.query(
      `update mail_domains set provider_added_at = now() where domain_id = $1`,
      [domain.id],
    );
    const provider = stub();

    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "poll",
    });
    expect(provider.calls.addDomain).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("ownership_pending");
    expect((await mailRow(domain.id)).verify_attempts).toBe(1);
    expect((await mailRow(domain.id)).last_verify_error).toMatch(
      /does not list this domain/,
    );
  });
});

describe("mail_enabled = false", () => {
  it("does nothing, calls nobody, and does NOT deregister the domain at the provider", async () => {
    // Turning mail off is intent. Deregistering a domain at a provider is a
    // destructive act an operator performs explicitly, and it would take the
    // mailboxes with it.
    const domain = await newDomain({ mailEnabled: false });
    const provider = stub();
    provider.registerDomain(domain.name);
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(result.outcome).toBe("disabled");
    expect(result.status).toBe("succeeded");
    expect(totalCalls(provider)).toBe(0);
    expect(provider.hasDomain(domain.name)).toBe(true);
    expect(await stepNames(result.runId)).toEqual([
      "read-intent",
      "mail-disabled",
    ]);
  });
});

describe("nextState — state only ever ADVANCES", () => {
  it("moves a domain forward along the provisioning chain", () => {
    expect(nextState("records_synced", "mail_pending")).toBe("mail_pending");
    expect(nextState("draft", "ready")).toBe("ready");
  });

  it("refuses to walk a state BACKWARDS, because health is orthogonal to progress", () => {
    // `degraded` is not a state for the same reason: a `ready` domain whose
    // DKIM check is temporarily failing is still `ready`, and its trouble lives
    // in `last_error_*` / `drift_detected_at`.
    expect(nextState("ready", "mail_pending")).toBeNull();
    expect(nextState("mail_pending", "mail_pending")).toBeNull();
  });

  it("writes nothing for a state it does not recognize", () => {
    expect(nextState("something-else", "ready")).toBeNull();
  });

  it("leaves a READY domain ready when its DKIM check fails", async () => {
    const domain = await newDomain({ state: "ready" });
    const provider = stub({ dnsOnRegister: { passesDkim: false } });
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(result.outcome).toBe("dns_pending");
    expect((await domainRow(domain.id)).state).toBe("ready");
  });
});

/* ================================================================ mailboxes */

describe("mailbox sync — gated on ownership, and never destructive", () => {
  /** A verified mail domain: the state mailbox sync is allowed to run from. */
  async function verifiedDomain(): Promise<DomainFixture> {
    const domain = await newDomain();
    const provider = stub();
    await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "intent_change",
    });
    return domain;
  }

  it("makes NO BILLABLE CALL before ownership is verified", async () => {
    // Attempting a create on an unverified domain spends a billable call to
    // learn something the database already knows.
    const domain = await newDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const provider = stub();
    const result = await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.status).toBe("succeeded");
    expect(result.created).toBe(0);
    expect(totalCalls(provider)).toBe(0);
    expect(await stepNames(result.runId)).toEqual(["ownership-gate"]);
  });

  it("creates a real mailbox as an ACCOUNT and an alias as a ROUTING RULE", async () => {
    // The distinction is not cosmetic: an account is billable and holds mail, a
    // routing rule is neither.
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "ops@example.test",
    });
    await mail.addMailbox(domain.id, {
      localPart: "catchall",
      kind: "catchall",
      forwardTo: "ops@example.test",
    });

    const provider = stub();
    const result = await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.created).toBe(1);
    expect(result.routingRulesCreated).toBe(2);
    expect(provider.calls.createUser).toBe(1);
    expect(provider.userAddresses()).toEqual([`postmaster@${domain.name}`]);
    const rules = provider.rules();
    expect(rules.map((rule) => rule.matchUser).sort()).toEqual([
      "abuse",
      "catchall",
    ]);
    expect(rules.find((rule) => rule.matchUser === "catchall")?.catchall).toBe(
      true,
    );
    expect(rules.find((rule) => rule.matchUser === "abuse")?.catchall).toBe(
      false,
    );
  });

  it("REPOINTS an alias whose forwarding address changed, rather than calling it unchanged", async () => {
    // Matching a routing rule on its local part alone is the plausible
    // implementation and it is wrong: changing where an alias forwards would
    // leave the provider delivering to the old address forever, silently, and
    // the run would report `unchanged`. The provider offers no update call, so
    // convergence is delete-then-create.
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "ops@example.test",
    });

    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailboxSync({ domainId: domain.id, trigger: "intent_change" });
    expect(provider.rules()[0]?.targetAddresses).toEqual(["ops@example.test"]);

    // The operator repoints it. `addMailbox` upserts intent on the natural key.
    await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "security@example.test",
    });

    const deletesBefore = provider.calls.deleteRoutingRule;
    const result = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.unchanged).toBe(0);
    expect(result.routingRulesCreated).toBe(1);
    expect(provider.calls.deleteRoutingRule).toBe(deletesBefore + 1);
    expect(provider.rules()).toHaveLength(1);
    expect(provider.rules()[0]?.targetAddresses).toEqual([
      "security@example.test",
    ]);
  });

  it("leaves a converged alias completely alone on a rerun", async () => {
    // The other half of the same rule: comparing content must not make every
    // rerun churn the provider's rules.
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "ops@example.test",
    });

    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailboxSync({ domainId: domain.id, trigger: "intent_change" });
    const createsAfterFirst = provider.calls.createRoutingRule;

    const result = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.unchanged).toBe(1);
    expect(result.routingRulesCreated).toBe(0);
    expect(provider.calls.createRoutingRule).toBe(createsAfterFirst);
    expect(provider.calls.deleteRoutingRule).toBe(0);
  });

  it("REPORTS an unexpected routing rule and never deletes it", async () => {
    // The mailbox case had this and the routing-rule case did not, which is
    // the kind of asymmetry nobody notices until a hand-created CATCH-ALL is
    // quietly swallowing every address the operator believes is unrouted.
    const domain = await verifiedDomain();
    const provider = stub();
    await provider.createRoutingRule({
      domainName: domain.name,
      matchUser: "sales",
      targetAddresses: ["somebody@elsewhere.test"],
      catchall: false,
    });

    const result = await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.unexpected).toContain(`sales@${domain.name}`);
    // Reported, and STILL THERE. Never deleted, in any mode.
    expect(provider.rules().map((rule) => rule.matchUser)).toContain("sales");
  });

  it("stores the minted password under infrastructure.mailbox.<id> with the mailbox_password purpose", async () => {
    const domain = await verifiedDomain();
    const mailbox = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const secrets = newSecrets();
    const provider = stub();
    await syncFor(provider, { secrets }).runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(secrets.writes).toEqual([
      {
        secretKey: `infrastructure.mailbox.${mailbox.id}`,
        purpose: "mailbox_password",
      },
    ]);

    // And the LOGICAL secret id is linked from the mailbox row (ADR-0019),
    // which only holds because the writer inserted a real row.
    const row = await handle.pool.query<{
      secret_id: string | null;
      provider_created_at: Date | null;
    }>(
      `select secret_id, provider_created_at from mailboxes where id = $1`,
      [mailbox.id],
    );
    expect(row.rows[0]?.secret_id).not.toBeNull();
    expect(row.rows[0]?.provider_created_at).not.toBeNull();
  });

  it("writes the secret BEFORE the provider call, so a failed create never loses the password", async () => {
    // The other order leaves a mailbox whose password is lost, which is
    // unrecoverable without a reset.
    const domain = await verifiedDomain();
    const mailbox = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const secrets = newSecrets();
    const provider = stub({
      failCreateUserWith: { kind: "provider_unavailable", message: "502" },
    });

    const error = await syncFor(provider, { secrets })
      .runMailboxSync({ domainId: domain.id, trigger: "intent_change" })
      .then(
        () => null,
        (raised: unknown) => raised,
      );
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(secrets.writes).toHaveLength(1);

    const row = await handle.pool.query<{
      secret_id: string | null;
      provider_created_at: Date | null;
    }>(`select secret_id, provider_created_at from mailboxes where id = $1`, [
      mailbox.id,
    ]);
    expect(row.rows[0]?.secret_id).not.toBeNull();
    // The provider never accepted it, so the evidence column stays empty.
    expect(row.rows[0]?.provider_created_at).toBeNull();
    expect((await domainRow(domain.id)).consecutive_errors).toBe(1);
  });

  it("is IDEMPOTENT: a rerun creates nothing, ledgers nothing, and rotates no password", async () => {
    // At-least-once delivery means this function runs again for no reason at
    // all. A second secret write would silently invalidate a working mailbox.
    const domain = await verifiedDomain();
    const mailbox = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const secrets = newSecrets();
    const provider = stub();
    const sync = syncFor(provider, { secrets });

    await sync.runMailboxSync({ domainId: domain.id, trigger: "intent_change" });
    const second = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(provider.calls.createUser).toBe(1);
    expect(
      secrets.writeCountFor(`infrastructure.mailbox.${mailbox.id}`),
    ).toBe(1);
    expect(await operationRows(`mail.user.create:postmaster@${domain.name}`))
      .toHaveLength(1);
  });

  it("deletes exactly what an operator soft-deleted, account or routing rule", async () => {
    const domain = await verifiedDomain();
    const box = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const alias = await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "ops@example.test",
    });
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailboxSync({ domainId: domain.id, trigger: "intent_change" });

    await mail.removeMailbox(box.id);
    await mail.removeMailbox(alias.id);
    const result = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    expect(result.deleted).toBe(2);
    expect(provider.calls.deleteUser).toBe(1);
    expect(provider.calls.deleteRoutingRule).toBe(1);
    expect(provider.userAddresses()).toEqual([]);
    expect(provider.rules()).toEqual([]);
  });

  it("converges rather than failing when a soft-deleted mailbox is already gone", async () => {
    const domain = await verifiedDomain();
    const box = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailboxSync({ domainId: domain.id, trigger: "intent_change" });

    // Somebody removed it at the provider by hand, then intent caught up.
    await provider.deleteUser(`postmaster@${domain.name}`);
    await mail.removeMailbox(box.id);
    const result = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(result.deleted).toBe(0);
    const row = await handle.pool.query<{ provider_created_at: Date | null }>(
      `select provider_created_at from mailboxes where id = $1`,
      [box.id],
    );
    // The marker is cleared so the next run does not look again.
    expect(row.rows[0]?.provider_created_at).toBeNull();
  });

  it("REPORTS a provider address intent does not describe, and NEVER deletes it", async () => {
    // The milestone-1 rule for unexpected DNS records, applied where the stakes
    // are higher: deleting a mailbox takes the mail with it.
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const stranger = `somebody-else@${domain.name}`;
    const provider = stub({ users: [stranger] });

    const result = await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(result.unexpected).toEqual([stranger]);
    expect(provider.calls.deleteUser).toBe(0);
    expect(provider.userAddresses()).toContain(stranger);
    expect(await stepNames(result.runId)).toContain("unexpected-mailboxes");

    const rows = await handle.pool.query<{
      response_summary: { action?: string; addresses?: string[] } | null;
    }>(
      `select response_summary from reconcile_run_steps
        where run_id = $1 and step = 'unexpected-mailboxes'`,
      [result.runId],
    );
    expect(rows.rows[0]?.response_summary?.action).toBe("reported-only");
    expect(rows.rows[0]?.response_summary?.addresses).toEqual([stranger]);
  });

  it("adopts an address the provider already has instead of creating it twice", async () => {
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const provider = stub({ users: [`postmaster@${domain.name}`] });
    const secrets = newSecrets();

    const result = await syncFor(provider, { secrets }).runMailboxSync({
      domainId: domain.id,
      trigger: "sweep",
    });

    expect(result.created).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(provider.calls.createUser).toBe(0);
    // No password was minted for a mailbox Loxep did not create.
    expect(secrets.writes).toHaveLength(0);
  });

  it("claims READY only when every intended address exists at the provider", async () => {
    const domain = await verifiedDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const provider = stub();
    await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });
    expect((await domainRow(domain.id)).state).toBe("ready");
  });

  it("does not claim READY for a domain with no mailboxes at all", async () => {
    // "Nothing outstanding" and "nothing asked for" are different facts.
    const domain = await verifiedDomain();
    const provider = stub();
    await syncFor(provider).runMailboxSync({
      domainId: domain.id,
      trigger: "sweep",
    });
    expect((await domainRow(domain.id)).state).toBe("mail_pending");
  });
});

describe("the run and step ledgers", () => {
  it("records a mail-domain run as kind sync-mail-domain, subject domain, mode apply", async () => {
    // Mail work is never a comparison: there is no read-only form of "register
    // this domain", so `check` would have nothing to report.
    const domain = await newDomain();
    const provider = stub();
    const result = await syncFor(provider).runMailDomainSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    const run = await runRow(result.runId);
    expect(run.kind).toBe(MAIL_DOMAIN_RUN_KIND);
    expect(run.subject_type).toBe("domain");
    expect(run.subject_id).toBe(domain.id);
    expect(run.mode).toBe("apply");
    expect(run.trigger).toBe("intent_change");
    expect(run.status).toBe("succeeded");
    expect(await stepNames(result.runId)).toEqual([
      "read-intent",
      "fetch-ownership-code",
      "register-domain",
      "verify-ownership",
    ]);
  });

  it("records a mailbox run as kind sync-mailboxes against the same subject", async () => {
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);
    await sync.runMailDomainSync({ domainId: domain.id, trigger: "manual" });
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const result = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "intent_change",
    });

    const run = await runRow(result.runId);
    expect(run.kind).toBe(MAILBOX_RUN_KIND);
    expect(run.subject_type).toBe("domain");
    expect(run.subject_id).toBe(domain.id);
    expect(run.mode).toBe("apply");
  });

  it("keeps step_count equal to the steps it actually recorded", async () => {
    const domain = await newDomain();
    const provider = stub();
    const sync = syncFor(provider);
    const domainRun = await sync.runMailDomainSync({
      domainId: domain.id,
      trigger: "manual",
    });
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const mailboxRun = await sync.runMailboxSync({
      domainId: domain.id,
      trigger: "manual",
    });

    for (const runId of [domainRun.runId, mailboxRun.runId]) {
      const run = await runRow(runId);
      expect(run.step_count).toBe((await stepNames(runId)).length);
      expect(run.step_count).toBeGreaterThan(0);
    }
  });

  it("refuses to reconcile a domain with no mail registration at all", async () => {
    seq += 1;
    const row = await domains.create({
      name: `unregistered-${seq}.test`,
      dnsConnectionId,
    });
    const provider = stub();
    await expect(
      syncFor(provider).runMailDomainSync({
        domainId: row.id,
        trigger: "sweep",
      }),
    ).rejects.toThrow(/no mail registration/);
    expect(totalCalls(provider)).toBe(0);
  });
});
