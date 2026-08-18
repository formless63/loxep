/**
 * Pure day+kind-group bucketing for `/inventory/movements`' stacked area
 * chart (loxep-8e2, priority 1). Split out from the chart component so it is
 * independently testable without a DB/session, mirroring
 * `market-functions.ts`'s `shapePriceTrends` and
 * `runs-outcome-chart.tsx`'s `shapeRunsOutcomeTrend`.
 *
 * Decimal-safe: `quantity` is a `numeric(20,6)` string, so bucket totals are
 * summed via `sumMoney` (BigInt micro-units), never JS `number` addition.
 * Each movement's magnitude (sign stripped) is used, not its signed value —
 * the chart's series are "how much activity of this kind, per day," and a
 * `shrinkage` row is always negative by schema `CHECK` (it only ever
 * decreases on-hand), so summing signed values would render as a downward
 * series inside a chart whose whole point is stacking upward.
 */
import { sumMoney } from '@/lib/aggregate';
import { movementTrendGroup, MOVEMENT_TREND_GROUP_VALUES } from '@/features/inventory/constants';
import type { InventoryMovementTrendRowDto } from '@/server/inventory-functions';

export interface MovementTrendBucket {
  day: string;
  received: string;
  sold: string;
  shrinkage: string;
  adjusted: string;
  reversed: string;
}

function magnitude(quantity: string): string {
  return quantity.startsWith('-') ? quantity.slice(1) : quantity;
}

/**
 * Buckets `rows` by calendar day (of `occurredAt`, UTC — `occurredAt` is
 * always a full ISO timestamp) and by `movementTrendGroup(movementKind)`,
 * summing magnitude within each (day, group) pair. Days with zero rows are
 * absent (not zero-filled) — the chart itself decides how to render gaps.
 * Returned sorted ascending by day.
 */
export function shapeMovementsTrend(
  rows: readonly InventoryMovementTrendRowDto[]
): MovementTrendBucket[] {
  const byDay = new Map<string, Record<(typeof MOVEMENT_TREND_GROUP_VALUES)[number], string[]>>();

  for (const row of rows) {
    const day = row.occurredAt.slice(0, 10);
    const group = movementTrendGroup(row.movementKind);
    let bucket = byDay.get(day);
    if (bucket === undefined) {
      bucket = { received: [], sold: [], shrinkage: [], adjusted: [], reversed: [] };
      byDay.set(day, bucket);
    }
    bucket[group].push(magnitude(row.quantity));
  }

  return [...byDay.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([day, groups]) => ({
      day,
      received: sumMoney(groups.received),
      sold: sumMoney(groups.sold),
      shrinkage: sumMoney(groups.shrinkage),
      adjusted: sumMoney(groups.adjusted),
      reversed: sumMoney(groups.reversed)
    }));
}
