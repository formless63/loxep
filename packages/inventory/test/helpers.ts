/**
 * Scratch-database lifecycle and seed helpers for the @loxep/inventory suite.
 *
 * Real PostgreSQL/TimescaleDB (docker/compose.dev.yml, host port 5433), never a
 * SQLite substitute — the append-only trigger, `NULLS NOT DISTINCT`, partial
 * unique indexes, `num_nonnulls`, and exact `numeric` arithmetic have no
 * meaning anywhere else. Each test file provisions its own scratch database so
 * files run in parallel and never depend on leftover state.
 *
 * `pg` is not a direct dependency of this package, so maintenance queries go
 * through @loxep/db's pooled handle — the @loxep/commerce and @loxep/market
 * pattern.
 *
 * Commerce fixtures are written with direct inserts rather than through
 * @loxep/commerce's ingestion service. That is deliberate: these tests are
 * about inventory arithmetic, and a hand-written `line_total` of exactly
 * `100.00` is what makes a hand-computed contribution figure checkable.
 */
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  connections,
  documentLineCandidates,
  documents,
  economicEntities,
  orderFees,
  orderFulfillmentLines,
  orderFulfillments,
  orderLines,
  orderRefundLines,
  orderRefunds,
  orders,
  user,
} from "@loxep/db/schema";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ScratchDb {
  name: string;
  handle: DbHandle;
  close: () => Promise<void>;
}

async function withMaintenanceDb(sql: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(sql);
  } finally {
    await closeDb(handle);
  }
}

/** Create a migrated scratch database and a pooled handle bound to it. */
export async function createMigratedScratchDb(
  prefix: string,
): Promise<ScratchDb> {
  const name = scratchDbName(prefix);
  await withMaintenanceDb(`create database "${name}"`);
  const databaseUrl = databaseUrlFor(name);
  await runMigrations({ databaseUrl, logger: silentLogger });
  const handle = createDb(databaseUrl);
  return {
    name,
    handle,
    close: async () => {
      await closeDb(handle);
      await withMaintenanceDb(`drop database if exists "${name}" with (force)`);
    },
  };
}

export async function seedEntity(
  scratch: ScratchDb,
  name: string,
  kind = "llc",
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(economicEntities)
    .values({ name, kind })
    .returning({ id: economicEntities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("entity insert returned no row");
  return id;
}

export async function seedConnection(
  scratch: ScratchDb,
  input: {
    name: string;
    provider?: string;
    economicEntityId?: string | null;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(connections)
    .values({
      provider: input.provider ?? "woocommerce",
      kind: "store",
      name: input.name,
      status: "active",
      economicEntityId: input.economicEntityId ?? null,
    })
    .returning({ id: connections.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("connection insert returned no row");
  return id;
}

export interface SeededOrder {
  orderId: string;
  lineIds: string[];
  fulfillmentId: string;
}

/**
 * One order with the lines, fees, refunds, and a fulfillment a profitability
 * fixture needs. Every amount is passed in as an exact decimal string.
 */
export async function seedOrder(
  scratch: ScratchDb,
  input: {
    connectionId: string;
    externalOrderId: string;
    currency?: string;
    placedAt?: Date;
    economicEntityId?: string | null;
    lines: {
      quantity: string;
      unitPrice: string;
      lineTotal: string;
      title?: string;
    }[];
    /** `fee_scope = 'order'` unless `lineIndex` is given. */
    fees?: {
      feeType: string;
      amount: string;
      lineIndex?: number;
      feeDirection?: "seller_charge" | "buyer_surcharge";
      currency?: string;
    }[];
    refunds?: { lineIndex: number; amount: string }[];
    /** Fulfilled quantities per line index; defaults to the full line quantity. */
    fulfillment?: { lineIndex: number; quantity: string }[];
  },
): Promise<SeededOrder> {
  const db = scratch.handle.db;
  const currency = input.currency ?? "USD";
  const total = input.lines.reduce(
    (sum, line) => sum + Number(line.lineTotal),
    0,
  );
  const orderRows = await db
    .insert(orders)
    .values({
      connectionId: input.connectionId,
      provider: "woocommerce",
      channel: "woo",
      sourceAccountKey: "woocommerce:test",
      externalOrderId: input.externalOrderId,
      economicEntityId: input.economicEntityId ?? null,
      entityAttributionSource:
        input.economicEntityId === undefined || input.economicEntityId === null
          ? "unattributed"
          : "manual",
      status: "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      currency,
      subtotalAmount: total.toFixed(6),
      totalAmount: total.toFixed(6),
      placedAt: input.placedAt ?? new Date("2026-03-01T12:00:00Z"),
    })
    .returning({ id: orders.id });
  const orderId = orderRows[0]?.id;
  if (orderId === undefined) throw new Error("order insert returned no row");

  const lineIds: string[] = [];
  for (const [index, line] of input.lines.entries()) {
    const rows = await db
      .insert(orderLines)
      .values({
        orderId,
        lineNumber: index + 1,
        title: line.title ?? `line ${index + 1}`,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineSubtotal: line.lineTotal,
        lineTotal: line.lineTotal,
      })
      .returning({ id: orderLines.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("line insert returned no row");
    lineIds.push(id);
  }

  for (const fee of input.fees ?? []) {
    const lineId =
      fee.lineIndex === undefined ? null : (lineIds[fee.lineIndex] ?? null);
    await db.insert(orderFees).values({
      orderId,
      orderLineId: lineId,
      feeScope: lineId === null ? "order" : "line",
      feeDirection: fee.feeDirection ?? "seller_charge",
      feeType: fee.feeType,
      currency: fee.currency ?? currency,
      amount: fee.amount,
    });
  }

  for (const refund of input.refunds ?? []) {
    const refundRows = await db
      .insert(orderRefunds)
      .values({
        orderId,
        kind: "partial_refund",
        status: "completed",
        currency,
        amount: refund.amount,
      })
      .returning({ id: orderRefunds.id });
    const refundId = refundRows[0]?.id;
    if (refundId === undefined) throw new Error("refund insert returned no row");
    await db.insert(orderRefundLines).values({
      orderRefundId: refundId,
      orderLineId: lineIds[refund.lineIndex] ?? null,
      amount: refund.amount,
    });
  }

  const fulfillmentRows = await db
    .insert(orderFulfillments)
    .values({ orderId, status: "shipped" })
    .returning({ id: orderFulfillments.id });
  const fulfillmentId = fulfillmentRows[0]?.id;
  if (fulfillmentId === undefined) {
    throw new Error("fulfillment insert returned no row");
  }

  const fulfillmentLines =
    input.fulfillment ??
    input.lines.map((line, index) => ({
      lineIndex: index,
      quantity: line.quantity,
    }));
  for (const entry of fulfillmentLines) {
    await db.insert(orderFulfillmentLines).values({
      orderFulfillmentId: fulfillmentId,
      orderLineId: lineIds[entry.lineIndex] ?? "",
      quantity: entry.quantity,
    });
  }

  return { orderId, lineIds, fulfillmentId };
}

/** Every `order_fees` row for one order, for the double-count-guard tests. */
export async function feeIdsFor(
  scratch: ScratchDb,
  orderId: string,
): Promise<{ id: string; feeType: string; amount: string }[]> {
  const rows = await scratch.handle.db.execute(
    `select id::text as id, fee_type, amount::text as amount
       from order_fees where order_id = '${orderId}' order by created_at, id`,
  );
  return rows.rows.map((row) => ({
    id: row["id"] as string,
    feeType: row["fee_type"] as string,
    amount: row["amount"] as string,
  }));
}

/* -------------------------------------- Documents fixtures, for confirm.test.ts */

/** A Better Auth user row usable as an FK-valid actor (ADR-0020). Mirrors `@loxep/accounting/test/helpers.ts`'s own. */
export async function seedUser(scratch: ScratchDb, id: string): Promise<string> {
  await scratch.handle.db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}

/**
 * A `documents` row, seeded directly against `@loxep/db` schema — this
 * package deliberately does not depend on `@loxep/documents` (see
 * `src/confirm.ts`'s module doc), so `confirm.test.ts` needs its own way to
 * stand up the document/candidate rows `confirmCandidatesAsAcquisition`
 * reads. Mirrors `@loxep/accounting/test/helpers.ts`'s `seedDocument`.
 */
export async function seedDocument(
  scratch: ScratchDb,
  input: {
    documentKind?: string;
    mediaObjectId?: string | null;
    currency?: string | null;
    documentDate?: string | null;
    counterpartyName?: string | null;
    economicEntityId?: string | null;
  } = {},
): Promise<string> {
  const mediaObjectId = input.mediaObjectId ?? null;
  const rows = await scratch.handle.db
    .insert(documents)
    .values({
      documentKind: input.documentKind ?? "receipt",
      sourceKind: mediaObjectId === null ? "csv" : "upload",
      mediaObjectId,
      currency: input.currency ?? null,
      documentDate: input.documentDate ?? null,
      counterpartyName: input.counterpartyName ?? null,
      economicEntityId: input.economicEntityId ?? null,
    })
    .returning({ id: documents.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("document insert returned no row");
  return id;
}

/** A `document_line_candidates` row. Mirrors `@loxep/accounting/test/helpers.ts`'s `seedCandidate`, `disposition: 'acquisition_cost'` by default here since this suite is about the acquisition path. */
export async function seedCandidate(
  scratch: ScratchDb,
  input: {
    documentId: string;
    lineNumber?: number;
    description?: string | null;
    quantity?: string | null;
    unitAmount?: string | null;
    lineAmount?: string | null;
    lineDate?: string | null;
    disposition?: string;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(documentLineCandidates)
    .values({
      documentId: input.documentId,
      lineNumber: input.lineNumber ?? 1,
      description: input.description ?? null,
      quantity: input.quantity ?? null,
      unitAmount: input.unitAmount ?? null,
      lineAmount: input.lineAmount ?? null,
      lineDate: input.lineDate ?? null,
      disposition: input.disposition ?? "acquisition_cost",
    })
    .returning({ id: documentLineCandidates.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("document line candidate insert returned no row");
  return id;
}

/** A `media_objects` row, seeded directly — mirrors `@loxep/accounting/test/helpers.ts`'s `seedMedia`, minus the `MediaService` (this package has no `@loxep/storage` dependency; `confirm.ts` writes `media_links` directly). */
export async function seedMediaObject(scratch: ScratchDb, sha256: string): Promise<string> {
  const backend = await scratch.handle.pool.query<{ id: string }>(
    `insert into storage_backends (name, driver, config)
     values ('local-test', 'local', '{"root":"/tmp/loxep-inventory-test"}'::jsonb)
     on conflict do nothing
     returning id`,
  );
  const backendId =
    backend.rows[0]?.id ??
    (await scratch.handle.pool.query<{ id: string }>(`select id from storage_backends limit 1`))
      .rows[0]?.id;
  if (backendId === undefined) throw new Error("no storage backend seeded");

  const media = await scratch.handle.pool.query<{ id: string }>(
    `insert into media_objects (storage_backend_id, storage_key, original_filename,
                                mime_type, size_bytes, sha256)
     values ($1, $2, 'invoice.jpg', 'image/jpeg', 1024, $3)
     returning id`,
    [backendId, `media/${sha256}.jpg`, sha256],
  );
  const mediaObjectId = media.rows[0]?.id;
  if (mediaObjectId === undefined) throw new Error("media object insert returned no row");
  return mediaObjectId;
}
