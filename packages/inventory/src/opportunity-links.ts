/**
 * The opportunity-to-outcome linkage: the record that *this observation is why
 * we bought that box*.
 *
 * Half the machinery already existed — `market_events` carries a `rule_id`
 * stamp and a scored opportunity payload from Phase 2, and
 * `order_lines.marketplace_item_id` was added in Phase 3 precisely as the
 * Commerce ↔ Market Intelligence join. What was missing is the middle, and this
 * is only the middle.
 *
 * ## What this module deliberately is not
 *
 * **It is a linkage table, not analytics.** There are no aggregates, no
 * predicted-versus-actual columns, no model state, and no scores recomputed
 * here. The "did our opportunity scoring actually work" study is a Reporting
 * concern that joins these rows to the realized-contribution read model, and it
 * is not scheduled in any phase — the roadmap bullet asked for a foreign key,
 * so nobody should build an analytics subsystem under it.
 *
 * ## Two things that are frozen on write
 *
 * `score_at_link` and `target_price_amount` snapshot what we believed at the
 * moment of the decision. Opportunity rules are mutable configuration, and
 * editing a rule's weight next month must not retroactively rewrite how good
 * last month's decision looked. Same argument as stored entity attribution,
 * applied to a different mutable input.
 *
 * `opportunity_rule_id` is written as a plain uuid with NO foreign key, exactly
 * matching the `market_events.rule_id` precedent: it is a historical
 * attribution stamp, and deleting a rule must never block, cascade into, or
 * rewrite recorded history.
 */
import type { LoxepDb } from "@loxep/db";
import { acquisitionOpportunityLinks } from "@loxep/db/schema";
import { z } from "zod";
import { InventoryConflictError, InventoryNotFoundError, InventoryValidationError } from "./errors.ts";
import { uuidLiteral } from "./sql.ts";

export type OpportunityLinkRow =
  typeof acquisitionOpportunityLinks.$inferSelect;

const linkSchema = z
  .strictObject({
    /**
     * `sourced_from` means the observation drove the purchase;
     * `evaluated_against` means we priced our decision using it; `comparable`
     * means it is a reference point found later. Collapsing them would make the
     * eventual scoring study meaningless.
     */
    linkKind: z.enum(["sourced_from", "evaluated_against", "comparable"]),
    acquisitionId: z.uuid().nullish(),
    inventoryItemId: z.uuid().nullish(),
    marketEventId: z.uuid().nullish(),
    marketplaceItemId: z.uuid().nullish(),
    opportunityRuleId: z.uuid().nullish(),
    scoreAtLink: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string")
      .nullish(),
    targetCurrency: z.string().regex(/^[A-Za-z]{3}$/).nullish(),
    targetPriceAmount: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string")
      .nullish(),
    linkedAt: z.date().optional(),
    linkedByUserId: z.string().min(1).nullish(),
    note: z.string().nullish(),
  })
  .refine(
    (link) =>
      (link.acquisitionId !== undefined && link.acquisitionId !== null) ||
      (link.inventoryItemId !== undefined && link.inventoryItemId !== null),
    {
      message:
        "a link must name an acquisition, an inventory item, or both " +
        "(acq_opportunity_links_subject_check) — naming both is additional " +
        "information, not ambiguity",
    },
  )
  .refine(
    (link) =>
      (link.marketEventId !== undefined && link.marketEventId !== null) ||
      (link.marketplaceItemId !== undefined && link.marketplaceItemId !== null),
    {
      message:
        "a link must name a market event, a marketplace item, or both " +
        "(acq_opportunity_links_evidence_check)",
    },
  )
  .refine(
    (link) =>
      (link.targetPriceAmount === undefined ||
        link.targetPriceAmount === null) ===
      (link.targetCurrency === undefined || link.targetCurrency === null),
    {
      message:
        "a target price needs its currency: an amount with no currency is not " +
        "a price (no FX anywhere in Phase 4)",
      path: ["targetCurrency"],
    },
  );

export type LinkOpportunityInput = z.input<typeof linkSchema>;

export interface OpportunityLinksService {
  /**
   * Record one link. Idempotent against the design's two partial uniques:
   * re-linking the same (acquisition, event) or (item, event) pair returns the
   * existing row rather than raising, because an at-least-once job that links
   * twice has not made a mistake.
   */
  link: (input: LinkOpportunityInput) => Promise<OpportunityLinkRow>;
  unlink: (id: string) => Promise<{ removed: boolean }>;
  listForAcquisition: (acquisitionId: string) => Promise<OpportunityLinkRow[]>;
  listForItem: (inventoryItemId: string) => Promise<OpportunityLinkRow[]>;
  listForMarketEvent: (marketEventId: string) => Promise<OpportunityLinkRow[]>;
}

export function createOpportunityLinksService(options: {
  db: LoxepDb;
}): OpportunityLinksService {
  const { db } = options;

  return {
    link: async (input) => {
      const parsed = linkSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new InventoryValidationError(`invalid opportunity link: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        if (value.marketEventId !== undefined && value.marketEventId !== null) {
          const existing = await tx.query.acquisitionOpportunityLinks.findFirst({
            where: (table, { and, eq }) =>
              value.acquisitionId !== undefined && value.acquisitionId !== null
                ? and(
                    eq(table.acquisitionId, value.acquisitionId),
                    eq(table.marketEventId, value.marketEventId ?? ""),
                  )
                : and(
                    eq(table.inventoryItemId, value.inventoryItemId ?? ""),
                    eq(table.marketEventId, value.marketEventId ?? ""),
                  ),
          });
          if (existing !== undefined) return existing;
        }

        const rows = await tx
          .insert(acquisitionOpportunityLinks)
          .values({
            linkKind: value.linkKind,
            acquisitionId: value.acquisitionId ?? null,
            inventoryItemId: value.inventoryItemId ?? null,
            marketEventId: value.marketEventId ?? null,
            marketplaceItemId: value.marketplaceItemId ?? null,
            opportunityRuleId: value.opportunityRuleId ?? null,
            scoreAtLink: value.scoreAtLink ?? null,
            targetCurrency: value.targetCurrency?.toUpperCase() ?? null,
            targetPriceAmount: value.targetPriceAmount ?? null,
            linkedAt: value.linkedAt ?? new Date(),
            linkedByUserId: value.linkedByUserId ?? null,
            note: value.note ?? null,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new InventoryConflictError(
            "opportunity link insert returned no row",
          );
        }
        return row;
      });
    },

    unlink: async (id) => {
      const result = await db.execute(
        `delete from acquisition_opportunity_links
          where id = ${uuidLiteral(id)}
        returning id`,
      );
      if (result.rows.length === 0) {
        throw new InventoryNotFoundError(`unknown opportunity link "${id}"`);
      }
      return { removed: true };
    },

    listForAcquisition: (acquisitionId) =>
      db.query.acquisitionOpportunityLinks.findMany({
        where: (table, { eq }) => eq(table.acquisitionId, acquisitionId),
        orderBy: (table, { desc }) => [desc(table.linkedAt)],
      }),

    listForItem: (inventoryItemId) =>
      db.query.acquisitionOpportunityLinks.findMany({
        where: (table, { eq }) => eq(table.inventoryItemId, inventoryItemId),
        orderBy: (table, { desc }) => [desc(table.linkedAt)],
      }),

    listForMarketEvent: (marketEventId) =>
      db.query.acquisitionOpportunityLinks.findMany({
        where: (table, { eq }) => eq(table.marketEventId, marketEventId),
        orderBy: (table, { desc }) => [desc(table.linkedAt)],
      }),
  };
}
