/**
 * Contacts and contact channels.
 *
 * ## One channel table, not `emails` plus `phones`
 *
 * Every channel answers the same four questions — what is it, whose is it, is
 * it primary, may we contact it — so three tables would multiply the schema to
 * gain nothing. The kind is a `CHECK`ed closed set and the shape is uniform.
 *
 * ## A channel belongs to a counterparty OR to a contact, never both
 *
 * `billing@acme.example` is the organization's; Jane's mobile is Jane's.
 * Allowing both would make "which email do we send the invoice to" ambiguous in
 * exactly the case that matters, so the database enforces
 * `num_nonnulls(counterparty_id, counterparty_contact_id) = 1` and this service
 * refuses the ambiguous input before it gets there.
 *
 * ## Uniqueness needs NULLS NOT DISTINCT, and both uniques have it
 *
 * Exactly one owner column is non-null, so under PostgreSQL's default null
 * handling `unique(counterparty_id, counterparty_contact_id, channel_kind,
 * normalized_value)` would permit the same channel twice — the duplicate it
 * exists to prevent. Migration 0006 declares it `NULLS NOT DISTINCT`, and the
 * partial primary-channel unique achieves the same thing through a
 * `coalesce(...)` expression index because Drizzle's `uniqueIndex` has no
 * `nullsNotDistinct()`.
 *
 * ## Opting out is a fact, not a deletion
 *
 * `optedOutAt` exists because a channel that must not be used is worth
 * recording, and deleting the row loses the fact and invites re-adding it.
 * Nothing in this slice sends anything; the column is here so that when
 * something does, the answer is already recorded.
 *
 * ## Data minimization
 *
 * This service holds what an operator deliberately typed for a party they do
 * business with. It does not harvest names, emails, or addresses out of
 * retained `provider_objects`, and nothing here reads a marketplace payload.
 * That is the posture Phase 3's open question 8 established and the WooCommerce
 * findings confirmed is a real concern, and it is a policy this slice keeps
 * rather than a limitation it works around.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { contactChannels, counterpartyContacts } from "@loxep/db/schema";
import type { ContactChannelKind } from "@loxep/db/schema";
import { z } from "zod";
import {
  CounterpartyNotFoundError,
  CounterpartyValidationError,
} from "./errors.ts";
import { normalizeChannelValue } from "./normalize.ts";
import { textLiteral, toDate, toDateOrNull, uuidLiteral } from "./sql.ts";

export type CounterpartyContactRow = typeof counterpartyContacts.$inferSelect;
export type ContactChannelRow = typeof contactChannels.$inferSelect;

const CHANNEL_KINDS = [
  "email",
  "phone",
  "mobile",
  "fax",
  "website",
  "marketplace_handle",
  "messaging",
  "other",
] as const satisfies readonly ContactChannelKind[];

const addContactSchema = z.strictObject({
  counterpartyId: z.uuid(),
  displayName: z.string().trim().min(1),
  roleTitle: z.string().trim().min(1).nullish(),
  isPrimary: z.boolean().default(false),
  status: z.enum(["active", "inactive"]).default("active"),
  notes: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type AddContactInput = z.input<typeof addContactSchema>;

const addChannelSchema = z
  .strictObject({
    counterpartyId: z.uuid().nullish(),
    counterpartyContactId: z.uuid().nullish(),
    channelKind: z.enum(CHANNEL_KINDS),
    value: z.string().trim().min(1),
    label: z.string().trim().min(1).nullish(),
    isPrimary: z.boolean().default(false),
    verifiedAt: z.date().nullish(),
    optedOutAt: z.date().nullish(),
    actorUserId: z.string().min(1).nullish(),
    requestId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      (input.counterpartyId !== undefined && input.counterpartyId !== null) !==
      (input.counterpartyContactId !== undefined &&
        input.counterpartyContactId !== null),
    {
      message:
        "a channel belongs to a counterparty OR to a contact, never both and " +
        "never neither (contact_channels_owner_check)",
      path: ["counterpartyId"],
    },
  );

export type AddChannelInput = z.input<typeof addChannelSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CounterpartyValidationError(`invalid contact input: ${issues}`);
  }
  return parsed.data;
}

export interface ContactsService {
  addContact: (input: AddContactInput) => Promise<CounterpartyContactRow>;
  updateContact: (input: {
    contactId: string;
    displayName?: string;
    roleTitle?: string | null;
    status?: "active" | "inactive";
    notes?: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartyContactRow>;
  /**
   * Promote one contact to primary, demoting the incumbent in the same
   * transaction.
   *
   * A partial unique (`where is_primary`) makes two primaries impossible, which
   * means "set this one primary" is a two-statement operation and must never be
   * two round trips.
   */
  setPrimaryContact: (input: {
    contactId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartyContactRow>;
  removeContact: (input: {
    contactId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  listContacts: (counterpartyId: string) => Promise<CounterpartyContactRow[]>;

  addChannel: (input: AddChannelInput) => Promise<ContactChannelRow>;
  /** Same promote-and-demote pair, scoped to (owner, kind). */
  setPrimaryChannel: (input: {
    channelId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ContactChannelRow>;
  /** Records that a channel must not be used. Never deletes the row. */
  optOut: (input: {
    channelId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<ContactChannelRow>;
  removeChannel: (input: {
    channelId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  /** Every channel for a party: its own, plus every one of its contacts'. */
  listChannels: (counterpartyId: string) => Promise<ContactChannelRow[]>;
}

export function createContactsService(options: {
  db: LoxepDb;
}): ContactsService {
  const { db } = options;

  async function loadContact(
    executor: Pick<LoxepDb, "execute">,
    contactId: string,
  ): Promise<CounterpartyContactRow> {
    const result = await executor.execute(
      `select * from counterparty_contacts where id = ${uuidLiteral(contactId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(`unknown contact "${contactId}"`);
    }
    return {
      id: row["id"] as string,
      counterpartyId: row["counterparty_id"] as string,
      displayName: row["display_name"] as string,
      roleTitle: (row["role_title"] as string | null) ?? null,
      isPrimary: row["is_primary"] as boolean,
      status: row["status"] as string,
      notes: (row["notes"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  function toChannelRow(row: Record<string, unknown>): ContactChannelRow {
    return {
      id: row["id"] as string,
      counterpartyId: (row["counterparty_id"] as string | null) ?? null,
      counterpartyContactId:
        (row["counterparty_contact_id"] as string | null) ?? null,
      channelKind: row["channel_kind"] as string,
      value: row["value"] as string,
      normalizedValue: row["normalized_value"] as string,
      label: (row["label"] as string | null) ?? null,
      isPrimary: row["is_primary"] as boolean,
      verifiedAt: toDateOrNull(row["verified_at"]),
      optedOutAt: toDateOrNull(row["opted_out_at"]),
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function loadChannel(
    executor: Pick<LoxepDb, "execute">,
    channelId: string,
  ): Promise<ContactChannelRow> {
    const result = await executor.execute(
      `select * from contact_channels where id = ${uuidLiteral(channelId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(`unknown channel "${channelId}"`);
    }
    return toChannelRow(row);
  }

  return {
    listContacts: async (counterpartyId) =>
      db.query.counterpartyContacts.findMany({
        where: (table, { eq }) => eq(table.counterpartyId, counterpartyId),
        orderBy: (table, { desc, asc }) => [
          desc(table.isPrimary),
          asc(table.displayName),
        ],
      }),

    addContact: async (input) => {
      const value = parse(addContactSchema, input);
      return db.transaction(async (tx) => {
        if (value.isPrimary) {
          // The partial unique would reject a second primary; demote first so
          // "add this contact as primary" means what an operator expects.
          await tx.execute(
            `update counterparty_contacts set is_primary = false, updated_at = now()
              where counterparty_id = ${uuidLiteral(value.counterpartyId)}
                and is_primary`,
          );
        }
        const inserted = await tx
          .insert(counterpartyContacts)
          .values({
            counterpartyId: value.counterpartyId,
            displayName: value.displayName,
            roleTitle: value.roleTitle ?? null,
            isPrimary: value.isPrimary,
            status: value.status,
            notes: value.notes ?? null,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new CounterpartyValidationError(
            "counterparty_contacts insert returned no row",
          );
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "counterparty.contact_added",
          resourceType: "counterparty",
          resourceId: value.counterpartyId,
          after: {
            contactId: row.id,
            displayName: row.displayName,
            isPrimary: row.isPrimary,
          },
          requestId: value.requestId ?? null,
        });
        return row;
      });
    },

    updateContact: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadContact(tx, input.contactId);
        const assignments = ["updated_at = now()"];
        if (input.displayName !== undefined) {
          assignments.push(`display_name = ${textLiteral(input.displayName)}`);
        }
        if (input.roleTitle !== undefined) {
          assignments.push(
            `role_title = ${input.roleTitle === null ? "null" : textLiteral(input.roleTitle)}`,
          );
        }
        if (input.status !== undefined) {
          assignments.push(`status = ${textLiteral(input.status)}`);
        }
        if (input.notes !== undefined) {
          assignments.push(
            `notes = ${input.notes === null ? "null" : textLiteral(input.notes)}`,
          );
        }
        await tx.execute(
          `update counterparty_contacts set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadContact(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.contact_updated",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          before: { displayName: before.displayName, status: before.status },
          after: { displayName: after.displayName, status: after.status },
          requestId: input.requestId ?? null,
          metadata: { contactId: before.id },
        });
        return after;
      }),

    setPrimaryContact: async (input) =>
      db.transaction(async (tx) => {
        const contact = await loadContact(tx, input.contactId);
        await tx.execute(
          `update counterparty_contacts set is_primary = false, updated_at = now()
            where counterparty_id = ${uuidLiteral(contact.counterpartyId)}
              and is_primary and id <> ${uuidLiteral(contact.id)}`,
        );
        await tx.execute(
          `update counterparty_contacts set is_primary = true, updated_at = now()
            where id = ${uuidLiteral(contact.id)}`,
        );
        const after = await loadContact(tx, contact.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.primary_contact_set",
          resourceType: "counterparty",
          resourceId: contact.counterpartyId,
          after: { contactId: contact.id },
          requestId: input.requestId ?? null,
        });
        return after;
      }),

    removeContact: async (input) =>
      db.transaction(async (tx) => {
        const contact = await loadContact(tx, input.contactId);
        // Channels owned by this contact cascade; roles that named it as
        // billing contact keep the role and null the reference, which is what
        // the FK's default no-action would NOT do — so the reference is
        // cleared explicitly first rather than failing the delete.
        await tx.execute(
          `update counterparty_entity_roles set billing_contact_id = null,
                  updated_at = now()
            where billing_contact_id = ${uuidLiteral(contact.id)}`,
        );
        await tx.execute(
          `delete from counterparty_contacts where id = ${uuidLiteral(contact.id)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.contact_removed",
          resourceType: "counterparty",
          resourceId: contact.counterpartyId,
          before: { contactId: contact.id, displayName: contact.displayName },
          requestId: input.requestId ?? null,
        });
      }),

    addChannel: async (input) => {
      const value = parse(addChannelSchema, input);
      const normalizedValue = normalizeChannelValue(
        value.channelKind,
        value.value,
      );
      if (normalizedValue === "") {
        throw new CounterpartyValidationError(
          `a ${value.channelKind} channel normalized to an empty string; ` +
            "there is nothing to match on",
        );
      }
      const ownerColumn =
        value.counterpartyId !== undefined && value.counterpartyId !== null
          ? "counterparty_id"
          : "counterparty_contact_id";
      const ownerId =
        value.counterpartyId ?? value.counterpartyContactId ?? "";

      return db.transaction(async (tx) => {
        if (value.isPrimary) {
          await tx.execute(
            `update contact_channels set is_primary = false, updated_at = now()
              where ${ownerColumn} = ${uuidLiteral(ownerId)}
                and channel_kind = ${textLiteral(value.channelKind)}
                and is_primary`,
          );
        }
        const inserted = await tx
          .insert(contactChannels)
          .values({
            counterpartyId: value.counterpartyId ?? null,
            counterpartyContactId: value.counterpartyContactId ?? null,
            channelKind: value.channelKind,
            value: value.value,
            normalizedValue,
            label: value.label ?? null,
            isPrimary: value.isPrimary,
            verifiedAt: value.verifiedAt ?? null,
            optedOutAt: value.optedOutAt ?? null,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new CounterpartyValidationError(
            "contact_channels insert returned no row",
          );
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "counterparty.channel_added",
          resourceType: "counterparty",
          resourceId: value.counterpartyId ?? null,
          // The VALUE is deliberately absent from the audit snapshot: an
          // audit row is not the place to duplicate a contact's email.
          after: {
            channelId: row.id,
            channelKind: row.channelKind,
            isPrimary: row.isPrimary,
            counterpartyContactId: row.counterpartyContactId,
          },
          requestId: value.requestId ?? null,
        });
        return row;
      });
    },

    setPrimaryChannel: async (input) =>
      db.transaction(async (tx) => {
        const channel = await loadChannel(tx, input.channelId);
        const ownerColumn =
          channel.counterpartyId !== null
            ? "counterparty_id"
            : "counterparty_contact_id";
        const ownerId =
          channel.counterpartyId ?? channel.counterpartyContactId ?? "";
        await tx.execute(
          `update contact_channels set is_primary = false, updated_at = now()
            where ${ownerColumn} = ${uuidLiteral(ownerId)}
              and channel_kind = ${textLiteral(channel.channelKind)}
              and is_primary and id <> ${uuidLiteral(channel.id)}`,
        );
        await tx.execute(
          `update contact_channels set is_primary = true, updated_at = now()
            where id = ${uuidLiteral(channel.id)}`,
        );
        const after = await loadChannel(tx, channel.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.primary_channel_set",
          resourceType: "counterparty",
          resourceId: channel.counterpartyId,
          after: { channelId: channel.id, channelKind: channel.channelKind },
          requestId: input.requestId ?? null,
        });
        return after;
      }),

    optOut: async (input) =>
      db.transaction(async (tx) => {
        const channel = await loadChannel(tx, input.channelId);
        await tx.execute(
          `update contact_channels
              set opted_out_at = coalesce(opted_out_at, now()),
                  updated_at = now()
            where id = ${uuidLiteral(channel.id)}`,
        );
        const after = await loadChannel(tx, channel.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.channel_opted_out",
          resourceType: "counterparty",
          resourceId: channel.counterpartyId,
          after: {
            channelId: channel.id,
            channelKind: channel.channelKind,
            optedOutAt: after.optedOutAt?.toISOString() ?? null,
          },
          requestId: input.requestId ?? null,
        });
        return after;
      }),

    removeChannel: async (input) =>
      db.transaction(async (tx) => {
        const channel = await loadChannel(tx, input.channelId);
        await tx.execute(
          `delete from contact_channels where id = ${uuidLiteral(channel.id)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.channel_removed",
          resourceType: "counterparty",
          resourceId: channel.counterpartyId,
          before: { channelId: channel.id, channelKind: channel.channelKind },
          requestId: input.requestId ?? null,
        });
      }),

    listChannels: async (counterpartyId) => {
      const result = await db.execute(
        `select ch.* from contact_channels ch
          where ch.counterparty_id = ${uuidLiteral(counterpartyId)}
             or ch.counterparty_contact_id in (
                  select id from counterparty_contacts
                   where counterparty_id = ${uuidLiteral(counterpartyId)})
          order by ch.channel_kind, ch.is_primary desc, ch.created_at`,
      );
      return result.rows.map(toChannelRow);
    },
  };
}
