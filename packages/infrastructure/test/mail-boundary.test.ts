/**
 * The secret-containment boundary, asserted rather than reviewed.
 *
 * `reconcile_run_steps`' table note names the rule and the enforcement in the
 * same breath: *"What must NEVER appear here: a token value, a mailbox
 * password, an `Authorization` header... There is a test per adapter asserting
 * this, not a code review."* This is that test for the mail half.
 *
 * ## How it is made provable
 *
 * A minted password is high-entropy by construction, which makes it impossible
 * to search for. So the run below injects a DETERMINISTIC minter whose output
 * carries a distinctive marker, drives a complete mailbox provisioning, and
 * then greps every durable surface the value could have leaked into:
 * `reconcile_run_steps`, `provider_operations`, `audit_events`, the `mailboxes`
 * row itself, and the Graphile Worker job payloads — which sit in a table in
 * cleartext and survive failure, and are therefore the most attractive wrong
 * place to put a credential.
 *
 * The first test proves the marker really did travel to the two places it is
 * SUPPOSED to go (the provider, and `application_secrets`). Without it, every
 * absence assertion below would pass just as happily against a marker that was
 * never used at all — which is the failure mode this kind of test has.
 *
 * ## And one deliberate PRESENCE
 *
 * The ownership code is in a run step on purpose. Its entire function is to be
 * published in a public `TXT` record; the design says so explicitly *"so the
 * argument is not had twice"*, and asserting its presence here is what stops a
 * future well-meaning redaction pass from hiding the one value an operator
 * needs to read off the screen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { makeWorkerUtils } from "graphile-worker";
import {
  createMailDomainsService,
  createMailSyncService,
  createManagedDomainsService,
  createRecordingEnqueue,
  createTransactionalEnqueue,
  defaultPasswordMinter,
} from "../src/index.ts";
import type { TransactionalEnqueue } from "../src/index.ts";
import {
  createRecordingSecretWriter,
  createScratchDb,
  createStubMailProvider,
  dropScratchDb,
  scratchDbName,
  silentLogger,
  type RecordingSecretWriter,
  type StubMailProvider,
} from "./helpers.ts";

/**
 * The marker. Distinctive enough that a substring search over serialized JSON
 * cannot match it by accident, and obviously fake so a reader of a failing
 * assertion knows immediately that no real credential is on screen.
 */
const MARKER = "QQ-loxep-fake-mailbox-password-marker-7f3a";

const dbName = scratchDbName("loxep_test_infra_mail_boundary");
let handle: DbHandle;
let provider: StubMailProvider;
let secrets: RecordingSecretWriter;
let recorder: ReturnType<typeof createRecordingEnqueue>;
let domainId = "";
let domainName = "";
let mailboxId = "";
let domainRunId = "";
let mailboxRunId = "";

const OWNERSHIP_CODE = "public-ownership-code-abc123";

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // A real Graphile Worker schema, because the job payload leg of this test
  // must read the real jobs table rather than a stand-in for it.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.release();

  const dns = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  const mailConnection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('purelymail', 'mail', 'Purelymail (test)', 'active', '{}')
     returning id`,
  );
  const dnsConnectionId = dns.rows[0]?.id ?? "";
  const mailConnectionId = mailConnection.rows[0]?.id ?? "";

  const enqueue: TransactionalEnqueue = createTransactionalEnqueue();
  recorder = createRecordingEnqueue();
  const domains = createManagedDomainsService({ db: handle.db, enqueue });
  const mail = createMailDomainsService({ db: handle.db, enqueue });

  domainName = "boundary.test";
  const domain = await domains.create({
    name: domainName,
    dnsConnectionId,
  });
  domainId = domain.id;
  await handle.pool.query(
    `update managed_domains
        set state = 'records_synced', provider_zone_status = 'active'
      where id = $1`,
    [domainId],
  );
  await mail.enableMail(domainId, { mailConnectionId, actorUserId: null });
  const mailbox = await mail.addMailbox(domainId, {
    localPart: "postmaster",
    kind: "mailbox",
  });
  mailboxId = mailbox.id;

  provider = createStubMailProvider({ ownershipCode: OWNERSHIP_CODE });
  secrets = createRecordingSecretWriter({ pool: handle.pool });
  let minted = 0;
  const sync = createMailSyncService({
    db: handle.db,
    provider,
    secrets,
    // Deterministic ON PURPOSE. Entropy is what makes a real password
    // unsearchable, which is exactly what a containment test cannot work with.
    mintPassword: () => {
      minted += 1;
      return `${MARKER}-${minted}`;
    },
    enqueue: recorder,
  });

  const domainRun = await sync.runMailDomainSync({
    domainId,
    trigger: "intent_change",
  });
  domainRunId = domainRun.runId;
  const mailboxRun = await sync.runMailboxSync({
    domainId,
    trigger: "intent_change",
  });
  mailboxRunId = mailboxRun.runId;
}, 180_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function serialized(query: string): Promise<string> {
  const rows = await handle.pool.query(query);
  return JSON.stringify(rows.rows);
}

describe("the minted mailbox password", () => {
  it("really DID reach the provider and the secret store — so its absence elsewhere means something", async () => {
    // The control. Every other test in this file is an absence assertion, and
    // an absence assertion against a value that was never produced is
    // worthless.
    expect(provider.passwordFor(`postmaster@${domainName}`)).toContain(MARKER);
    expect(secrets.storedValueContains(MARKER)).toBe(true);
    expect(secrets.writes).toEqual([
      {
        secretKey: `infrastructure.mailbox.${mailboxId}`,
        purpose: "mailbox_password",
      },
    ]);
  });

  it("appears in NO reconcile_run_steps summary, for either run", async () => {
    // `request_summary` / `response_summary` are redacted structures, and
    // `password` is not in scope for any summary builder in `mail-sync.ts`.
    // That is the intent; this is the assertion.
    const steps = await serialized(
      `select run_id, step, status, request_summary, response_summary, error_detail
         from reconcile_run_steps order by run_id, sequence`,
    );
    expect(steps).not.toContain(MARKER);
    // The summaries are not empty — the search had something to search.
    expect(steps).toContain("create-mailbox");
    expect(steps).toContain("passwordOmitted");
    expect([domainRunId, mailboxRunId].every((id) => steps.includes(id))).toBe(
      true,
    );
  });

  it("appears in NO provider_operations response summary", async () => {
    const operations = await serialized(
      `select idempotency_key, provider, operation, status, response_summary
         from provider_operations`,
    );
    expect(operations).not.toContain(MARKER);
    expect(operations).toContain("mail.user.create");
  });

  it("appears in NO job payload — Graphile payloads are cleartext and survive failure", async () => {
    // Configuration & Secrets rule 5, at its sharpest: `sync-mailboxes` is the
    // one task in this domain that handles a minted credential.
    // The PRIVATE table, deliberately: Graphile Worker's public `jobs` view
    // does not expose `payload` at all, so asserting against the view would
    // assert nothing. The row a leak would sit in is this one.
    const jobs = await serialized(
      `select tasks.identifier, jobs.key, jobs.payload
         from graphile_worker._private_jobs as jobs
         join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id`,
    );
    expect(jobs).not.toContain(MARKER);
    // There really are jobs to inspect, and they carry a domainId and nothing
    // else.
    expect(jobs).toContain(domainId);
    expect(jobs).toContain("infrastructure.");

    for (const call of recorder.calls) {
      expect(Object.keys(call.payload)).toEqual(["domainId"]);
      expect(JSON.stringify(call.payload)).not.toContain(MARKER);
    }
  });

  it("appears in NO audit event, which is a durable, operator-readable log", async () => {
    const events = await serialized(
      `select action, resource_type, resource_id, before, after from audit_events`,
    );
    expect(events).not.toContain(MARKER);
    expect(events).toContain("infrastructure.mailbox.add");
  });

  it("appears nowhere on the mailboxes row — the column is a secret_id, not a value", async () => {
    // `mailboxes.secret_id` points at a LOGICAL `application_secrets` record
    // (ADR-0019). The password lives encrypted behind that id, and the intent
    // row never holds it.
    const rows = await serialized(`select * from mailboxes`);
    expect(rows).not.toContain(MARKER);
    const linked = await handle.pool.query<{ secret_id: string | null }>(
      `select secret_id from mailboxes where id = $1`,
      [mailboxId],
    );
    expect(linked.rows[0]?.secret_id).not.toBeNull();
  });
});

describe("the ownership code is PUBLISHED, deliberately", () => {
  it("IS present in a run-step summary, because it belongs in a public TXT record", async () => {
    // Not an oversight, and not a value to redact later: the design states the
    // position explicitly so the argument is not had twice, and the operator
    // has to be able to read it.
    const rows = await handle.pool.query<{
      response_summary: {
        ownershipCode?: string;
        ownershipCodeIsPublic?: boolean;
      } | null;
    }>(
      `select response_summary from reconcile_run_steps
        where run_id = $1 and step = 'fetch-ownership-code'`,
      [domainRunId],
    );
    expect(rows.rows[0]?.response_summary?.ownershipCode).toBe(OWNERSHIP_CODE);
    expect(rows.rows[0]?.response_summary?.ownershipCodeIsPublic).toBe(true);
  });

  it("is stored in plaintext on mail_domains rather than in application_secrets", async () => {
    const rows = await handle.pool.query<{ ownership_code: string | null }>(
      `select ownership_code from mail_domains where domain_id = $1`,
      [domainId],
    );
    expect(rows.rows[0]?.ownership_code).toBe(OWNERSHIP_CODE);

    const stored = await handle.pool.query<{ purpose: string }>(
      `select purpose from application_secrets`,
    );
    expect(stored.rows.map((row) => row.purpose)).toEqual(["mailbox_password"]);
  });
});

describe("defaultPasswordMinter", () => {
  it("returns a high-entropy value and never the same one twice", () => {
    // Asserted on shape only — neither value is printed, compared to a literal,
    // or written anywhere a failure message could carry it.
    const first = defaultPasswordMinter();
    const second = defaultPasswordMinter();

    expect(first).not.toBe(second);
    // 32 bytes, base64url: 43 characters, no padding, URL-safe alphabet.
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(first)).toBe(true);
    // A crude entropy floor that a constant, a counter, or a timestamp would
    // all fail.
    expect(new Set(first).size).toBeGreaterThan(16);
  });
});
