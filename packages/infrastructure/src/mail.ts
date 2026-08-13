/**
 * Mail INTENT: templates, mail-domain enablement, and the mailboxes a domain
 * should have (Phase 7 milestone 2, loxep-lmy.2).
 *
 * The same two properties `domains.ts` exists to guarantee hold here, and break
 * just as silently:
 *
 * 1. **Intent change and job enqueue commit atomically** — the enqueuer is a
 *    port taking the transaction handle, never a pool client.
 * 2. **`managed_domains.state` is written only by the reconciler.** No function
 *    in this module sets it. Enabling mail changes intent; `mail-sync.ts` moves
 *    the state.
 *
 * ## Templates are data, and that is the whole point
 *
 * > `mailbox_templates` is what makes "provision the standard addresses"
 * > data-driven. Edit the template once and every future domain picks it up;
 * > the alternative is a hardcoded list in the materializer that nobody can
 * > change without a deploy.
 *
 * So this module ships **no default template contents**. Not an empty default
 * as an oversight — a deliberate refusal, for the same reason milestone 1's CAA
 * policy ships with no issuer list: a guessed `postmaster`/`abuse`/`hostmaster`
 * set that half-matches an operator's convention is worse than no set at all,
 * because it looks configured. {@link createMailboxTemplatesService} makes
 * creating one a single call, and the standard addresses an installation wants
 * are an operator decision.
 *
 * ## Applying a template is a MERGE, never a replacement
 *
 * {@link MailDomainsService.applyTemplate} adds the template's addresses that
 * the domain does not have and RESURRECTS ones that were soft-deleted. It never
 * removes a mailbox the template does not mention, because a mailbox holds
 * mail: the `dns_records` soft-delete analogy carries the shape but not the
 * stakes, and "the template changed, so delete three mailboxes" is not an
 * inference any system should make unattended. Removal is
 * {@link MailDomainsService.removeMailbox} — an explicit operator act.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  mailDomains,
  mailboxTemplateEntries,
  mailboxTemplates,
  mailboxes,
  managedDomains,
} from "@loxep/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { domainJobKey, type TransactionalEnqueue } from "./domains.ts";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
} from "./errors.ts";

export type MailboxTemplateRow = typeof mailboxTemplates.$inferSelect;
export type MailboxTemplateEntryRow =
  typeof mailboxTemplateEntries.$inferSelect;
export type MailDomainRow = typeof mailDomains.$inferSelect;
export type MailboxRow = typeof mailboxes.$inferSelect;

/** `audit_events.resource_type` values this module writes. */
export const MAILBOX_TEMPLATE_RESOURCE_TYPE = "mailbox_template";
export const MAIL_DOMAIN_RESOURCE_TYPE = "mail_domain";
export const MAILBOX_RESOURCE_TYPE = "mailbox";

/**
 * Graphile task names, per the design's job graph:
 *
 * ```text
 * infrastructure.ensure-mail-domain   provision, mail on   key domain:{id}:mail
 * infrastructure.poll-mail-ownership  after records_synced, GATED ON DELEGATION
 *                                                          key domain:{id}:mailverify
 * infrastructure.sync-mailboxes       after verified       key domain:{id}:mailboxes
 * ```
 */
export const ENSURE_MAIL_DOMAIN_TASK = "infrastructure.ensure-mail-domain";
export const POLL_MAIL_OWNERSHIP_TASK = "infrastructure.poll-mail-ownership";
export const SYNC_MAILBOXES_TASK = "infrastructure.sync-mailboxes";

/**
 * A local part, validated shallowly and lower-cased.
 *
 * Deliberately not an exhaustive RFC 5321 grammar — the provider is the
 * authority on what it will accept. What IS enforced is the pair of shapes that
 * silently break a natural key: a case difference (the `unique(domain_id,
 * local_part)` would treat `Postmaster` and `postmaster` as two mailboxes, and
 * mail delivery would treat them as one) and an embedded `@`, which would make
 * `local_part@domain` produce an address with two of them.
 */
const localPartSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => !value.includes("@"), {
    message: "a mailbox local part must not contain '@'",
  })
  .refine((value) => !/\s/.test(value), {
    message: "a mailbox local part must not contain whitespace",
  });

/** A forwarding address. Same shallow treatment, plus "it has an @". */
const forwardToSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .transform((value) => value.toLowerCase())
  .refine((value) => value.includes("@"), {
    message: "a forwarding address must contain '@'",
  });

const mailboxKindSchema = z.enum(["mailbox", "alias", "catchall"]);

/**
 * The kind/forward-to biconditional the schema also enforces, checked here so
 * the error is a legible domain error rather than a constraint violation.
 */
function assertKindShape(input: {
  kind: "mailbox" | "alias" | "catchall";
  forwardTo: string | null;
}): void {
  const forwards = input.kind === "alias" || input.kind === "catchall";
  if (forwards && input.forwardTo === null) {
    throw new InfrastructureValidationError(
      `a "${input.kind}" needs a forwarding address`,
      { kind: input.kind },
    );
  }
  if (!forwards && input.forwardTo !== null) {
    throw new InfrastructureValidationError(
      "a real mailbox must not carry a forwarding address",
      { kind: input.kind },
    );
  }
}

/* ----------------------------------------------------------- templates --- */

const templateEntryInputSchema = z.strictObject({
  localPart: localPartSchema,
  kind: mailboxKindSchema,
  forwardTo: forwardToSchema.nullish(),
  generatePassword: z.boolean().optional(),
});

export type MailboxTemplateEntryInput = z.input<
  typeof templateEntryInputSchema
>;

const createTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
  entries: z.array(templateEntryInputSchema).optional(),
  actorUserId: z.string().min(1).nullish(),
});

export type CreateMailboxTemplateInput = z.input<typeof createTemplateSchema>;

export interface MailboxTemplatesService {
  create(input: CreateMailboxTemplateInput): Promise<MailboxTemplateRow>;
  get(id: string): Promise<MailboxTemplateRow>;
  list(): Promise<MailboxTemplateRow[]>;
  /** The one template marked default, or `null`. At most one can exist. */
  findDefault(): Promise<MailboxTemplateRow | null>;
  listEntries(templateId: string): Promise<MailboxTemplateEntryRow[]>;
  addEntry(
    templateId: string,
    input: MailboxTemplateEntryInput,
    options?: { actorUserId?: string | null },
  ): Promise<MailboxTemplateEntryRow>;
  removeEntry(entryId: string): Promise<void>;
}

export function createMailboxTemplatesService(options: {
  db: LoxepDb;
}): MailboxTemplatesService {
  const { db } = options;

  async function requireTemplate(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<MailboxTemplateRow> {
    const rows = await executor
      .select()
      .from(mailboxTemplates)
      .where(eq(mailboxTemplates.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`mailbox template ${id} not found`, {
        id,
      });
    }
    return row;
  }

  return {
    async create(input) {
      const parsed = createTemplateSchema.parse(input);
      for (const entry of parsed.entries ?? []) {
        assertKindShape({ kind: entry.kind, forwardTo: entry.forwardTo ?? null });
      }

      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(mailboxTemplates)
          .values({
            name: parsed.name,
            ...(parsed.isDefault === undefined
              ? {}
              : { isDefault: parsed.isDefault }),
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("mailbox template insert returned no row");
        }

        for (const entry of parsed.entries ?? []) {
          await tx.insert(mailboxTemplateEntries).values({
            templateId: row.id,
            localPart: entry.localPart,
            kind: entry.kind,
            forwardTo: entry.forwardTo ?? null,
            ...(entry.generatePassword === undefined
              ? {}
              : { generatePassword: entry.generatePassword }),
          });
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.mailbox_template.create",
          resourceType: MAILBOX_TEMPLATE_RESOURCE_TYPE,
          resourceId: row.id,
          after: {
            name: row.name,
            isDefault: row.isDefault,
            entryCount: (parsed.entries ?? []).length,
          },
        });

        return row;
      });
    },

    async get(id) {
      return requireTemplate(db, id);
    },

    async list() {
      return db.select().from(mailboxTemplates);
    },

    async findDefault() {
      const rows = await db
        .select()
        .from(mailboxTemplates)
        .where(eq(mailboxTemplates.isDefault, true));
      return rows[0] ?? null;
    },

    async listEntries(templateId) {
      return db
        .select()
        .from(mailboxTemplateEntries)
        .where(eq(mailboxTemplateEntries.templateId, templateId));
    },

    async addEntry(templateId, input, entryOptions) {
      const parsed = templateEntryInputSchema.parse(input);
      assertKindShape({ kind: parsed.kind, forwardTo: parsed.forwardTo ?? null });

      return db.transaction(async (tx) => {
        await requireTemplate(tx, templateId);
        const rows = await tx
          .insert(mailboxTemplateEntries)
          .values({
            templateId,
            localPart: parsed.localPart,
            kind: parsed.kind,
            forwardTo: parsed.forwardTo ?? null,
            ...(parsed.generatePassword === undefined
              ? {}
              : { generatePassword: parsed.generatePassword }),
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("mailbox template entry insert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: entryOptions?.actorUserId ?? null,
          action: "infrastructure.mailbox_template.add_entry",
          resourceType: MAILBOX_TEMPLATE_RESOURCE_TYPE,
          resourceId: templateId,
          after: { localPart: row.localPart, kind: row.kind },
        });

        return row;
      });
    },

    async removeEntry(entryId) {
      await db
        .delete(mailboxTemplateEntries)
        .where(eq(mailboxTemplateEntries.id, entryId));
    },
  };
}

/* --------------------------------------------------------- mail domains --- */

const enableMailSchema = z.strictObject({
  mailConnectionId: z.string().uuid(),
  actorUserId: z.string().min(1).nullish(),
});

export type EnableMailInput = z.input<typeof enableMailSchema>;

const mailboxInputSchema = z.strictObject({
  localPart: localPartSchema,
  kind: mailboxKindSchema,
  forwardTo: forwardToSchema.nullish(),
  actorUserId: z.string().min(1).nullish(),
});

export type MailboxInput = z.input<typeof mailboxInputSchema>;

export interface ApplyTemplateResult {
  created: number;
  resurrected: number;
  /** Addresses the domain already had, left exactly as they were. */
  unchanged: number;
}

export interface MailDomainsService {
  /**
   * Register the INTENT to host mail for a domain at a provider connection,
   * and enqueue the reconciler. Idempotent: enabling twice re-enqueues rather
   * than failing, because "make it so" is the operator's meaning both times.
   */
  enableMail(domainId: string, input: EnableMailInput): Promise<MailDomainRow>;
  get(domainId: string): Promise<MailDomainRow>;
  find(domainId: string): Promise<MailDomainRow | null>;
  /** Every domain whose ownership is not yet verified — the poll's work list. */
  listUnverified(): Promise<MailDomainRow[]>;
  listMailboxes(domainId: string): Promise<MailboxRow[]>;
  addMailbox(
    domainId: string,
    input: MailboxInput,
  ): Promise<MailboxRow>;
  /** Soft-delete: intent becomes "remove this at the provider". */
  removeMailbox(
    mailboxId: string,
    options?: { actorUserId?: string | null },
  ): Promise<MailboxRow>;
  /** MERGE a template's addresses into a domain. Never removes. */
  applyTemplate(
    domainId: string,
    templateId?: string,
    options?: { actorUserId?: string | null },
  ): Promise<ApplyTemplateResult>;
}

export function createMailDomainsService(options: {
  db: LoxepDb;
  enqueue?: TransactionalEnqueue;
}): MailDomainsService {
  const { db } = options;
  const enqueue: TransactionalEnqueue =
    options.enqueue ?? (async () => undefined);
  const templates = createMailboxTemplatesService({ db });

  async function requireDomain(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<typeof managedDomains.$inferSelect> {
    const rows = await executor
      .select()
      .from(managedDomains)
      .where(eq(managedDomains.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`managed domain ${id} not found`, {
        id,
      });
    }
    return row;
  }

  return {
    async enableMail(domainId, input) {
      const parsed = enableMailSchema.parse(input);

      return db.transaction(async (tx) => {
        const domain = await requireDomain(tx, domainId);
        if (!domain.mailEnabled) {
          throw new InfrastructureValidationError(
            `managed domain "${domain.name}" has mail_enabled = false; turn mail on before registering it with a provider`,
            { domainId },
          );
        }

        const rows = await tx
          .insert(mailDomains)
          .values({
            domainId,
            mailConnectionId: parsed.mailConnectionId,
          })
          .onConflictDoUpdate({
            target: mailDomains.domainId,
            set: {
              mailConnectionId: parsed.mailConnectionId,
              updatedAt: new Date(),
            },
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("mail domain upsert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.mail_domain.enable",
          resourceType: MAIL_DOMAIN_RESOURCE_TYPE,
          resourceId: domainId,
          after: {
            domain: domain.name,
            mailConnectionId: row.mailConnectionId,
          },
        });

        // Same transaction. This is the whole point.
        await enqueue(
          tx,
          ENSURE_MAIL_DOMAIN_TASK,
          { domainId },
          { jobKey: domainJobKey(ENSURE_MAIL_DOMAIN_TASK, domainId) },
        );

        return row;
      });
    },

    async get(domainId) {
      const rows = await db
        .select()
        .from(mailDomains)
        .where(eq(mailDomains.domainId, domainId));
      const row = rows[0];
      if (row === undefined) {
        throw new InfrastructureNotFoundError(
          `managed domain ${domainId} has no mail registration`,
          { domainId },
        );
      }
      return row;
    },

    async find(domainId) {
      const rows = await db
        .select()
        .from(mailDomains)
        .where(eq(mailDomains.domainId, domainId));
      return rows[0] ?? null;
    },

    async listUnverified() {
      return db
        .select()
        .from(mailDomains)
        .where(isNull(mailDomains.ownershipVerifiedAt));
    },

    async listMailboxes(domainId) {
      return db
        .select()
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.domainId, domainId),
            isNull(mailboxes.desiredDeletedAt),
          ),
        );
    },

    async addMailbox(domainId, input) {
      const parsed = mailboxInputSchema.parse(input);
      assertKindShape({ kind: parsed.kind, forwardTo: parsed.forwardTo ?? null });

      return db.transaction(async (tx) => {
        await requireDomain(tx, domainId);
        // RESURRECT rather than insert: the unique covers tombstones, exactly
        // as `dns_records`' natural key does (open question 7's resolution).
        const rows = await tx
          .insert(mailboxes)
          .values({
            domainId,
            localPart: parsed.localPart,
            kind: parsed.kind,
            forwardTo: parsed.forwardTo ?? null,
          })
          .onConflictDoUpdate({
            target: [mailboxes.domainId, mailboxes.localPart],
            set: {
              desiredDeletedAt: null,
              kind: parsed.kind,
              forwardTo: parsed.forwardTo ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("mailbox upsert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.mailbox.add",
          resourceType: MAILBOX_RESOURCE_TYPE,
          resourceId: row.id,
          after: { localPart: row.localPart, kind: row.kind },
        });

        await enqueue(
          tx,
          SYNC_MAILBOXES_TASK,
          { domainId },
          { jobKey: domainJobKey(SYNC_MAILBOXES_TASK, domainId) },
        );

        return row;
      });
    },

    async removeMailbox(mailboxId, removeOptions) {
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId));
        const before = existing[0];
        if (before === undefined) {
          throw new InfrastructureNotFoundError(
            `mailbox ${mailboxId} not found`,
            { mailboxId },
          );
        }
        const now = new Date();
        const rows = await tx
          .update(mailboxes)
          .set({ desiredDeletedAt: now, updatedAt: now })
          .where(eq(mailboxes.id, mailboxId))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("mailbox soft delete returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: removeOptions?.actorUserId ?? null,
          action: "infrastructure.mailbox.remove",
          resourceType: MAILBOX_RESOURCE_TYPE,
          resourceId: mailboxId,
          before: { localPart: before.localPart, kind: before.kind },
          after: { desiredDeleted: true },
        });

        await enqueue(
          tx,
          SYNC_MAILBOXES_TASK,
          { domainId: before.domainId },
          { jobKey: domainJobKey(SYNC_MAILBOXES_TASK, before.domainId) },
        );

        return row;
      });
    },

    async applyTemplate(domainId, templateId, applyOptions) {
      const domain = await requireDomain(db, domainId);
      const resolvedTemplateId =
        templateId ?? domain.mailboxTemplateId ?? (await templates.findDefault())?.id;
      if (resolvedTemplateId === undefined || resolvedTemplateId === null) {
        throw new InfrastructureValidationError(
          `no mailbox template supplied for "${domain.name}", and no default template exists`,
          { domainId },
        );
      }
      const entries = await templates.listEntries(resolvedTemplateId);
      if (entries.length === 0) {
        // An empty template is almost certainly a half-finished one. Applying
        // it would report "0 created" and look like success.
        throw new InfrastructureValidationError(
          `mailbox template ${resolvedTemplateId} has no entries`,
          { templateId: resolvedTemplateId },
        );
      }

      let created = 0;
      let resurrected = 0;
      let unchanged = 0;

      await db.transaction(async (tx) => {
        // Read INSIDE the transaction that writes. The upsert is safe either
        // way, but a snapshot taken outside it lets a concurrent `addMailbox`
        // land between the read and the writes and make the returned
        // created/resurrected counts describe a world that never existed.
        // Counters are reset here rather than outside so a retried transaction
        // body cannot double-count.
        created = 0;
        resurrected = 0;
        unchanged = 0;

        const existing = await tx
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.domainId, domainId));
        const byLocalPart = new Map(
          existing.map((row) => [row.localPart, row]),
        );

        const now = new Date();
        for (const entry of entries) {
          const current = byLocalPart.get(entry.localPart);
          if (current !== undefined && current.desiredDeletedAt === null) {
            unchanged += 1;
            continue;
          }
          await tx
            .insert(mailboxes)
            .values({
              domainId,
              localPart: entry.localPart,
              kind: entry.kind,
              forwardTo: entry.forwardTo,
            })
            .onConflictDoUpdate({
              target: [mailboxes.domainId, mailboxes.localPart],
              set: {
                desiredDeletedAt: null,
                kind: entry.kind,
                forwardTo: entry.forwardTo,
                updatedAt: now,
              },
            });
          if (current === undefined) created += 1;
          else resurrected += 1;
        }

        // Deliberately NO removal pass. See the module doc: a mailbox holds
        // mail, and "the template no longer mentions it" is not a reason to
        // delete one.

        await createAuditService({ db: tx }).append({
          actorUserId: applyOptions?.actorUserId ?? null,
          action: "infrastructure.mail_domain.apply_template",
          resourceType: MAIL_DOMAIN_RESOURCE_TYPE,
          resourceId: domainId,
          after: {
            templateId: resolvedTemplateId,
            created,
            resurrected,
            unchanged,
          },
        });

        await enqueue(
          tx,
          SYNC_MAILBOXES_TASK,
          { domainId },
          { jobKey: domainJobKey(SYNC_MAILBOXES_TASK, domainId) },
        );
      });

      return { created, resurrected, unchanged };
    },
  };
}
