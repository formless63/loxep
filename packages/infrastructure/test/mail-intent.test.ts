/**
 * The mail INTENT services against real PostgreSQL: templates, mail
 * enablement, and the mailboxes a domain should have (milestone 2,
 * loxep-lmy.2).
 *
 * This file is the mail counterpart of `intent.test.ts` and asserts the same
 * two silent-when-broken properties, plus one that is specific to mail:
 *
 * 1. **Transactional enqueue.** `enableMail`, `addMailbox`, `removeMailbox`
 *    and `applyTemplate` all enqueue their task through the SAME transaction
 *    that wrote the intent. The rolled-back-transaction test below is the
 *    proof, because enqueueing through a separate pool client compiles just as
 *    well and loses the guarantee.
 * 2. **`managed_domains.state` is written only by the reconciler.** Nothing in
 *    `mail.ts` sets it; enabling mail changes intent and `mail-sync.ts` moves
 *    the state. Asserted rather than trusted.
 * 3. **Applying a template is a MERGE, never a replacement.** It creates,
 *    resurrects, and leaves alone — and it never removes. A mailbox holds
 *    mail, so "the template no longer mentions it" is not an inference any
 *    system should make unattended. Removal is an explicit operator act.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { makeWorkerUtils } from "graphile-worker";
import { sql } from "drizzle-orm";
import {
  ENSURE_MAIL_DOMAIN_TASK,
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  SYNC_MAILBOXES_TASK,
  createMailDomainsService,
  createMailboxTemplatesService,
  createManagedDomainsService,
  createRecordingEnqueue,
  createTransactionalEnqueue,
  domainJobKey,
  jobKeysInQueue,
} from "../src/index.ts";
import type {
  MailDomainsService,
  MailboxTemplatesService,
  ManagedDomainsService,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_mail_intent");
let handle: DbHandle;
let dnsConnectionId = "";
let mailConnectionId = "";
let templates: MailboxTemplatesService;
let mail: MailDomainsService;
let domains: ManagedDomainsService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // Install the Graphile Worker schema so `graphile_worker.add_job` exists.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.release();

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
  templates = createMailboxTemplatesService({ db: handle.db });
  mail = createMailDomainsService({
    db: handle.db,
    enqueue: createTransactionalEnqueue(),
  });
}, 180_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function freshDomain(
  options: { mailEnabled?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const name = `${nextName("mailintent")}.test`;
  const row = await domains.create({
    name,
    dnsConnectionId,
    ...(options.mailEnabled === undefined
      ? {}
      : { mailEnabled: options.mailEnabled }),
  });
  return { id: row.id, name };
}

/**
 * `mailbox_templates_default_uq` is a PARTIAL unique over `is_default`, so at
 * most one default may exist in the whole installation at any moment. Tests
 * that need to own the default clear it first rather than assuming they run
 * first.
 */
async function clearDefaultTemplates(): Promise<void> {
  await handle.pool.query(
    `update mailbox_templates set is_default = false where is_default`,
  );
}

async function auditActions(resourceId: string): Promise<string[]> {
  const rows = await handle.pool.query<{ action: string }>(
    `select action from audit_events where resource_id = $1 order by occurred_at`,
    [resourceId],
  );
  return rows.rows.map((row) => row.action);
}

async function mailboxRows(domainId: string): Promise<
  Array<{
    local_part: string;
    kind: string;
    forward_to: string | null;
    desired_deleted_at: Date | null;
  }>
> {
  const rows = await handle.pool.query<{
    local_part: string;
    kind: string;
    forward_to: string | null;
    desired_deleted_at: Date | null;
  }>(
    `select local_part, kind, forward_to, desired_deleted_at
       from mailboxes where domain_id = $1 order by local_part`,
    [domainId],
  );
  return rows.rows;
}

describe("mailbox templates — the standard addresses are DATA, not a hardcoded list", () => {
  it("creates a template with its entries in one transaction", async () => {
    const name = nextName("standard");
    const row = await templates.create({
      name,
      entries: [
        { localPart: "postmaster", kind: "mailbox", generatePassword: true },
        { localPart: "abuse", kind: "alias", forwardTo: "ops@example.test" },
      ],
    });
    expect(row.name).toBe(name);
    expect(row.isDefault).toBe(false);

    const entries = await templates.listEntries(row.id);
    expect(entries.map((entry) => entry.localPart).sort()).toEqual([
      "abuse",
      "postmaster",
    ]);
    expect(await auditActions(row.id)).toEqual([
      "infrastructure.mailbox_template.create",
    ]);
  });

  it("refuses a second template with the same NAME, because the name is how an operator picks one", async () => {
    const name = nextName("dupe");
    await templates.create({ name });
    const conflict = await templates.create({ name }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).not.toBeNull();
    expect(
      (conflict as { cause?: { constraint?: string } }).cause?.constraint,
    ).toBe("mailbox_templates_name_uq");
  });

  it("allows AT MOST ONE default template, so 'the default' is never ambiguous", async () => {
    // The partial unique index over `is_default`: two defaults would make
    // `findDefault()` return whichever row the planner happened to reach.
    await clearDefaultTemplates();
    const first = await templates.create({
      name: nextName("default"),
      isDefault: true,
    });
    expect((await templates.findDefault())?.id).toBe(first.id);

    const second = await templates
      .create({ name: nextName("default"), isDefault: true })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(second).not.toBeNull();
    expect(
      (second as { cause?: { constraint?: string } }).cause?.constraint,
    ).toBe("mailbox_templates_default_uq");
    await clearDefaultTemplates();
  });

  it("refuses an alias with no forwarding address, as a LEGIBLE domain error", async () => {
    // The schema's biconditional CHECK would also catch this, but as a
    // constraint violation. The service raises the domain error so the surface
    // that receives it can say what the operator did wrong.
    await expect(
      templates.create({
        name: nextName("bad-alias"),
        entries: [{ localPart: "abuse", kind: "alias" }],
      }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("refuses a REAL MAILBOX that carries a forwarding address — the other half of the biconditional", async () => {
    // Both halves matter: an alias with nowhere to forward silently drops
    // mail, and a mailbox with a forward is two delivery models at once.
    await expect(
      templates.create({
        name: nextName("bad-mailbox"),
        entries: [
          { localPart: "postmaster", kind: "mailbox", forwardTo: "x@y.test" },
        ],
      }),
    ).rejects.toThrow(/must not carry a forwarding address/);
  });

  it("requires a catch-all to say where it forwards, exactly like an alias", async () => {
    await expect(
      templates.create({
        name: nextName("bad-catchall"),
        entries: [{ localPart: "catchall", kind: "catchall" }],
      }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("LOWER-CASES a local part, because 'Postmaster' and 'postmaster' are one address, not two rows", async () => {
    // `unique(domain_id, local_part)` is case-SENSITIVE, but mail delivery is
    // not. Without normalization the pair would be two intent rows converging
    // on one mailbox, and the second create would fail at the provider.
    const template = await templates.create({
      name: nextName("case"),
      entries: [{ localPart: "  PostMaster  ", kind: "mailbox" }],
    });
    const entries = await templates.listEntries(template.id);
    expect(entries[0]?.localPart).toBe("postmaster");
  });

  it("refuses an '@' in a local part, which would produce an address with two of them", async () => {
    await expect(
      templates.create({
        name: nextName("at-sign"),
        entries: [{ localPart: "postmaster@example.test", kind: "mailbox" }],
      }),
    ).rejects.toThrow(/must not contain '@'/);
  });

  it("refuses whitespace inside a local part, which no provider would accept", async () => {
    await expect(
      templates.create({
        name: nextName("space"),
        entries: [{ localPart: "post master", kind: "mailbox" }],
      }),
    ).rejects.toThrow(/whitespace/);
  });

  it("refuses a forwarding address with no '@' in it", async () => {
    await expect(
      templates.create({
        name: nextName("bad-forward"),
        entries: [
          { localPart: "abuse", kind: "alias", forwardTo: "not-an-address" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("adds an entry to an existing template, and audits the change", async () => {
    const template = await templates.create({ name: nextName("grow") });
    const entry = await templates.addEntry(template.id, {
      localPart: "HOSTMASTER",
      kind: "mailbox",
    });
    expect(entry.localPart).toBe("hostmaster");
    expect(await auditActions(template.id)).toEqual([
      "infrastructure.mailbox_template.create",
      "infrastructure.mailbox_template.add_entry",
    ]);

    // The same biconditional applies on this path — one validation, two entry
    // points, so neither can drift.
    await expect(
      templates.addEntry(template.id, { localPart: "abuse", kind: "alias" }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("refuses the same local part twice in one template", async () => {
    const template = await templates.create({
      name: nextName("twice"),
      entries: [{ localPart: "postmaster", kind: "mailbox" }],
    });
    const conflict = await templates
      .addEntry(template.id, { localPart: "postmaster", kind: "mailbox" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(conflict).not.toBeNull();
    expect(
      (conflict as { cause?: { constraint?: string } }).cause?.constraint,
    ).toBe("mailbox_template_entries_local_part_uq");
  });

  it("reports a missing template as a NOT-FOUND rather than a null row", async () => {
    await expect(
      templates.get("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });

  it("removes one entry without disturbing the rest of the template", async () => {
    const template = await templates.create({
      name: nextName("shrink"),
      entries: [
        { localPart: "postmaster", kind: "mailbox" },
        { localPart: "abuse", kind: "alias", forwardTo: "ops@example.test" },
      ],
    });
    const entries = await templates.listEntries(template.id);
    const abuse = entries.find((entry) => entry.localPart === "abuse");
    await templates.removeEntry(abuse?.id ?? "");
    expect(
      (await templates.listEntries(template.id)).map((e) => e.localPart),
    ).toEqual(["postmaster"]);
  });
});

describe("enabling mail on a domain", () => {
  it("registers the INTENT to host mail at a provider connection", async () => {
    const domain = await freshDomain();
    const row = await mail.enableMail(domain.id, { mailConnectionId });
    expect(row.domainId).toBe(domain.id);
    expect(row.mailConnectionId).toBe(mailConnectionId);
    // Evidence columns are empty: intent says what should be, the reconciler
    // records what is.
    expect(row.providerAddedAt).toBeNull();
    expect(row.ownershipCode).toBeNull();
    expect(row.ownershipVerifiedAt).toBeNull();
    expect(row.verifyAttempts).toBe(0);
  });

  it("is IDEMPOTENT: enabling twice re-enqueues rather than failing", async () => {
    // "Make it so" is the operator's meaning both times, and `mail_domains`
    // has `domain_id` as its PRIMARY KEY, so a naive insert would raise.
    const domain = await freshDomain();
    await mail.enableMail(domain.id, { mailConnectionId });
    await expect(
      mail.enableMail(domain.id, { mailConnectionId }),
    ).resolves.toMatchObject({ domainId: domain.id });

    const count = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from mail_domains where domain_id = $1`,
      [domain.id],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("REFUSES a domain whose intent says mail_enabled = false", async () => {
    // Registering a domain at a mail provider that Loxep has been told not to
    // host mail for is a billable, visible act performed against intent.
    const domain = await freshDomain({ mailEnabled: false });
    await expect(
      mail.enableMail(domain.id, { mailConnectionId }),
    ).rejects.toThrow(/mail_enabled = false/);

    const count = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from mail_domains where domain_id = $1`,
      [domain.id],
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("reports an unknown domain as NOT FOUND", async () => {
    await expect(
      mail.enableMail("00000000-0000-0000-0000-000000000000", {
        mailConnectionId,
      }),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });

  it("writes an audit event for the enablement", async () => {
    const domain = await freshDomain();
    await mail.enableMail(domain.id, { mailConnectionId, actorUserId: null });
    expect(await auditActions(domain.id)).toContain(
      "infrastructure.mail_domain.enable",
    );
  });

  it("NEVER writes managed_domains.state — enabling mail is intent, not progress", async () => {
    // The reconciler owns `state`. If an intent service could advance it, the
    // product would show a domain as `mail_pending` before anything was asked
    // of a provider.
    const domain = await freshDomain();
    await mail.enableMail(domain.id, { mailConnectionId });
    const row = await handle.pool.query<{ state: string }>(
      `select state from managed_domains where id = $1`,
      [domain.id],
    );
    expect(row.rows[0]?.state).toBe("draft");
  });

  it("distinguishes 'no registration' from 'not verified yet' in its readers", async () => {
    const domain = await freshDomain();
    expect(await mail.find(domain.id)).toBeNull();
    await expect(mail.get(domain.id)).rejects.toThrow(
      InfrastructureNotFoundError,
    );

    await mail.enableMail(domain.id, { mailConnectionId });
    expect((await mail.get(domain.id)).domainId).toBe(domain.id);
    // The bounded poll's work list: everything not yet verified.
    const unverified = await mail.listUnverified();
    expect(unverified.map((row) => row.domainId)).toContain(domain.id);
  });
});

describe("mailboxes — intent for one domain's addresses", () => {
  it("adds a mailbox and normalizes its local part", async () => {
    const domain = await freshDomain();
    await mail.enableMail(domain.id, { mailConnectionId });
    const row = await mail.addMailbox(domain.id, {
      localPart: "PostMaster",
      kind: "mailbox",
    });
    expect(row.localPart).toBe("postmaster");
    expect(row.forwardTo).toBeNull();
    expect(row.providerCreatedAt).toBeNull();
    expect(await auditActions(row.id)).toEqual(["infrastructure.mailbox.add"]);
  });

  it("adds an alias with its forwarding address, and refuses one without", async () => {
    const domain = await freshDomain();
    const row = await mail.addMailbox(domain.id, {
      localPart: "abuse",
      kind: "alias",
      forwardTo: "OPS@example.test",
    });
    expect(row.forwardTo).toBe("ops@example.test");

    await expect(
      mail.addMailbox(domain.id, { localPart: "sales", kind: "alias" }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("RESURRECTS a re-added address rather than colliding with its tombstone", async () => {
    // `mailboxes_domain_local_part_uq` covers tombstones, exactly as
    // `dns_records`' natural key does (open question 7's resolution). An
    // insert would collide; the upsert clears `desired_deleted_at` instead.
    const domain = await freshDomain();
    const first = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    await mail.removeMailbox(first.id);
    const again = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    expect(again.id).toBe(first.id);
    expect(again.desiredDeletedAt).toBeNull();
    expect(await mailboxRows(domain.id)).toHaveLength(1);
  });

  it("SOFT-DELETES on removal, because a mailbox holds mail", async () => {
    const domain = await freshDomain();
    const row = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    const removed = await mail.removeMailbox(row.id, { actorUserId: null });
    expect(removed.desiredDeletedAt).not.toBeNull();

    // Gone from the live list, still present as a row the reconciler will act
    // on — the deletion is intent, not an accomplished fact.
    expect(await mail.listMailboxes(domain.id)).toHaveLength(0);
    expect(await mailboxRows(domain.id)).toHaveLength(1);
    expect(await auditActions(row.id)).toEqual([
      "infrastructure.mailbox.add",
      "infrastructure.mailbox.remove",
    ]);
  });

  it("reports removing an unknown mailbox as NOT FOUND", async () => {
    await expect(
      mail.removeMailbox("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });
});

describe("applyTemplate MERGES — it never removes", () => {
  async function templateWith(
    entries: Array<{
      localPart: string;
      kind: "mailbox" | "alias" | "catchall";
      forwardTo?: string;
    }>,
  ): Promise<string> {
    const row = await templates.create({
      name: nextName("apply"),
      entries: entries.map((entry) => ({
        localPart: entry.localPart,
        kind: entry.kind,
        ...(entry.forwardTo === undefined ? {} : { forwardTo: entry.forwardTo }),
      })),
    });
    return row.id;
  }

  it("creates every address the domain does not have yet", async () => {
    const domain = await freshDomain();
    const templateId = await templateWith([
      { localPart: "postmaster", kind: "mailbox" },
      { localPart: "abuse", kind: "alias", forwardTo: "ops@example.test" },
    ]);
    const result = await mail.applyTemplate(domain.id, templateId);
    expect(result).toEqual({ created: 2, resurrected: 0, unchanged: 0 });
    expect((await mailboxRows(domain.id)).map((row) => row.local_part)).toEqual([
      "abuse",
      "postmaster",
    ]);
    expect(await auditActions(domain.id)).toContain(
      "infrastructure.mail_domain.apply_template",
    );
  });

  it("RESURRECTS a soft-deleted address rather than colliding with its tombstone", async () => {
    const domain = await freshDomain();
    const templateId = await templateWith([
      { localPart: "postmaster", kind: "mailbox" },
    ]);
    await mail.applyTemplate(domain.id, templateId);
    const [row] = await mail.listMailboxes(domain.id);
    await mail.removeMailbox(row?.id ?? "");

    const result = await mail.applyTemplate(domain.id, templateId);
    expect(result).toEqual({ created: 0, resurrected: 1, unchanged: 0 });
    const rows = await mailboxRows(domain.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.desired_deleted_at).toBeNull();
  });

  it("leaves an existing address EXACTLY as it is, even where the template disagrees", async () => {
    // The operator turned `postmaster` into a forwarding alias by hand. A
    // merge that "corrected" it back to the template's shape would silently
    // redirect somebody's mail.
    const domain = await freshDomain();
    await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "alias",
      forwardTo: "ops@example.test",
    });
    const templateId = await templateWith([
      { localPart: "postmaster", kind: "mailbox" },
    ]);

    const result = await mail.applyTemplate(domain.id, templateId);
    expect(result).toEqual({ created: 0, resurrected: 0, unchanged: 1 });
    const rows = await mailboxRows(domain.id);
    expect(rows[0]?.kind).toBe("alias");
    expect(rows[0]?.forward_to).toBe("ops@example.test");
  });

  it("NEVER removes a mailbox the template does not mention", async () => {
    // The rule this whole describe exists for. A mailbox holds mail, so "the
    // template changed" is not a reason to delete one — that is
    // `removeMailbox`, an explicit operator act.
    const domain = await freshDomain();
    await mail.addMailbox(domain.id, {
      localPart: "william",
      kind: "mailbox",
    });
    const templateId = await templateWith([
      { localPart: "postmaster", kind: "mailbox" },
    ]);

    await mail.applyTemplate(domain.id, templateId);
    const rows = await mailboxRows(domain.id);
    expect(rows.map((row) => row.local_part)).toEqual([
      "postmaster",
      "william",
    ]);
    // And it is LIVE, not tombstoned — "removed later by the reconciler" would
    // be the same loss one run further away.
    expect(rows.every((row) => row.desired_deleted_at === null)).toBe(true);
  });

  it("REFUSES an empty template, because '0 created' would look like success", async () => {
    const domain = await freshDomain();
    const empty = await templates.create({ name: nextName("empty") });
    await expect(mail.applyTemplate(domain.id, empty.id)).rejects.toThrow(
      /no entries/,
    );
  });

  it("REFUSES to guess when no template is supplied and no default exists", async () => {
    await clearDefaultTemplates();
    const domain = await freshDomain();
    await expect(mail.applyTemplate(domain.id)).rejects.toThrow(
      /no default template exists/,
    );
  });

  it("falls back to the domain's own template, then to the default", async () => {
    await clearDefaultTemplates();
    const fallback = await templates.create({
      name: nextName("fallback"),
      isDefault: true,
      entries: [{ localPart: "postmaster", kind: "mailbox" }],
    });

    // No template supplied and none on the domain: the default answers.
    const usesDefault = await freshDomain();
    expect(await mail.applyTemplate(usesDefault.id)).toEqual({
      created: 1,
      resurrected: 0,
      unchanged: 0,
    });

    // A domain that names its own template uses that one instead.
    const own = await templates.create({
      name: nextName("own"),
      entries: [{ localPart: "hostmaster", kind: "mailbox" }],
    });
    const usesOwn = await freshDomain();
    await handle.pool.query(
      `update managed_domains set mailbox_template_id = $2 where id = $1`,
      [usesOwn.id, own.id],
    );
    await mail.applyTemplate(usesOwn.id);
    expect(
      (await mailboxRows(usesOwn.id)).map((row) => row.local_part),
    ).toEqual(["hostmaster"]);

    expect((await templates.findDefault())?.id).toBe(fallback.id);
    await clearDefaultTemplates();
  });
});

describe("the transactional-enqueue property", () => {
  it("enqueues ensure-mail-domain through the SAME transaction that enabled mail", async () => {
    const domain = await freshDomain();
    await mail.enableMail(domain.id, { mailConnectionId });
    const key = domainJobKey(ENSURE_MAIL_DOMAIN_TASK, domain.id);
    expect(await jobKeysInQueue(handle.db, key)).toEqual([key]);
  });

  it("enqueues sync-mailboxes for every write that changes what a domain's addresses should be", async () => {
    const domain = await freshDomain();
    const key = domainJobKey(SYNC_MAILBOXES_TASK, domain.id);

    const added = await mail.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    expect(await jobKeysInQueue(handle.db, key)).toEqual([key]);

    // Dedup by job key rather than stacking: three intent changes are one
    // pending convergence, not three.
    const templateId = (
      await templates.create({
        name: nextName("enqueue"),
        entries: [{ localPart: "abuse", kind: "alias", forwardTo: "o@e.test" }],
      })
    ).id;
    await mail.applyTemplate(domain.id, templateId);
    await mail.removeMailbox(added.id);
    expect(await jobKeysInQueue(handle.db, key)).toEqual([key]);
  });

  it("puts a domainId and NOTHING ELSE in a payload — never a connection id or a credential", async () => {
    // Configuration & Secrets rule 5. Graphile Worker payloads sit in a table
    // in cleartext and survive failure, and `mailConnectionId` is right there
    // in the input, which is exactly how it would end up in one.
    const recorder = createRecordingEnqueue();
    const service = createMailDomainsService({
      db: handle.db,
      enqueue: recorder,
    });
    const domain = await freshDomain();

    await service.enableMail(domain.id, { mailConnectionId });
    const mailbox = await service.addMailbox(domain.id, {
      localPart: "postmaster",
      kind: "mailbox",
    });
    await service.removeMailbox(mailbox.id);

    expect(recorder.calls.map((call) => call.taskName)).toEqual([
      ENSURE_MAIL_DOMAIN_TASK,
      SYNC_MAILBOXES_TASK,
      SYNC_MAILBOXES_TASK,
    ]);
    for (const call of recorder.calls) {
      expect(Object.keys(call.payload)).toEqual(["domainId"]);
      expect(call.payload).toEqual({ domainId: domain.id });
      expect(JSON.stringify(call.payload)).not.toContain(mailConnectionId);
    }
    expect(recorder.calls[0]?.jobKey).toBe(
      domainJobKey(ENSURE_MAIL_DOMAIN_TASK, domain.id),
    );
  });

  it("applyTemplate enqueues through its own transaction, not a separate client", async () => {
    const recorder = createRecordingEnqueue();
    const service = createMailDomainsService({
      db: handle.db,
      enqueue: recorder,
    });
    const domain = await freshDomain();
    const templateId = (
      await templates.create({
        name: nextName("tx"),
        entries: [{ localPart: "postmaster", kind: "mailbox" }],
      })
    ).id;

    await service.applyTemplate(domain.id, templateId);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.jobKey).toBe(
      domainJobKey(SYNC_MAILBOXES_TASK, domain.id),
    );
  });

  it("leaves NO JOB BEHIND when the mailbox intent change rolls back", async () => {
    // The guarantee ADR-0003 chose Graphile Worker for, asserted for the mail
    // half exactly as `intent.test.ts` asserts it for records: enqueueing
    // through a pool client instead of the transaction handle compiles just as
    // well and loses it silently.
    const domain = await freshDomain();
    const key = domainJobKey("infrastructure.mail-rollback-probe", domain.id);
    const enqueue = createTransactionalEnqueue();

    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into mailboxes (domain_id, local_part, kind)
              values (${domain.id}, 'rolled-back', 'mailbox')`,
        );
        await enqueue(tx, SYNC_MAILBOXES_TASK, { domainId: domain.id }, {
          jobKey: key,
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    expect(await jobKeysInQueue(handle.db, key)).toEqual([]);
    expect(await mailboxRows(domain.id)).toHaveLength(0);
  });
});
