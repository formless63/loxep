/**
 * `mailbox-admin.ts` against real PostgreSQL and a stubbed mail provider —
 * the per-row Purelymail mailbox/routing-rule verbs `mail-sync.ts`'s own
 * whole-domain convergence loop has no equivalent for (loxep-47o.11).
 *
 * Four claims this file exists to hold to:
 *
 * 1. **The destructive verbs are gated at `access_affecting` (2) EXPLICITLY,
 *    never `additive` (1).** A connection whose policy is `'additive'` — enough
 *    for `runMailboxSync`'s own tombstone-driven deletes — still refuses a
 *    direct `deleteMailboxNow`/`deleteRoutingRule`.
 * 2. **A typed-confirmation mismatch refuses INSIDE THE SERVICE**, package-
 *    testable with no running app, per the bead's own instruction.
 * 3. **Double-delete is a no-op with a ledger note, not an error.**
 * 4. **`deleteDomain` is never referenced anywhere in this module's source** —
 *    the boundary that keeps it permanently unreachable, asserted rather than
 *    reviewed (the dockhand `forbidden-verbs.test.ts` precedent, adapted: this
 *    package has no adapter object to introspect, so the assertion runs
 *    directly over the module's own source text).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createSettingsService, providerWritePolicySetting } from "@loxep/domain";
import {
  InfrastructureValidationError,
  ProviderCallError,
  createMailDomainsService,
  createMailboxAdminService,
  createManagedDomainsService,
} from "../src/index.ts";
import type {
  MailDomainsService,
  MailboxAdminService,
  ManagedDomainsService,
} from "../src/index.ts";
import {
  createScratchDb,
  createStubMailProvider,
  dropScratchDb,
  scratchDbName,
  silentLogger,
  type StubMailProvider,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_mailbox_admin");
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

async function newDomain(): Promise<{ id: string; name: string }> {
  seq += 1;
  const name = `mbadmin-${seq}.test`;
  const row = await domains.create({ name, dnsConnectionId });
  return { id: row.id, name };
}

function service(
  provider: StubMailProvider,
  overrides: Partial<Parameters<typeof createMailboxAdminService>[0]> = {},
): MailboxAdminService {
  return createMailboxAdminService({ db: handle.db, provider, ...overrides });
}

async function mailboxRow(mailboxId: string): Promise<{
  desired_deleted_at: Date | null;
  provider_created_at: Date | null;
}> {
  const rows = await handle.pool.query<{
    desired_deleted_at: Date | null;
    provider_created_at: Date | null;
  }>(`select desired_deleted_at, provider_created_at from mailboxes where id = $1`, [
    mailboxId,
  ]);
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no mailboxes row");
  return row;
}

async function runRow(runId: string): Promise<{
  status: string;
  subject_type: string;
  subject_id: string;
}> {
  const rows = await handle.pool.query<{
    status: string;
    subject_type: string;
    subject_id: string;
  }>(`select status, subject_type, subject_id from reconcile_runs where id = $1`, [
    runId,
  ]);
  const row = rows.rows[0];
  if (row === undefined) throw new Error("no reconcile_runs row");
  return row;
}

async function stepRows(
  runId: string,
): Promise<Array<{ step: string; status: string; error_code: string | null }>> {
  const rows = await handle.pool.query<{
    step: string;
    status: string;
    error_code: string | null;
  }>(
    `select step, status, error_code from reconcile_run_steps where run_id = $1 order by sequence`,
    [runId],
  );
  return rows.rows;
}

/* ============================================================ deleteMailboxNow */

describe("deleteMailboxNow", () => {
  it("refuses a confirmation mismatch BEFORE opening any run", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider({ users: [`postmaster@${domain.name}`] });
    const sync = service(provider);

    await expect(
      sync.deleteMailboxNow({
        domainId: domain.id,
        address: `postmaster@${domain.name}`,
        confirmationText: "not-the-address",
        trigger: "manual",
      }),
    ).rejects.toThrow(InfrastructureValidationError);

    // No provider call and no run row: this is pure input validation.
    expect(provider.calls.deleteUser).toBe(0);
    const runs = await handle.pool.query(`select count(*) as n from reconcile_runs`);
    expect(Number(runs.rows[0]?.n)).toBe(0);
  });

  it("is BLOCKED at the additive tier — never the tier runMailboxSync's own batch delete uses", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    const provider = createStubMailProvider({ users: [address] });
    const settings = createSettingsService({ db: handle.db });
    await settings.set(providerWritePolicySetting, { [mailConnectionId]: "additive" }, {});
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("write_policy_blocked");
    expect(provider.calls.deleteUser).toBe(0);
    const run = await runRow(result.runId);
    expect(run.status).toBe("partial");
    const steps = await stepRows(result.runId);
    expect(steps.find((step) => step.step === "delete-mailbox")?.status).toBe("blocked");
    expect(steps.find((step) => step.step === "delete-mailbox")?.error_code).toBe(
      "credential_scope",
    );
  });

  it("succeeds at access_affecting: deletes at the provider AND soft-deletes the Loxep row", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    const mailbox = await mail.addMailbox(domain.id, { localPart: "postmaster", kind: "mailbox" });
    const provider = createStubMailProvider({ users: [address] });
    const settings = createSettingsService({ db: handle.db });
    await settings.set(
      providerWritePolicySetting,
      { [mailConnectionId]: "access_affecting" },
      {},
    );
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toBe("deleted");
    expect(provider.calls.deleteUser).toBe(1);
    expect(provider.userAddresses()).not.toContain(address);

    const row = await mailboxRow(mailbox.id);
    expect(row.desired_deleted_at).not.toBeNull();
    expect(row.provider_created_at).toBeNull();
  });

  it("is IDEMPOTENT: a second delete is a no-op with a ledger note, never an error", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    await mail.addMailbox(domain.id, { localPart: "postmaster", kind: "mailbox" });
    const provider = createStubMailProvider({ users: [address] });
    const sync = service(provider);

    const first = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
    });
    expect(first.outcome).toBe("deleted");

    const second = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
    });

    expect(second.status).toBe("succeeded");
    expect(second.outcome).toBe("already_absent");
    // Short-circuited entirely: no second provider call at all.
    expect(provider.calls.deleteUser).toBe(1);
    const steps = await stepRows(second.runId);
    expect(steps.map((step) => step.step)).toEqual(["already-processed"]);
  });

  it("is idempotent even for a STRAY address with no Loxep mailboxes row at all", async () => {
    const domain = await newDomain();
    const address = `stray@${domain.name}`;
    const provider = createStubMailProvider({ users: [address] });
    const sync = service(provider);

    const first = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
    });
    expect(first.outcome).toBe("deleted");

    // Second call: the provider's own deleteUser now throws not_found, since
    // there is no Loxep row to short-circuit against.
    const second = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
    });
    expect(second.status).toBe("succeeded");
    expect(second.outcome).toBe("already_absent");
  });

  it("refuses an address that does not belong to the given domain", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const sync = service(provider);

    await expect(
      sync.deleteMailboxNow({
        domainId: domain.id,
        address: "postmaster@somewhere-else.test",
        confirmationText: "postmaster@somewhere-else.test",
        trigger: "manual",
      }),
    ).rejects.toThrow(/does not belong to domain/);
  });

  it("refuses a Loxep row that is a routing rule, not a mailbox — points at deleteRoutingRule", async () => {
    const domain = await newDomain();
    await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "ops@example.test",
    });
    const provider = createStubMailProvider();
    const sync = service(provider);

    await expect(
      sync.deleteMailboxNow({
        domainId: domain.id,
        address: `abuse@${domain.name}`,
        confirmationText: `abuse@${domain.name}`,
        trigger: "manual",
      }),
    ).rejects.toThrow(/use deleteRoutingRule/);
  });

  it("propagates a real provider fault as ProviderCallError and fails the run", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    await mail.addMailbox(domain.id, { localPart: "postmaster", kind: "mailbox" });
    const provider = createStubMailProvider({ users: [address] });
    provider.deleteUser = async () => {
      const error = new Error("outage") as Error & { kind: string };
      error.kind = "provider_unavailable";
      throw error;
    };
    const sync = service(provider);

    const error = await sync
      .deleteMailboxNow({
        domainId: domain.id,
        address,
        confirmationText: address,
        trigger: "manual",
      })
      .then(
        () => null,
        (raised: unknown) => raised,
      );
    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).kind).toBe("provider_unavailable");
  });
});

/* ============================================================ routing rules */

describe("createRoutingRule", () => {
  it("is BLOCKED at read_only (the default) and creates nothing", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const settings = createSettingsService({ db: handle.db });
    // Tests in this file share ONE mail connection row; reset explicitly
    // rather than relying on it never having been flipped by an earlier test.
    await settings.set(providerWritePolicySetting, {}, {});
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.createRoutingRule({
      domainId: domain.id,
      matchUser: "sales",
      targetAddresses: ["ops@example.test"],
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("write_policy_blocked");
    expect(provider.calls.createRoutingRule).toBe(0);
  });

  it("succeeds at additive tier — the same tier runMailboxSync's own rule creation uses", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const settings = createSettingsService({ db: handle.db });
    await settings.set(providerWritePolicySetting, { [mailConnectionId]: "additive" }, {});
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.createRoutingRule({
      domainId: domain.id,
      matchUser: "sales",
      targetAddresses: ["ops@example.test"],
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toBe("created");
    expect(provider.rules().map((rule) => rule.matchUser)).toEqual(["sales"]);
  });

  it("is IDEMPOTENT: a rule that already exists is reported, not duplicated", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    await provider.createRoutingRule({
      domainName: domain.name,
      matchUser: "sales",
      targetAddresses: ["ops@example.test"],
      catchall: false,
    });
    const beforeCreates = provider.calls.createRoutingRule;
    const sync = service(provider);

    const result = await sync.createRoutingRule({
      domainId: domain.id,
      matchUser: "sales",
      targetAddresses: ["ops@example.test"],
      trigger: "manual",
    });

    expect(result.outcome).toBe("already_exists");
    expect(provider.calls.createRoutingRule).toBe(beforeCreates);
  });
});

describe("deleteRoutingRule", () => {
  async function seedRule(domainName: string, provider: StubMailProvider): Promise<number> {
    await provider.createRoutingRule({
      domainName,
      matchUser: "sales",
      targetAddresses: ["ops@example.test"],
      catchall: false,
    });
    const rule = provider.rules().find((entry) => entry.matchUser === "sales");
    if (rule === undefined) throw new Error("seed rule not found");
    return rule.id;
  }

  it("is idempotent for an ALREADY-ABSENT rule — no confirmation required, no error", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const sync = service(provider);

    const result = await sync.deleteRoutingRule({
      domainId: domain.id,
      routingRuleId: 999_999,
      confirmationText: "irrelevant",
      trigger: "manual",
    });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toBe("already_absent");
  });

  it("refuses a confirmation mismatch against the rule's OWN match pattern, read fresh from the provider", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const routingRuleId = await seedRule(domain.name, provider);
    const sync = service(provider);

    await expect(
      sync.deleteRoutingRule({
        domainId: domain.id,
        routingRuleId,
        confirmationText: `sales@${domain.name}-typo`,
        trigger: "manual",
      }),
    ).rejects.toThrow(InfrastructureValidationError);
    // The rule is still there: refused before any write.
    expect(provider.calls.deleteRoutingRule).toBe(0);
  });

  it("is BLOCKED at additive — never the tier runMailboxSync's own batch delete uses", async () => {
    const domain = await newDomain();
    const provider = createStubMailProvider();
    const routingRuleId = await seedRule(domain.name, provider);
    const settings = createSettingsService({ db: handle.db });
    await settings.set(providerWritePolicySetting, { [mailConnectionId]: "additive" }, {});
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.deleteRoutingRule({
      domainId: domain.id,
      routingRuleId,
      confirmationText: `sales@${domain.name}`,
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("write_policy_blocked");
    expect(provider.calls.deleteRoutingRule).toBe(0);
  });

  it("succeeds at access_affecting, and soft-deletes the matching Loxep alias row", async () => {
    const domain = await newDomain();
    const alias = await mail.addMailbox(domain.id, {
      localPart: "sales",
      kind: "alias",
      forwardTo: "ops@example.test",
    });
    const provider = createStubMailProvider();
    const routingRuleId = await seedRule(domain.name, provider);
    const settings = createSettingsService({ db: handle.db });
    await settings.set(
      providerWritePolicySetting,
      { [mailConnectionId]: "access_affecting" },
      {},
    );
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.deleteRoutingRule({
      domainId: domain.id,
      routingRuleId,
      confirmationText: `sales@${domain.name}`,
      trigger: "manual",
      actorIsAdmin: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toBe("deleted");
    expect(provider.rules()).toEqual([]);
    const row = await mailboxRow(alias.id);
    expect(row.desired_deleted_at).not.toBeNull();
    expect(row.provider_created_at).toBeNull();
  });
});

/* =================================================== the write-authorization gate */

describe("the write-authorization gate", () => {
  it("blocks a known non-admin actor even when the connection's policy is permissive", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    const provider = createStubMailProvider({ users: [address] });
    const settings = createSettingsService({ db: handle.db });
    await settings.set(providerWritePolicySetting, { [mailConnectionId]: "lockout_class" }, {});
    const sync = service(provider, { connectionId: mailConnectionId, settings });

    const result = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
      actorIsAdmin: false,
    });

    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("write_policy_blocked");
    expect(provider.calls.deleteUser).toBe(0);
  });

  it("does nothing when connectionId is omitted, matching mail-sync.ts's own construction default", async () => {
    const domain = await newDomain();
    const address = `postmaster@${domain.name}`;
    const provider = createStubMailProvider({ users: [address] });
    const sync = service(provider);

    const result = await sync.deleteMailboxNow({
      domainId: domain.id,
      address,
      confirmationText: address,
      trigger: "manual",
    });
    expect(result.status).toBe("succeeded");
  });
});

/* ==================================================================== deleteDomain */

describe("THE BOUNDARY: deleteDomain is permanently unreachable from this module", () => {
  it("is never CALLED anywhere in mailbox-admin.ts — only named in its own doc comment, explaining the exclusion", () => {
    // Call-shaped (`deleteDomain(`), not the bare word: the module doc
    // deliberately NAMES `deleteDomain` (matching `operations.ts`'s own "listed
    // for completeness" precedent for `domain.delete`) to explain why it is
    // excluded, which a bare-word search would false-positive on.
    const path = fileURLToPath(new URL("../src/mailbox-admin.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("deleteDomain(");
    expect(source).not.toContain(".deleteDomain");
    // And it IS named — proving this test would catch a real regression
    // rather than passing vacuously against a file that never mentions it.
    expect(source).toContain("deleteDomain");
  });

  it("exposes exactly the three per-row verbs, and no modifyMailbox/deleteDomain member", async () => {
    const provider = createStubMailProvider();
    const sync = service(provider);
    expect(Object.keys(sync).sort()).toEqual([
      "createRoutingRule",
      "deleteMailboxNow",
      "deleteRoutingRule",
    ]);
  });

  it("the MailProviderPort this module drives has no deleteDomain/modifyUser member at all", () => {
    // Structural, not a spy: the port `mailbox-admin.ts` is typed against
    // (`mail-port.ts`) has no such members, so no call could reach them even
    // if this module's own source were edited to try.
    const path = fileURLToPath(new URL("../src/mail-port.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("deleteDomain");
    expect(source).not.toContain("modifyUser");
  });
});
