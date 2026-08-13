/**
 * Acquisitions, their money components, and the lot cost allocation engine.
 *
 * ## The shape of the problem
 *
 * Goods arrive in lots, the lot's cost is often the only cost that was ever
 * quoted, and the contents of the lot are discovered over the following days or
 * weeks. A schema that assumes a purchase order with priced lines describes a
 * wholesale business Loxep is not built for. So an acquisition carries NO money
 * columns except `currency`: every number came from an operator typing
 * components into `acquisition_costs`, Loxep is the only authority, and storing
 * a total alongside them would create two sources for one number with no
 * external arbiter.
 *
 * ## The allocation engine
 *
 * ```text
 * equal            landed cost ÷ unit count
 * relative_value   share ∝ estimated_value_amount   (the recommended default)
 * weight           share ∝ cost_allocation_weight
 * manual           the operator enters each basis; the engine only checks the total
 * direct           cost_scope = 'item' rows only; no allocation happened
 * ```
 *
 * Rounding is a LARGEST-REMAINDER distribution, so the allocated shares sum to
 * the pool exactly with no residual cent left over or invented.
 *
 * The invariant the engine maintains, enforced HERE and deliberately **not** by
 * a database constraint:
 *
 * ```text
 * sum(inventory_items.landed_cost_amount for the lot)
 *   = sum(capitalized acquisition_costs for the lot)
 * ```
 *
 * It is not a constraint because it is legitimately FALSE for most of a lot's
 * life — a `pending` lot has costs and no items, a `provisional` lot is partly
 * unpacked. A `CHECK` or trigger would make normal operation impossible, which
 * is the same reasoning that kept Phase 3 from constraining `orders.total_amount`
 * against its lines. It is a reconciliation report plus a unit test instead; see
 * `profitability.ts`'s `costReconciliation`.
 *
 * ## Two things the engine refuses to do
 *
 * 1. **Rewrite a locked basis (design open question 5).** An item with
 *    `cost_basis_locked_at` set has already fed a realized-profitability figure,
 *    and rewriting it would retroactively change reported margin on a closed
 *    sale. Re-allocating a lot containing locked items redistributes only the
 *    unlocked remainder:
 *
 *    ```text
 *    allocatable pool = lot landed cost − sum(basis of locked items)
 *    ```
 *
 *    **If that pool is negative the re-allocation is refused and the conflict is
 *    shown. It is not silently clamped.**
 *
 * 2. **Convert a currency (design open question 8).** A lot bought in GBP can
 *    incur a USD freight charge, so costs carry their own currency. Only costs
 *    in the acquisition's currency are allocated; foreign-currency capitalized
 *    costs are REPORTED as excluded, never converted, exactly as
 *    `@loxep/commerce` reports `foreignCurrencyFeeCount`.
 */
import type { LoxepDb } from "@loxep/db";
import { acquisitionCosts, acquisitions } from "@loxep/db/schema";
import type { CostAllocationBasis } from "@loxep/db/schema";
import { z } from "zod";
import {
  resolveAcquisitionAttribution,
} from "./attribution.ts";
import { acquisitionReferenceCode, withCodeRetry } from "./codes.ts";
import {
  ZERO,
  clampNonNegative,
  compareDecimals,
  distributeByWeights,
  isNegative,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import {
  InventoryConflictError,
  InventoryImmutableFactError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import type { Executor } from "./movements.ts";
import { numericLiteral, textLiteral, uuidLiteral } from "./sql.ts";

export type AcquisitionRow = typeof acquisitions.$inferSelect;
export type AcquisitionCostRow = typeof acquisitionCosts.$inferSelect;

/* ---------------------------------------------------------------- schemas */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

const sourceKinds = [
  "auction_lot",
  "estate_sale",
  "thrift_retail",
  "retail_arbitrage",
  "liquidation_pallet",
  "wholesale_purchase",
  "online_marketplace",
  "trade_in",
  "consignment_intake",
  "personal_conversion",
  "customer_return",
  "found_stock",
  "other",
] as const;

const allocationBases = [
  "equal",
  "relative_value",
  "weight",
  "manual",
  "direct",
] as const;

const createAcquisitionSchema = z.strictObject({
  title: z.string().trim().min(1),
  sourceKind: z.enum(sourceKinds),
  currency: currencyCode,
  /** Overrides the generated `ACQ-…`; for imports of pre-existing labels. */
  referenceCode: z.string().trim().min(1).max(64).optional(),
  status: z.string().min(1).default("open"),
  economicEntityId: z.uuid().nullish(),
  installationDefaultEntityId: z.uuid().nullish(),
  connectionId: z.uuid().nullish(),
  vendorName: z.string().trim().min(1).nullish(),
  vendorLocation: z.string().trim().min(1).nullish(),
  externalReference: z.string().trim().min(1).nullish(),
  costAllocationBasis: z.enum(allocationBases).default("relative_value"),
  acquiredAt: z.date().optional(),
  receivedAt: z.date().nullish(),
  expectedItemCount: z.number().int().positive().nullish(),
  notes: z.string().nullish(),
  createdByUserId: z.string().min(1).nullish(),
});

export type CreateAcquisitionInput = z.input<typeof createAcquisitionSchema>;

const addCostSchema = z
  .strictObject({
    acquisitionId: z.uuid(),
    costType: z.string().trim().min(1),
    costClass: z.enum(["goods", "ancillary"]),
    amount: decimalString,
    currency: currencyCode.optional(),
    /** `item` scope requires an item; `lot` scope forbids one. */
    inventoryItemId: z.uuid().nullish(),
    capitalize: z.boolean().default(true),
    description: z.string().nullish(),
    vendorName: z.string().trim().min(1).nullish(),
    externalReference: z.string().trim().min(1).nullish(),
    incurredAt: z.date().nullish(),
    createdByUserId: z.string().min(1).nullish(),
  });

export type AddCostInput = z.input<typeof addCostSchema>;

/* ---------------------------------------------------------------- results */

/** Capitalized landed cost of a lot, grouped by currency. Never summed across. */
export interface LandedCostGroup {
  currency: string;
  goodsAmount: string;
  ancillaryAmount: string;
  /** `goods + ancillary`, capitalized rows only. */
  landedCostAmount: string;
  /** `capitalize = false` rows: real spend, excluded from basis (OQ10). */
  nonCapitalizedAmount: string;
}

export interface AllocationOutcome {
  acquisitionId: string;
  basis: CostAllocationBasis;
  currency: string;
  /** Capitalized lot-scoped costs in the acquisition currency. */
  lotPoolAmount: string;
  /** Portion of the pool already consumed by basis-locked items. */
  lockedAmount: string;
  /** `lotPoolAmount − lockedAmount`; what this run distributed. */
  allocatablePoolAmount: string;
  allocations: {
    inventoryItemId: string;
    itemCode: string;
    /** Item-scoped capitalized costs booked straight to this item. */
    directAmount: string;
    /** This item's share of the lot pool. */
    lotShareAmount: string;
    acquisitionCostAmount: string;
    landedCostAmount: string;
  }[];
  /** Items skipped because their basis is frozen (OQ5). */
  lockedItems: { inventoryItemId: string; itemCode: string; landedCostAmount: string }[];
  /**
   * Pool left undistributed because every weight was zero — reported, never
   * spread equally as a consolation. Non-zero blocks `finalize`.
   */
  unallocatedAmount: string;
  /** Capitalized costs in another currency, excluded rather than converted. */
  foreignCurrencyCostCount: number;
  costAllocationStatus: string;
}

export interface AcquisitionsService {
  create: (input: CreateAcquisitionInput) => Promise<AcquisitionRow>;
  get: (id: string) => Promise<AcquisitionRow>;
  addCost: (input: AddCostInput) => Promise<AcquisitionCostRow>;
  listCosts: (acquisitionId: string) => Promise<AcquisitionCostRow[]>;
  /** Capitalized landed cost by currency, plus the non-capitalized total. */
  landedCost: (acquisitionId: string) => Promise<LandedCostGroup[]>;
  /**
   * Spread the lot's capitalized costs across its unlocked items and write the
   * results onto the item rows. Idempotent: running it twice with the same
   * inputs produces the same basis.
   */
  allocateCosts: (input: {
    acquisitionId: string;
    basis?: CostAllocationBasis;
    /** Required for `manual`: the operator's own per-item landed basis. */
    manualAmounts?: { inventoryItemId: string; landedCostAmount: string }[];
    /** Mark the lot `final`. Refused while anything is unallocated. */
    finalize?: boolean;
  }) => Promise<AllocationOutcome>;
}

export function createAcquisitionsService(options: {
  db: LoxepDb;
}): AcquisitionsService {
  const { db } = options;

  async function get(id: string): Promise<AcquisitionRow> {
    const row = await db.query.acquisitions.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(`unknown acquisition "${id}"`);
    }
    return row;
  }

  return {
    get,

    create: async (input) => {
      const value = parse(createAcquisitionSchema, input, "acquisition");
      const now = new Date();
      const acquiredAt = value.acquiredAt ?? now;

      const connectionEntityId =
        value.connectionId === undefined || value.connectionId === null
          ? null
          : ((
              await db.query.connections.findFirst({
                where: (table, { eq }) => eq(table.id, value.connectionId ?? ""),
                columns: { economicEntityId: true },
              })
            )?.economicEntityId ?? null);

      const attribution = resolveAcquisitionAttribution({
        ...(value.economicEntityId === undefined
          ? {}
          : { explicitEntityId: value.economicEntityId }),
        ...(value.installationDefaultEntityId === undefined
          ? {}
          : { installationDefaultEntityId: value.installationDefaultEntityId }),
        connectionEntityId,
        actorUserId: value.createdByUserId ?? null,
        now,
      });

      return withCodeRetry(
        async (attempt) => {
          const referenceCode =
            value.referenceCode ??
            acquisitionReferenceCode(
              acquiredAt.getUTCFullYear(),
              (await nextSequence(db, acquiredAt.getUTCFullYear())) + attempt,
            );
          const rows = await db
            .insert(acquisitions)
            .values({
              economicEntityId: attribution.economicEntityId,
              entityAttributionSource: attribution.entityAttributionSource,
              entityAttributedAt: attribution.entityAttributedAt,
              entityAttributedByUserId: attribution.entityAttributedByUserId,
              sourceKind: value.sourceKind,
              status: value.status,
              referenceCode,
              title: value.title,
              vendorName: value.vendorName ?? null,
              vendorLocation: value.vendorLocation ?? null,
              externalReference: value.externalReference ?? null,
              connectionId: value.connectionId ?? null,
              currency: value.currency.toUpperCase(),
              costAllocationBasis: value.costAllocationBasis,
              costAllocationStatus: "pending",
              acquiredAt,
              receivedAt: value.receivedAt ?? null,
              expectedItemCount: value.expectedItemCount ?? null,
              notes: value.notes ?? null,
              createdByUserId: value.createdByUserId ?? null,
            })
            .returning();
          const row = rows[0];
          if (row === undefined) {
            throw new InventoryConflictError(
              "acquisition insert returned no row",
            );
          }
          return row;
        },
        {
          label: "acquisition reference code",
          onConstraint: "acquisitions_reference_code_uq",
        },
      );
    },

    addCost: async (input) => {
      const value = parse(addCostSchema, input, "acquisition cost");
      const acquisition = await get(value.acquisitionId);
      const scope =
        value.inventoryItemId === undefined || value.inventoryItemId === null
          ? "lot"
          : "item";
      if (scope === "item") {
        const item = await db.query.inventoryItems.findFirst({
          where: (table, { eq }) => eq(table.id, value.inventoryItemId ?? ""),
          columns: { id: true, costBasisLockedAt: true },
        });
        if (item === undefined) {
          throw new InventoryNotFoundError(
            `unknown inventory item "${value.inventoryItemId}"`,
          );
        }
      }
      const rows = await db
        .insert(acquisitionCosts)
        .values({
          acquisitionId: value.acquisitionId,
          inventoryItemId: value.inventoryItemId ?? null,
          costScope: scope,
          costType: value.costType,
          costClass: value.costClass,
          capitalize: value.capitalize,
          description: value.description ?? null,
          vendorName: value.vendorName ?? null,
          externalReference: value.externalReference ?? null,
          currency: (value.currency ?? acquisition.currency).toUpperCase(),
          amount: value.amount,
          incurredAt: value.incurredAt ?? null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new InventoryConflictError("cost insert returned no row");
      }
      return row;
    },

    listCosts: (acquisitionId) =>
      db.query.acquisitionCosts.findMany({
        where: (table, { eq }) => eq(table.acquisitionId, acquisitionId),
        orderBy: (table, { asc }) => [asc(table.createdAt)],
      }),

    landedCost: async (acquisitionId) => {
      const result = await db.execute(
        `select currency,
                sum(amount) filter (where capitalize and cost_class = 'goods')
                  ::numeric(20, 6)::text as goods,
                sum(amount) filter (where capitalize and cost_class = 'ancillary')
                  ::numeric(20, 6)::text as ancillary,
                sum(amount) filter (where capitalize)
                  ::numeric(20, 6)::text as landed,
                sum(amount) filter (where not capitalize)
                  ::numeric(20, 6)::text as non_capitalized
           from acquisition_costs
          where acquisition_id = ${uuidLiteral(acquisitionId)}
          group by currency
          order by currency`,
      );
      return result.rows.map((row) => ({
        currency: row["currency"] as string,
        goodsAmount: decimalOrZero(row["goods"]),
        ancillaryAmount: decimalOrZero(row["ancillary"]),
        landedCostAmount: decimalOrZero(row["landed"]),
        nonCapitalizedAmount: decimalOrZero(row["non_capitalized"]),
      }));
    },

    allocateCosts: async (input) =>
      db.transaction((tx) => allocateCosts(tx, input)),
  };
}

/* ------------------------------------------------------ allocation engine */

interface AllocationItem {
  id: string;
  itemCode: string;
  quantity: string;
  estimatedValueAmount: string | null;
  costAllocationWeight: string | null;
  landedCostAmount: string;
  acquisitionCostAmount: string;
  locked: boolean;
}

async function allocateCosts(
  tx: Executor,
  input: {
    acquisitionId: string;
    basis?: CostAllocationBasis;
    manualAmounts?: { inventoryItemId: string; landedCostAmount: string }[];
    finalize?: boolean;
  },
): Promise<AllocationOutcome> {
  const acquisition = await tx.query.acquisitions.findFirst({
    where: (table, { eq }) => eq(table.id, input.acquisitionId),
  });
  if (acquisition === undefined) {
    throw new InventoryNotFoundError(
      `unknown acquisition "${input.acquisitionId}"`,
    );
  }
  const basis = (input.basis ??
    acquisition.costAllocationBasis) as CostAllocationBasis;
  const currency = acquisition.currency;

  const itemRows = await tx.execute(
    `select id::text as id, item_code, quantity::text as quantity,
            estimated_value_amount::text as estimated_value,
            cost_allocation_weight::text as weight,
            landed_cost_amount::text as landed,
            acquisition_cost_amount::text as goods,
            (cost_basis_locked_at is not null) as locked
       from inventory_items
      where acquisition_id = ${uuidLiteral(input.acquisitionId)}
      order by created_at, item_code`,
  );
  const items: AllocationItem[] = itemRows.rows.map((row) => ({
    id: row["id"] as string,
    itemCode: row["item_code"] as string,
    quantity: row["quantity"] as string,
    estimatedValueAmount: (row["estimated_value"] as string | null) ?? null,
    costAllocationWeight: (row["weight"] as string | null) ?? null,
    landedCostAmount: row["landed"] as string,
    acquisitionCostAmount: row["goods"] as string,
    locked: row["locked"] === true,
  }));

  const costs = await tx.query.acquisitionCosts.findMany({
    where: (table, { eq }) => eq(table.acquisitionId, input.acquisitionId),
  });
  const capitalized = costs.filter((cost) => cost.capitalize);
  const foreign = capitalized.filter((cost) => cost.currency !== currency);
  const local = capitalized.filter((cost) => cost.currency === currency);

  // Item-scoped costs belong to their item directly, whatever the basis is.
  const directGoods = new Map<string, string[]>();
  const directAncillary = new Map<string, string[]>();
  const lotGoods: string[] = [];
  const lotAncillary: string[] = [];
  for (const cost of local) {
    if (cost.costScope === "item" && cost.inventoryItemId !== null) {
      const bucket =
        cost.costClass === "goods" ? directGoods : directAncillary;
      bucket.set(cost.inventoryItemId, [
        ...(bucket.get(cost.inventoryItemId) ?? []),
        cost.amount,
      ]);
    } else if (cost.costClass === "goods") {
      lotGoods.push(cost.amount);
    } else {
      lotAncillary.push(cost.amount);
    }
  }
  const lotGoodsTotal = sumDecimals(lotGoods, ZERO);
  const lotAncillaryTotal = sumDecimals(lotAncillary, ZERO);
  const lotPool = sumDecimals([lotGoodsTotal, lotAncillaryTotal], ZERO);

  if (basis === "direct" && compareDecimals(lotPool, "0") !== 0) {
    throw new InventoryConflictError(
      `basis 'direct' means every cost was known per item, but this lot has ` +
        `${lotPool} ${currency} of lot-scoped capitalized cost. Either move ` +
        "those costs to items or choose an allocating basis.",
    );
  }

  const unlocked = items.filter((item) => !item.locked);
  const locked = items.filter((item) => item.locked);

  // The pool locked items already consumed is the part of THEIR basis that came
  // from the lot, i.e. their landed cost net of their own direct costs.
  const lockedLotShare = sumDecimals(
    locked.map((item) =>
      subtractDecimals(
        item.landedCostAmount,
        sumDecimals(
          [
            ...(directGoods.get(item.id) ?? []),
            ...(directAncillary.get(item.id) ?? []),
          ],
          ZERO,
        ),
      ),
    ),
    ZERO,
  );
  const allocatable = subtractDecimals(lotPool, lockedLotShare);
  if (isNegative(allocatable)) {
    throw new InventoryConflictError(
      `re-allocating this lot is refused: basis-locked items already hold ` +
        `${lockedLotShare} ${currency} of a ${lotPool} ${currency} lot pool, ` +
        `leaving ${allocatable}. The design does not silently clamp this — ` +
        "correct the individual locked item's basis explicitly, or add the " +
        "missing cost rows.",
    );
  }

  // Split the allocatable pool back into its goods and ancillary halves in the
  // same proportion the surviving pool has, so `acquisition_cost_amount`
  // (goods only) stays a meaningful subset of landed cost.
  const goodsAllocatable =
    compareDecimals(lotPool, "0") === 0
      ? ZERO
      : (distributeByWeights(allocatable, [lotGoodsTotal, lotAncillaryTotal])
          .shares[0] ?? ZERO);
  const ancillaryAllocatable = subtractDecimals(allocatable, goodsAllocatable);

  let outcome: AllocationOutcome["allocations"] = [];
  let unallocated = ZERO;

  if (basis === "manual") {
    const supplied = new Map(
      (input.manualAmounts ?? []).map((entry) => [
        entry.inventoryItemId,
        entry.landedCostAmount,
      ]),
    );
    for (const item of locked) {
      if (supplied.has(item.id)) {
        throw new InventoryImmutableFactError(
          `"${item.itemCode}" has a frozen cost basis and cannot be re-costed ` +
            "by a lot run: its basis has already fed a reported figure. Use " +
            "an explicit, audited per-item basis correction instead.",
        );
      }
    }
    for (const item of unlocked) {
      const amount = supplied.get(item.id);
      if (amount === undefined) {
        throw new InventoryValidationError(
          `basis 'manual' requires a landed cost for every unlocked item; ` +
            `"${item.itemCode}" has none`,
        );
      }
    }
    const total = sumDecimals(
      unlocked.map((item) => supplied.get(item.id) ?? ZERO),
      ZERO,
    );
    const expected = sumDecimals(
      [
        allocatable,
        ...unlocked.map((item) =>
          sumDecimals(
            [
              ...(directGoods.get(item.id) ?? []),
              ...(directAncillary.get(item.id) ?? []),
            ],
            ZERO,
          ),
        ),
      ],
      ZERO,
    );
    if (compareDecimals(total, expected) !== 0) {
      throw new InventoryConflictError(
        `manual basis totals ${total} ${currency} but the lot's allocatable ` +
          `capitalized cost is ${expected} ${currency}. The engine only checks ` +
          "the total, and this one does not reconcile.",
      );
    }
    outcome = unlocked.map((item) => {
      const landed = toMoneyString(supplied.get(item.id) ?? ZERO);
      const direct = sumDecimals(
        [
          ...(directGoods.get(item.id) ?? []),
          ...(directAncillary.get(item.id) ?? []),
        ],
        ZERO,
      );
      return {
        inventoryItemId: item.id,
        itemCode: item.itemCode,
        directAmount: toMoneyString(direct),
        lotShareAmount: subtractDecimals(landed, direct),
        // PROVISIONAL: for a manual basis the operator typed one number, and
        // Phase 4 does not guess a goods/ancillary split it was not given.
        acquisitionCostAmount: landed,
        landedCostAmount: landed,
      };
    });
  } else {
    const weights = unlocked.map((item) => weightFor(basis, item));
    const goodsShares = distributeByWeights(goodsAllocatable, weights);
    const ancillaryShares = distributeByWeights(ancillaryAllocatable, weights);
    unallocated = sumDecimals(
      [goodsShares.unallocated, ancillaryShares.unallocated],
      ZERO,
    );
    outcome = unlocked.map((item, index) => {
      const goodsDirect = sumDecimals(directGoods.get(item.id) ?? [], ZERO);
      const ancillaryDirect = sumDecimals(
        directAncillary.get(item.id) ?? [],
        ZERO,
      );
      const goodsShare = goodsShares.shares[index] ?? ZERO;
      const ancillaryShare = ancillaryShares.shares[index] ?? ZERO;
      const goods = sumDecimals([goodsDirect, goodsShare], ZERO);
      const landed = sumDecimals(
        [goods, ancillaryDirect, ancillaryShare],
        ZERO,
      );
      return {
        inventoryItemId: item.id,
        itemCode: item.itemCode,
        directAmount: toMoneyString(
          sumDecimals([goodsDirect, ancillaryDirect], ZERO),
        ),
        lotShareAmount: toMoneyString(
          sumDecimals([goodsShare, ancillaryShare], ZERO),
        ),
        acquisitionCostAmount: toMoneyString(goods),
        landedCostAmount: toMoneyString(landed),
      };
    });
  }

  for (const allocation of outcome) {
    await tx.execute(
      `update inventory_items
          set landed_cost_amount = ${numericLiteral(allocation.landedCostAmount)},
              acquisition_cost_amount =
                ${numericLiteral(allocation.acquisitionCostAmount)},
              cost_allocation_basis = ${textLiteral(basis)},
              updated_at = now()
        where id = ${uuidLiteral(allocation.inventoryItemId)}
          and cost_basis_locked_at is null`,
    );
  }

  const status =
    items.length === 0
      ? "pending"
      : input.finalize === true
        ? compareDecimals(unallocated, "0") === 0
          ? "final"
          : throwUnfinalizable(unallocated, currency)
        : "provisional";

  await tx.execute(
    `update acquisitions
        set cost_allocation_basis = ${textLiteral(basis)},
            cost_allocation_status = ${textLiteral(status)},
            updated_at = now()
      where id = ${uuidLiteral(input.acquisitionId)}`,
  );

  return {
    acquisitionId: input.acquisitionId,
    basis,
    currency,
    lotPoolAmount: toMoneyString(lotPool),
    lockedAmount: toMoneyString(lockedLotShare),
    allocatablePoolAmount: toMoneyString(allocatable),
    allocations: outcome,
    lockedItems: locked.map((item) => ({
      inventoryItemId: item.id,
      itemCode: item.itemCode,
      landedCostAmount: toMoneyString(item.landedCostAmount),
    })),
    unallocatedAmount: toMoneyString(unallocated),
    foreignCurrencyCostCount: foreign.length,
    costAllocationStatus: status,
  };
}

function throwUnfinalizable(unallocated: string, currency: string): never {
  throw new InventoryConflictError(
    `cannot finalize: ${unallocated} ${currency} of the lot pool has no weight ` +
      "to land on. Every allocation weight is zero — record estimated values, " +
      "allocation weights, or switch the basis to 'equal'.",
  );
}

function weightFor(basis: CostAllocationBasis, item: AllocationItem): string {
  switch (basis) {
    case "equal":
      // Weighted by quantity, so a row holding 100 phone cases takes 100 units
      // of a lot's cost and a row holding one lamp takes one. "Equal per unit"
      // is what `equal` means for a table whose rows carry a quantity.
      return clampNonNegative(item.quantity);
    case "relative_value":
      return clampNonNegative(item.estimatedValueAmount ?? ZERO);
    case "weight":
      return clampNonNegative(item.costAllocationWeight ?? ZERO);
    case "direct":
      return ZERO;
    default:
      return ZERO;
  }
}

/* -------------------------------------------------------------- internals */

function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what: string,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid ${what}: ${issues}`);
  }
  return parsed.data;
}

function decimalOrZero(value: unknown): string {
  return value === null || value === undefined ? ZERO : String(value);
}

async function nextSequence(db: LoxepDb, year: number): Promise<number> {
  const result = await db.execute(
    `select count(*)::int as n from acquisitions
      where reference_code like ${textLiteral(`ACQ-${year}-`)} || '%'`,
  );
  return Number(result.rows[0]?.["n"] ?? 0) + 1;
}
