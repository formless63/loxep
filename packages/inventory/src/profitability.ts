/**
 * Realized profitability and the Phase 4 operational read models.
 *
 * Per the Phase 3 precedent these are **queries in a domain package, not
 * database views**: the volumes are small, the shapes will change again in
 * Phase 5, and view definitions in migrations hide business logic from the type
 * system and the test suite.
 *
 * ## The composition, per item
 *
 * ```text
 *   order revenue          order_lines.line_total, for the line this unit was
 *                          depleted against
 * − refunds                order_refund_lines.amount attributable to that line
 * − line-scoped fees       order_fees where fee_scope = 'line'
 *                            and fee_direction = 'seller_charge'
 * − allocated order fees   order_fees where fee_scope = 'order'
 *                            and fee_direction = 'seller_charge', pro rata,
 *                          EXCLUDING any fee referenced by a shipment's
 *                          order_fee_id
 * − outbound shipping      shipments: postage + insurance + surcharge
 *                            + adjustment − refund, allocated across
 *                          shipment_items
 * + customer-paid shipping already inside order_lines/orders as a Commerce
 *                          fact; never added twice
 * − cost basis             inventory_items.landed_cost_amount × depleted share
 * = realized contribution  per item, per sale
 * ```
 *
 * `fee_direction` is load-bearing and easy to miss. Only `seller_charge` rows
 * are deductions from proceeds; subtracting a `buyer_surcharge` would
 * understate contribution by exactly the amount the buyer already paid us.
 *
 * Explicitly **not** in this number: overhead, storage, labor, mileage not
 * capitalized into a lot, subscriptions, and anything at payout or processor
 * level. Those are Phase 5. Every surface that displays this figure must say
 * {@link CONTRIBUTION_LABEL} — never "profit".
 *
 * ## PROVISIONAL (design open question 7): pro rata by `line_total`, never stored
 *
 * Order-scoped fees and shipping are allocated **pro rata by
 * `order_lines.line_total`**, with largest-remainder rounding so the shares sum
 * to the original amount exactly. The same basis is used for both, because one
 * internally consistent composed figure matters more than either basis being
 * individually optimal. Nothing is stored: the allocation is computed HERE, so
 * changing the basis later is a code change and not a data migration — which is
 * precisely why Phase 3 refused to bake it into `order_fees` at ingest.
 *
 * A line with no `line_total` to weight by (a zero-value promotional line)
 * receives **no share** rather than an equal share, and the shortfall stays
 * with the paying lines.
 *
 * ### One step the design left to implementation
 *
 * The design says "order revenue = `order_lines.line_total`, for the line this
 * unit was depleted against" and assumes the dominant one-item-one-line case.
 * When SEVERAL items deplete one line, this module splits the line's revenue,
 * refunds, and fee shares across those items **pro rata by depleted quantity**,
 * again with largest-remainder rounding. That is a PROVISIONAL implementation
 * decision: quantity is the only basis available at that grain, and the
 * alternative — giving each item the whole line total — would report the same
 * revenue two or three times.
 *
 * ## PROVISIONAL (design open question 8): no FX, ever
 *
 * An item bought in GBP and sold in USD has no single-currency contribution
 * figure without a rate, a rate date, and a policy. Such a row is returned with
 * `contributionComputable: false` and a null contribution, both currencies and
 * both figures visible. Nothing is converted, and no read model sums across
 * currencies.
 *
 * ## PROVISIONAL (design open question 9): consignment is excluded by predicate
 *
 * Items whose acquisition is `source_kind = 'consignment_intake'` are held but
 * not owned, and their "profit" is a commission rather than a margin. They are
 * excluded from every contribution and inventory-at-cost total **by an explicit
 * predicate**, not by the accident of a zero basis, and the excluded count is
 * reported so the exclusion is visible.
 */
import type { LoxepDb } from "@loxep/db";
import {
  ZERO,
  clampNonNegative,
  compareDecimals,
  distributeByWeights,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import { InventoryValidationError } from "./errors.ts";
import { textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

/**
 * The only label Phase 4 may attach to this figure. Phase 3's equivalent said
 * "before cost of goods"; this one HAS cost of goods and still is not profit,
 * because overhead, labor, and payout-level fees are Phase 5.
 */
export const CONTRIBUTION_LABEL =
  "contribution after goods, fees, and shipping";

/* ---------------------------------------------------------------- filters */

export interface ProfitabilityFilter {
  orderId?: string;
  acquisitionId?: string;
  /** `null` selects the attribution backlog. */
  economicEntityId?: string | null;
  /** Inclusive lower bound on `orders.placed_at`. */
  from?: Date;
  /** Exclusive upper bound on `orders.placed_at`. */
  to?: Date;
}

function orderPredicates(filter: ProfitabilityFilter): string[] {
  // Never count one sale twice: the Phase 3 PROVISIONAL duplicate marking.
  const predicates = ["o.duplicate_of_order_id is null"];
  if (filter.orderId !== undefined) {
    predicates.push(`o.id = ${uuidLiteral(filter.orderId)}`);
  }
  if (filter.from !== undefined) {
    predicates.push(`o.placed_at >= ${timestamptzLiteral(filter.from)}`);
  }
  if (filter.to !== undefined) {
    predicates.push(`o.placed_at < ${timestamptzLiteral(filter.to)}`);
  }
  if (filter.from !== undefined && filter.to !== undefined &&
      filter.from.getTime() > filter.to.getTime()) {
    throw new InventoryValidationError("report filter `from` is after `to`");
  }
  if (filter.economicEntityId !== undefined) {
    predicates.push(
      filter.economicEntityId === null
        ? "i.economic_entity_id is null"
        : `i.economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`,
    );
  }
  if (filter.acquisitionId !== undefined) {
    predicates.push(`i.acquisition_id = ${uuidLiteral(filter.acquisitionId)}`);
  }
  return predicates;
}

/* ------------------------------------------------------------------- rows */

/** One depleted unit's realized contribution against one order line. */
export interface ItemContributionRow {
  inventoryItemId: string;
  itemCode: string;
  orderId: string;
  orderLineId: string;
  /** The ORDER's currency — the currency every revenue figure below is in. */
  currency: string;
  /** The ITEM's currency, snapshotted from its acquisition. */
  costCurrency: string;
  /** False when the two differ; see the module doc on open question 8. */
  contributionComputable: boolean;
  economicEntityId: string | null;
  acquisitionId: string | null;
  /** True for `consignment_intake` stock: held, not owned. */
  consignment: boolean;
  depletedQuantity: string;
  revenueAmount: string;
  refundAmount: string;
  lineFeeAmount: string;
  allocatedOrderFeeAmount: string;
  shippingAmount: string;
  /** In `costCurrency`, not `currency`. */
  costBasisAmount: string;
  /** Null exactly when `contributionComputable` is false. */
  contributionAmount: string | null;
  depletedAt: Date | null;
}

/** One order's realized contribution, composed from its depleted units. */
export interface OrderContributionRow {
  orderId: string;
  currency: string;
  placedAt: Date;
  /** Every line's `line_total`, whether or not stock was matched to it. */
  orderRevenueAmount: string;
  /** Revenue on lines that had a matched depletion. */
  matchedRevenueAmount: string;
  /**
   * Revenue on lines with NO depletion. Not an error — the unmatched-depletion
   * backlog is the common early-Phase-4 case and must stay visible.
   */
  unmatchedRevenueAmount: string;
  refundAmount: string;
  lineFeeAmount: string;
  orderFeeAmount: string;
  shippingAmount: string;
  costBasisAmount: string;
  /**
   * `matched revenue − refunds − fees − shipping − basis`, over the rows whose
   * cost currency matches the order and which are not consignment stock.
   */
  contributionAmount: string;
  itemCount: number;
  /** Rows omitted from the totals, each for a stated reason. */
  excludedForeignCurrencyItemCount: number;
  excludedConsignmentItemCount: number;
  label: string;
}

/* --------------------------------------------------------- gathered facts */

interface DepletionFact {
  inventoryItemId: string;
  orderLineId: string;
  orderId: string;
  quantity: string;
}

interface LineFact {
  id: string;
  orderId: string;
  lineTotal: string;
  lineFeeAmount: string;
  refundAmount: string;
}

interface OrderFact {
  id: string;
  currency: string;
  placedAt: Date;
  orderFeeAmount: string;
}

interface ItemFact {
  id: string;
  itemCode: string;
  currency: string;
  quantity: string;
  landedCostAmount: string;
  economicEntityId: string | null;
  acquisitionId: string | null;
  consignment: boolean;
  depletedAt: Date | null;
}

interface ShipmentAllocationFact {
  /** Keyed `${inventoryItemId}|${orderLineId}` where both are known. */
  itemLine: Map<string, string>;
  /** Keyed by order line, for shipment items that named no inventory item. */
  lineOnly: Map<string, string>;
}

/* ------------------------------------------------------- item contribution */

/**
 * Per-depleted-unit realized contribution.
 *
 * Everything is gathered in a handful of grouped statements and composed here,
 * because the largest-remainder distributions cannot be expressed in SQL
 * without either a window-function trick that nobody can review or storing the
 * allocation — and the design forbids storing it.
 */
export async function itemRealizedContribution(
  db: LoxepDb,
  filter: ProfitabilityFilter = {},
): Promise<ItemContributionRow[]> {
  const gathered = await gather(db, filter);
  return gathered.rows;
}

/** Per-order realized contribution, composed from the item rows. */
export async function orderRealizedContribution(
  db: LoxepDb,
  filter: ProfitabilityFilter = {},
): Promise<OrderContributionRow[]> {
  const gathered = await gather(db, filter);
  const byOrder = new Map<string, ItemContributionRow[]>();
  for (const row of gathered.rows) {
    byOrder.set(row.orderId, [...(byOrder.get(row.orderId) ?? []), row]);
  }

  const out: OrderContributionRow[] = [];
  for (const order of gathered.orders.values()) {
    const rows = byOrder.get(order.id) ?? [];
    const lines = gathered.lines.filter((line) => line.orderId === order.id);
    const matchedLineIds = new Set(rows.map((row) => row.orderLineId));
    const orderRevenue = sumDecimals(
      lines.map((line) => line.lineTotal),
      ZERO,
    );
    const matchedRevenue = sumDecimals(
      lines
        .filter((line) => matchedLineIds.has(line.id))
        .map((line) => line.lineTotal),
      ZERO,
    );

    const counted = rows.filter(
      (row) => row.contributionComputable && !row.consignment,
    );
    const contribution = sumDecimals(
      counted.map((row) => row.contributionAmount ?? ZERO),
      ZERO,
    );

    out.push({
      orderId: order.id,
      currency: order.currency,
      placedAt: order.placedAt,
      orderRevenueAmount: toMoneyString(orderRevenue),
      matchedRevenueAmount: toMoneyString(matchedRevenue),
      unmatchedRevenueAmount: toMoneyString(
        subtractDecimals(orderRevenue, matchedRevenue),
      ),
      refundAmount: toMoneyString(
        sumDecimals(counted.map((row) => row.refundAmount), ZERO),
      ),
      lineFeeAmount: toMoneyString(
        sumDecimals(counted.map((row) => row.lineFeeAmount), ZERO),
      ),
      orderFeeAmount: toMoneyString(
        sumDecimals(counted.map((row) => row.allocatedOrderFeeAmount), ZERO),
      ),
      shippingAmount: toMoneyString(
        sumDecimals(counted.map((row) => row.shippingAmount), ZERO),
      ),
      costBasisAmount: toMoneyString(
        sumDecimals(counted.map((row) => row.costBasisAmount), ZERO),
      ),
      contributionAmount: toMoneyString(contribution),
      itemCount: rows.length,
      excludedForeignCurrencyItemCount: rows.filter(
        (row) => !row.contributionComputable,
      ).length,
      excludedConsignmentItemCount: rows.filter((row) => row.consignment)
        .length,
      label: CONTRIBUTION_LABEL,
    });
  }
  return out.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
}

/* ------------------------------------------------------------- the gather */

interface Gathered {
  rows: ItemContributionRow[];
  orders: Map<string, OrderFact>;
  lines: LineFact[];
}

async function gather(
  db: LoxepDb,
  filter: ProfitabilityFilter,
): Promise<Gathered> {
  const where = orderPredicates(filter).join("\n           and ");

  // Depletions, net of any reversal that pointed back at them. A reversed
  // depletion is not a sale, and leaving it in would report revenue against an
  // item that came back.
  const depletionRows = await db.execute(
    `select m.inventory_item_id::text as item_id,
            m.order_line_id::text as line_id,
            ol.order_id::text as order_id,
            (-sum(m.quantity + coalesce(r.reversed, 0)))::numeric(20, 6)::text
              as quantity
       from inventory_movements m
       join order_lines ol on ol.id = m.order_line_id
       join orders o on o.id = ol.order_id
       join inventory_items i on i.id = m.inventory_item_id
       left join (select reverses_movement_id, sum(quantity) as reversed
                    from inventory_movements
                   where movement_kind = 'reversal'
                   group by reverses_movement_id) r
              on r.reverses_movement_id = m.id
      where m.movement_kind = 'depletion_sale'
        and m.order_line_id is not null
        and ${where}
      group by m.inventory_item_id, m.order_line_id, ol.order_id
     having -sum(m.quantity + coalesce(r.reversed, 0)) > 0
      order by ol.order_id, m.order_line_id, m.inventory_item_id`,
  );
  const depletions: DepletionFact[] = depletionRows.rows.map((row) => ({
    inventoryItemId: row["item_id"] as string,
    orderLineId: row["line_id"] as string,
    orderId: row["order_id"] as string,
    quantity: row["quantity"] as string,
  }));

  const orderIds = [...new Set(depletions.map((d) => d.orderId))];
  if (orderIds.length === 0) {
    return { rows: [], orders: new Map(), lines: [] };
  }
  const orderList = orderIds.map(uuidLiteral).join(", ");

  // Orders, with their order-scoped seller-charge fees. The `not exists`
  // clause IS the shipping double-count guard (open question 6): a fee a
  // shipment already accounts for must not be subtracted twice.
  const orderRows = await db.execute(
    `select o.id::text as id, o.currency, o.placed_at,
            coalesce((select sum(f.amount) from order_fees f
                       where f.order_id = o.id
                         and f.fee_scope = 'order'
                         and f.fee_direction = 'seller_charge'
                         and f.currency = o.currency
                         and not exists (select 1 from shipments s
                                          where s.order_fee_id = f.id)), 0)
              ::numeric(20, 6)::text as order_fee_amount
       from orders o
      where o.id in (${orderList})`,
  );
  const orders = new Map<string, OrderFact>(
    orderRows.rows.map((row) => [
      row["id"] as string,
      {
        id: row["id"] as string,
        currency: row["currency"] as string,
        placedAt: new Date(row["placed_at"] as string),
        orderFeeAmount: row["order_fee_amount"] as string,
      },
    ]),
  );

  // Lines, with their line-scoped seller-charge fees and their refunds.
  const lineRows = await db.execute(
    `select l.id::text as id, l.order_id::text as order_id,
            l.line_total::text as line_total,
            coalesce((select sum(f.amount) from order_fees f
                       where f.order_line_id = l.id
                         and f.fee_scope = 'line'
                         and f.fee_direction = 'seller_charge'
                         and f.currency = o.currency
                         and not exists (select 1 from shipments s
                                          where s.order_fee_id = f.id)), 0)
              ::numeric(20, 6)::text as line_fee_amount,
            coalesce((select sum(rl.amount)
                        from order_refund_lines rl
                        join order_refunds rf on rf.id = rl.order_refund_id
                       where rl.order_line_id = l.id
                         and rf.currency = o.currency), 0)
              ::numeric(20, 6)::text as refund_amount
       from order_lines l
       join orders o on o.id = l.order_id
      where l.order_id in (${orderList})
      order by l.order_id, l.line_number`,
  );
  const lines: LineFact[] = lineRows.rows.map((row) => ({
    id: row["id"] as string,
    orderId: row["order_id"] as string,
    lineTotal: row["line_total"] as string,
    lineFeeAmount: row["line_fee_amount"] as string,
    refundAmount: row["refund_amount"] as string,
  }));
  const lineById = new Map(lines.map((line) => [line.id, line]));

  // The depleted items themselves, plus the consignment predicate.
  const itemIds = [...new Set(depletions.map((d) => d.inventoryItemId))];
  const itemRows = await db.execute(
    `select i.id::text as id, i.item_code, i.currency,
            i.quantity::text as quantity,
            i.landed_cost_amount::text as landed,
            i.economic_entity_id::text as entity_id,
            i.acquisition_id::text as acquisition_id,
            i.depleted_at,
            coalesce(a.source_kind = 'consignment_intake', false) as consignment
       from inventory_items i
       left join acquisitions a on a.id = i.acquisition_id
      where i.id in (${itemIds.map(uuidLiteral).join(", ")})`,
  );
  const items = new Map<string, ItemFact>(
    itemRows.rows.map((row) => [
      row["id"] as string,
      {
        id: row["id"] as string,
        itemCode: row["item_code"] as string,
        currency: row["currency"] as string,
        quantity: row["quantity"] as string,
        landedCostAmount: row["landed"] as string,
        economicEntityId: (row["entity_id"] as string | null) ?? null,
        acquisitionId: (row["acquisition_id"] as string | null) ?? null,
        consignment: row["consignment"] === true,
        depletedAt:
          row["depleted_at"] === null || row["depleted_at"] === undefined
            ? null
            : new Date(row["depleted_at"] as string),
      },
    ]),
  );

  const shipping = await gatherShipping(db, orderIds, lineById);

  /* --------------------------------------------------- order-fee pro rata */

  // One distribution per order, weighted by line_total, largest remainder.
  const orderFeeByLine = new Map<string, string>();
  for (const order of orders.values()) {
    const orderLines = lines.filter((line) => line.orderId === order.id);
    const weights = orderLines.map((line) => clampNonNegative(line.lineTotal));
    const { shares } = distributeByWeights(order.orderFeeAmount, weights);
    orderLines.forEach((line, index) => {
      orderFeeByLine.set(line.id, shares[index] ?? ZERO);
    });
  }

  /* ----------------------------------------- per-line split across items */

  const byLine = new Map<string, DepletionFact[]>();
  for (const depletion of depletions) {
    byLine.set(depletion.orderLineId, [
      ...(byLine.get(depletion.orderLineId) ?? []),
      depletion,
    ]);
  }

  // An item may deplete against several lines; its basis is spread across those
  // events by depleted quantity, and a FULLY depleted item's shares sum to its
  // landed cost exactly rather than drifting by a rounding unit per event.
  const depletedTotalByItem = new Map<string, string>();
  for (const depletion of depletions) {
    depletedTotalByItem.set(
      depletion.inventoryItemId,
      sumDecimals(
        [depletedTotalByItem.get(depletion.inventoryItemId) ?? ZERO, depletion.quantity],
        ZERO,
      ),
    );
  }
  const basisByEvent = new Map<string, string>();
  for (const [itemId, totalDepleted] of depletedTotalByItem) {
    const item = items.get(itemId);
    if (item === undefined) continue;
    const events = depletions.filter((d) => d.inventoryItemId === itemId);
    const fully = compareDecimals(totalDepleted, item.quantity) >= 0;
    const pool = fully
      ? item.landedCostAmount
      : (distributeByWeights(item.landedCostAmount, [
          totalDepleted,
          subtractDecimals(item.quantity, totalDepleted),
        ]).shares[0] ?? ZERO);
    const { shares } = distributeByWeights(
      pool,
      events.map((event) => event.quantity),
    );
    events.forEach((event, index) => {
      basisByEvent.set(
        `${event.inventoryItemId}|${event.orderLineId}`,
        shares[index] ?? ZERO,
      );
    });
  }

  const rows: ItemContributionRow[] = [];
  for (const [lineId, lineDepletions] of byLine) {
    const line = lineById.get(lineId);
    if (line === undefined) continue;
    const order = orders.get(line.orderId);
    if (order === undefined) continue;

    const quantities = lineDepletions.map((d) => d.quantity);
    const revenueShares = distributeByWeights(line.lineTotal, quantities).shares;
    const refundShares = distributeByWeights(line.refundAmount, quantities).shares;
    const lineFeeShares = distributeByWeights(
      line.lineFeeAmount,
      quantities,
    ).shares;
    const orderFeeShares = distributeByWeights(
      orderFeeByLine.get(lineId) ?? ZERO,
      quantities,
    ).shares;
    // Shipping that named the line but no item is spread the same way.
    const lineShippingShares = distributeByWeights(
      shipping.lineOnly.get(lineId) ?? ZERO,
      quantities,
    ).shares;

    lineDepletions.forEach((depletion, index) => {
      const item = items.get(depletion.inventoryItemId);
      if (item === undefined) return;
      const revenue = revenueShares[index] ?? ZERO;
      const refund = refundShares[index] ?? ZERO;
      const lineFee = lineFeeShares[index] ?? ZERO;
      const orderFee = orderFeeShares[index] ?? ZERO;
      const shippingAmount = sumDecimals(
        [
          shipping.itemLine.get(`${depletion.inventoryItemId}|${lineId}`) ?? ZERO,
          lineShippingShares[index] ?? ZERO,
        ],
        ZERO,
      );
      const basis =
        basisByEvent.get(`${depletion.inventoryItemId}|${lineId}`) ?? ZERO;
      const computable = item.currency === order.currency;

      rows.push({
        inventoryItemId: item.id,
        itemCode: item.itemCode,
        orderId: order.id,
        orderLineId: lineId,
        currency: order.currency,
        costCurrency: item.currency,
        contributionComputable: computable,
        economicEntityId: item.economicEntityId,
        acquisitionId: item.acquisitionId,
        consignment: item.consignment,
        depletedQuantity: depletion.quantity,
        revenueAmount: toMoneyString(revenue),
        refundAmount: toMoneyString(refund),
        lineFeeAmount: toMoneyString(lineFee),
        allocatedOrderFeeAmount: toMoneyString(orderFee),
        shippingAmount: toMoneyString(shippingAmount),
        costBasisAmount: toMoneyString(basis),
        contributionAmount: computable
          ? toMoneyString(
              subtractDecimals(
                revenue,
                sumDecimals(
                  [refund, lineFee, orderFee, shippingAmount, basis],
                  ZERO,
                ),
              ),
            )
          : null,
        depletedAt: item.depletedAt,
      });
    });
  }

  return { rows, orders, lines };
}

/**
 * Allocate every relevant shipment's NET cost across its `shipment_items`,
 * pro rata by the `line_total` of each entry's order line — the same basis the
 * order-fee allocation uses, deliberately.
 *
 * A shipment item that names an inventory item and a line lands on that pair; a
 * shipment item that names only a line is returned separately and spread across
 * that line's depletions by quantity in the caller.
 */
async function gatherShipping(
  db: LoxepDb,
  orderIds: readonly string[],
  lineById: Map<string, LineFact>,
): Promise<ShipmentAllocationFact> {
  const orderList = orderIds.map(uuidLiteral).join(", ");
  const shipmentRows = await db.execute(
    `select s.id::text as id,
            (s.postage_amount + s.insurance_amount + s.surcharge_amount
               + s.adjustment_amount - s.refund_amount)::numeric(20, 6)::text
              as net_cost
       from shipments s
      where s.order_id in (${orderList})
        and s.shipment_kind = 'outbound_sale'
      order by s.created_at`,
  );
  const itemLine = new Map<string, string>();
  const lineOnly = new Map<string, string>();
  if (shipmentRows.rows.length === 0) return { itemLine, lineOnly };

  const shipmentIds = shipmentRows.rows.map((row) => row["id"] as string);
  const entryRows = await db.execute(
    `select si.shipment_id::text as shipment_id,
            si.inventory_item_id::text as item_id,
            si.order_line_id::text as line_id,
            si.quantity::text as quantity
       from shipment_items si
      where si.shipment_id in (${shipmentIds.map(uuidLiteral).join(", ")})
      order by si.created_at, si.id`,
  );

  // A shipment item that named only an inventory item still belongs to the line
  // that item was depleted against; resolve it so the weight can be found.
  const resolvedLineByItem = new Map<string, string>();
  const resolve = await db.execute(
    `select distinct m.inventory_item_id::text as item_id,
            m.order_line_id::text as line_id
       from inventory_movements m
       join order_lines l on l.id = m.order_line_id
      where m.movement_kind = 'depletion_sale'
        and l.order_id in (${orderList})`,
  );
  for (const row of resolve.rows) {
    resolvedLineByItem.set(row["item_id"] as string, row["line_id"] as string);
  }

  for (const shipment of shipmentRows.rows) {
    const shipmentId = shipment["id"] as string;
    const entries = entryRows.rows.filter(
      (row) => row["shipment_id"] === shipmentId,
    );
    if (entries.length === 0) continue;
    const weights = entries.map((entry) => {
      const lineId =
        (entry["line_id"] as string | null) ??
        resolvedLineByItem.get((entry["item_id"] as string | null) ?? "") ??
        "";
      const line = lineById.get(lineId);
      return line === undefined ? ZERO : clampNonNegative(line.lineTotal);
    });
    const { shares } = distributeByWeights(
      shipment["net_cost"] as string,
      weights,
    );
    entries.forEach((entry, index) => {
      const share = shares[index] ?? ZERO;
      if (compareDecimals(share, "0") === 0) return;
      const itemId = entry["item_id"] as string | null;
      const lineId =
        (entry["line_id"] as string | null) ??
        (itemId === null ? null : resolvedLineByItem.get(itemId) ?? null);
      if (itemId !== null && lineId !== null) {
        const key = `${itemId}|${lineId}`;
        itemLine.set(key, sumDecimals([itemLine.get(key) ?? ZERO, share], ZERO));
      } else if (lineId !== null) {
        lineOnly.set(
          lineId,
          sumDecimals([lineOnly.get(lineId) ?? ZERO, share], ZERO),
        );
      }
    });
  }

  return { itemLine, lineOnly };
}

/* ------------------------------------------------- operational read models */

/** Per acquisition: landed cost versus realized contribution, plus stock held. */
export interface AcquisitionRoiRow {
  acquisitionId: string;
  referenceCode: string;
  sourceKind: string;
  currency: string;
  acquiredAt: Date;
  costAllocationStatus: string;
  /** Capitalized costs in the acquisition's own currency. */
  landedCostAmount: string;
  /** `capitalize = false` rows: real spend, deliberately outside basis (OQ10). */
  nonCapitalizedAmount: string;
  itemCount: number;
  depletedItemCount: number;
  onHandItemCount: number;
  /** Basis still sitting on the shelf. A COST total, explicitly not a valuation. */
  onHandCostAmount: string;
  realizedContributionAmount: string;
}

export async function acquisitionRoi(
  db: LoxepDb,
  filter: ProfitabilityFilter = {},
): Promise<AcquisitionRoiRow[]> {
  const contributions = await itemRealizedContribution(db, filter);
  const byAcquisition = new Map<string, string>();
  for (const row of contributions) {
    if (row.acquisitionId === null) continue;
    if (!row.contributionComputable || row.consignment) continue;
    byAcquisition.set(
      row.acquisitionId,
      sumDecimals(
        [
          byAcquisition.get(row.acquisitionId) ?? ZERO,
          row.contributionAmount ?? ZERO,
        ],
        ZERO,
      ),
    );
  }

  const predicates: string[] = [];
  if (filter.acquisitionId !== undefined) {
    predicates.push(`a.id = ${uuidLiteral(filter.acquisitionId)}`);
  }
  if (filter.economicEntityId !== undefined) {
    predicates.push(
      filter.economicEntityId === null
        ? "a.economic_entity_id is null"
        : `a.economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`,
    );
  }
  if (filter.from !== undefined) {
    predicates.push(`a.acquired_at >= ${timestamptzLiteral(filter.from)}`);
  }
  if (filter.to !== undefined) {
    predicates.push(`a.acquired_at < ${timestamptzLiteral(filter.to)}`);
  }
  const where = predicates.length === 0 ? "true" : predicates.join(" and ");

  const rows = await db.execute(
    `select a.id::text as id, a.reference_code, a.source_kind, a.currency,
            a.acquired_at, a.cost_allocation_status,
            coalesce((select sum(c.amount) from acquisition_costs c
                       where c.acquisition_id = a.id and c.capitalize
                         and c.currency = a.currency), 0)
              ::numeric(20, 6)::text as landed,
            coalesce((select sum(c.amount) from acquisition_costs c
                       where c.acquisition_id = a.id and not c.capitalize
                         and c.currency = a.currency), 0)
              ::numeric(20, 6)::text as non_capitalized,
            (select count(*) from inventory_items i
              where i.acquisition_id = a.id)::int as item_count,
            (select count(*) from inventory_items i
              where i.acquisition_id = a.id and i.quantity_on_hand <= 0)::int
              as depleted_count,
            (select count(*) from inventory_items i
              where i.acquisition_id = a.id and i.quantity_on_hand > 0)::int
              as on_hand_count,
            coalesce((select sum(i.landed_cost_amount
                                 * (i.quantity_on_hand / nullif(i.quantity, 0)))
                        from inventory_items i
                       where i.acquisition_id = a.id
                         and i.quantity_on_hand > 0), 0)
              ::numeric(20, 6)::text as on_hand_cost
       from acquisitions a
      where ${where}
      order by a.acquired_at desc`,
  );

  return rows.rows.map((row) => ({
    acquisitionId: row["id"] as string,
    referenceCode: row["reference_code"] as string,
    sourceKind: row["source_kind"] as string,
    currency: row["currency"] as string,
    acquiredAt: new Date(row["acquired_at"] as string),
    costAllocationStatus: row["cost_allocation_status"] as string,
    landedCostAmount: row["landed"] as string,
    nonCapitalizedAmount: row["non_capitalized"] as string,
    itemCount: Number(row["item_count"]),
    depletedItemCount: Number(row["depleted_count"]),
    onHandItemCount: Number(row["on_hand_count"]),
    onHandCostAmount: row["on_hand_cost"] as string,
    realizedContributionAmount:
      byAcquisition.get(row["id"] as string) ?? ZERO,
  }));
}

/** Acquisition ROI grouped by `source_kind` — "is this channel worth repeating". */
export interface SourcingChannelRow {
  sourceKind: string;
  currency: string;
  acquisitionCount: number;
  landedCostAmount: string;
  realizedContributionAmount: string;
  onHandCostAmount: string;
}

export async function sourcingChannelPerformance(
  db: LoxepDb,
  filter: ProfitabilityFilter = {},
): Promise<SourcingChannelRow[]> {
  const roi = await acquisitionRoi(db, filter);
  const grouped = new Map<string, SourcingChannelRow>();
  for (const row of roi) {
    const key = `${row.sourceKind}|${row.currency}`;
    const current = grouped.get(key) ?? {
      sourceKind: row.sourceKind,
      currency: row.currency,
      acquisitionCount: 0,
      landedCostAmount: ZERO,
      realizedContributionAmount: ZERO,
      onHandCostAmount: ZERO,
    };
    grouped.set(key, {
      ...current,
      acquisitionCount: current.acquisitionCount + 1,
      landedCostAmount: toMoneyString(
        sumDecimals([current.landedCostAmount, row.landedCostAmount], ZERO),
      ),
      realizedContributionAmount: toMoneyString(
        sumDecimals(
          [current.realizedContributionAmount, row.realizedContributionAmount],
          ZERO,
        ),
      ),
      onHandCostAmount: toMoneyString(
        sumDecimals([current.onHandCostAmount, row.onHandCostAmount], ZERO),
      ),
    });
  }
  return [...grouped.values()].sort((a, b) =>
    a.sourceKind === b.sourceKind
      ? a.currency.localeCompare(b.currency)
      : a.sourceKind.localeCompare(b.sourceKind),
  );
}

/**
 * Stock on hand at COST, by entity and location.
 *
 * **A COST total, explicitly not a valuation.** Cost basis is what was paid for
 * a specific unit — a historical fact. Valuation is a judgement about what stock
 * is worth now, which needs a reporting date, a policy, and a book to post the
 * adjustment to; that is Phase 5. The field name says `Cost` for exactly this
 * reason, and `estimated_value_amount` is nowhere in this figure.
 */
export interface OnHandAtCostRow {
  economicEntityId: string | null;
  locationId: string | null;
  locationPath: string | null;
  currency: string;
  itemCount: number;
  quantityOnHand: string;
  onHandCostAmount: string;
  /** Consignment stock, held but not owned; counted separately, never summed in. */
  consignmentItemCount: number;
}

export async function inventoryOnHandAtCost(
  db: LoxepDb,
  filter: { economicEntityId?: string | null } = {},
): Promise<OnHandAtCostRow[]> {
  const predicates = ["i.quantity_on_hand > 0"];
  if (filter.economicEntityId !== undefined) {
    predicates.push(
      filter.economicEntityId === null
        ? "i.economic_entity_id is null"
        : `i.economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`,
    );
  }
  const rows = await db.execute(
    `select i.economic_entity_id::text as entity_id,
            i.location_id::text as location_id,
            l.path as location_path,
            i.currency,
            count(*) filter (where not coalesce(
              a.source_kind = 'consignment_intake', false))::int as item_count,
            coalesce(sum(i.quantity_on_hand) filter (where not coalesce(
              a.source_kind = 'consignment_intake', false)), 0)
              ::numeric(20, 6)::text as quantity_on_hand,
            coalesce(sum(i.landed_cost_amount
                         * (i.quantity_on_hand / nullif(i.quantity, 0)))
                     filter (where not coalesce(
                       a.source_kind = 'consignment_intake', false)), 0)
              ::numeric(20, 6)::text as on_hand_cost,
            count(*) filter (where coalesce(
              a.source_kind = 'consignment_intake', false))::int
              as consignment_count
       from inventory_items i
       left join inventory_locations l on l.id = i.location_id
       left join acquisitions a on a.id = i.acquisition_id
      where ${predicates.join(" and ")}
      group by i.economic_entity_id, i.location_id, l.path, i.currency
      order by l.path nulls last, i.currency`,
  );
  return rows.rows.map((row) => ({
    economicEntityId: (row["entity_id"] as string | null) ?? null,
    locationId: (row["location_id"] as string | null) ?? null,
    locationPath: (row["location_path"] as string | null) ?? null,
    currency: row["currency"] as string,
    itemCount: Number(row["item_count"]),
    quantityOnHand: row["quantity_on_hand"] as string,
    onHandCostAmount: row["on_hand_cost"] as string,
    consignmentItemCount: Number(row["consignment_count"]),
  }));
}

/** On-hand items bucketed by days since `acquired_at`. */
export async function inventoryAging(
  db: LoxepDb,
  buckets: readonly number[] = [30, 90, 180, 365],
): Promise<
  { bucket: string; currency: string; itemCount: number; onHandCostAmount: string }[]
> {
  const sorted = [...buckets].sort((a, b) => a - b);
  const cases = sorted
    .map(
      (days, index) =>
        `when now() - i.acquired_at < interval '${days} days' then ${textLiteral(
          index === 0 ? `0-${days}d` : `${sorted[index - 1]}-${days}d`,
        )}`,
    )
    .join("\n                 ");
  const rows = await db.execute(
    `select case ${cases}
                 else ${textLiteral(`${sorted[sorted.length - 1] ?? 0}d+`)}
            end as bucket,
            i.currency,
            count(*)::int as item_count,
            coalesce(sum(i.landed_cost_amount
                         * (i.quantity_on_hand / nullif(i.quantity, 0))), 0)
              ::numeric(20, 6)::text as on_hand_cost
       from inventory_items i
      where i.quantity_on_hand > 0
      group by 1, i.currency
      order by 1, i.currency`,
  );
  return rows.rows.map((row) => ({
    bucket: row["bucket"] as string,
    currency: row["currency"] as string,
    itemCount: Number(row["item_count"]),
    onHandCostAmount: row["on_hand_cost"] as string,
  }));
}

/**
 * Fulfilled order lines with no allocation and no movement.
 *
 * The design is emphatic that this is **not a failure mode** — it is the common
 * case early in Phase 4, and it must be a visible backlog rather than an
 * exception, exactly as an unattributed order is in Phase 3.
 */
export async function unmatchedDepletions(
  db: LoxepDb,
): Promise<
  {
    orderId: string;
    orderLineId: string;
    title: string | null;
    quantityFulfilled: string;
    currency: string;
    lineTotal: string;
  }[]
> {
  const rows = await db.execute(
    `select l.order_id::text as order_id, l.id::text as line_id, l.title,
            sum(fl.quantity)::numeric(20, 6)::text as quantity,
            o.currency, l.line_total::text as line_total
       from order_fulfillment_lines fl
       join order_lines l on l.id = fl.order_line_id
       join orders o on o.id = l.order_id
      where o.duplicate_of_order_id is null
        and not exists (select 1 from inventory_movements m
                         where m.order_line_id = l.id
                           and m.movement_kind = 'depletion_sale')
      group by l.order_id, l.id, l.title, o.currency, l.line_total
      order by l.order_id, l.id`,
  );
  return rows.rows.map((row) => ({
    orderId: row["order_id"] as string,
    orderLineId: row["line_id"] as string,
    title: (row["title"] as string | null) ?? null,
    quantityFulfilled: row["quantity"] as string,
    currency: row["currency"] as string,
    lineTotal: row["line_total"] as string,
  }));
}

/** Items whose cached on-hand went negative: the oversell exception, loudly. */
export async function oversells(
  db: LoxepDb,
): Promise<
  { inventoryItemId: string; itemCode: string; quantityOnHand: string }[]
> {
  const rows = await db.execute(
    `select id::text as id, item_code, quantity_on_hand::text as q
       from inventory_items
      where quantity_on_hand < 0
      order by quantity_on_hand`,
  );
  return rows.rows.map((row) => ({
    inventoryItemId: row["id"] as string,
    itemCode: row["item_code"] as string,
    quantityOnHand: row["q"] as string,
  }));
}

/** Lots opened and never finished being costed, past a staleness threshold. */
export async function openLots(
  db: LoxepDb,
  options: { staleAfterDays?: number } = {},
): Promise<
  {
    acquisitionId: string;
    referenceCode: string;
    costAllocationStatus: string;
    acquiredAt: Date;
    itemCount: number;
    expectedItemCount: number | null;
  }[]
> {
  const days = options.staleAfterDays ?? 14;
  const rows = await db.execute(
    `select a.id::text as id, a.reference_code, a.cost_allocation_status,
            a.acquired_at, a.expected_item_count,
            (select count(*) from inventory_items i
              where i.acquisition_id = a.id)::int as item_count
       from acquisitions a
      where a.cost_allocation_status <> 'final'
        and a.status not in ('cancelled', 'closed')
        and a.acquired_at < now() - interval '${Number(days)} days'
      order by a.acquired_at`,
  );
  return rows.rows.map((row) => ({
    acquisitionId: row["id"] as string,
    referenceCode: row["reference_code"] as string,
    costAllocationStatus: row["cost_allocation_status"] as string,
    acquiredAt: new Date(row["acquired_at"] as string),
    itemCount: Number(row["item_count"]),
    expectedItemCount:
      row["expected_item_count"] === null
        ? null
        : Number(row["expected_item_count"]),
  }));
}

/**
 * Final lots whose allocated item basis does not equal their capitalized landed
 * cost.
 *
 * This is the invariant the design deliberately refused to enforce with a
 * `CHECK` — it is legitimately false for most of a lot's life — expressed where
 * it belongs: a report over lots that claim to be `final`.
 */
export async function costReconciliation(
  db: LoxepDb,
): Promise<
  {
    acquisitionId: string;
    referenceCode: string;
    currency: string;
    capitalizedCostAmount: string;
    allocatedBasisAmount: string;
    differenceAmount: string;
  }[]
> {
  const rows = await db.execute(
    `select a.id::text as id, a.reference_code, a.currency,
            coalesce(c.total, 0)::numeric(20, 6)::text as capitalized,
            coalesce(i.total, 0)::numeric(20, 6)::text as allocated,
            (coalesce(c.total, 0) - coalesce(i.total, 0))::numeric(20, 6)::text
              as difference
       from acquisitions a
       left join (select acquisition_id, sum(amount) as total
                    from acquisition_costs
                   where capitalize
                   group by acquisition_id) c on c.acquisition_id = a.id
       left join (select acquisition_id, sum(landed_cost_amount) as total
                    from inventory_items
                   group by acquisition_id) i on i.acquisition_id = a.id
      where a.cost_allocation_status = 'final'
        and coalesce(c.total, 0) <> coalesce(i.total, 0)
      order by a.acquired_at desc`,
  );
  return rows.rows.map((row) => ({
    acquisitionId: row["id"] as string,
    referenceCode: row["reference_code"] as string,
    currency: row["currency"] as string,
    capitalizedCostAmount: row["capitalized"] as string,
    allocatedBasisAmount: row["allocated"] as string,
    differenceAmount: row["difference"] as string,
  }));
}
