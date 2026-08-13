/**
 * Server functions for the `/commerce` workspace (loxep-dgf.6, Flipping M6:
 * manual/offline channel listings and the inventory-to-draft bridge).
 *
 * Design: `flipping-lifecycle-design.md` section 4. The domain service layer
 * this surface wants lives in `@loxep/commerce` (`catalog.ts`'s
 * `createManualListing`/`findOrCreateCatalogItemBySku`, `manual-sales.ts`'s
 * `createManualSalesService`, `listing-draft.ts`'s pure mapping function —
 * all real, tested, and exported from the package). `apps/web/package.json`
 * does not yet declare `"@loxep/commerce": "workspace:*"` — unlike
 * `@loxep/inventory`, which IS a declared dependency (see
 * `@/server/inventory-functions.ts`'s own bootstrapping history: writes went
 * through a stub until that dependency line landed). Until an orchestrator
 * adds the line, this file cannot `import`/dynamic-`import()` `@loxep/commerce`
 * at all (Node module resolution needs the package hoisted into
 * `apps/web/node_modules/@loxep`, and it is not — verified empirically: it
 * is absent even though `@loxep/inventory` transitively depends on it).
 *
 * So, mirroring exactly what `@loxep/commerce`'s own service functions do —
 * duplicated here rather than imported, pending the dependency add:
 *
 *  - READS go straight through `@loxep/db` (`getAdminServices().handle.db.query.<table>`),
 *    the same pattern every other `*-functions.ts` file in this directory
 *    uses for a flat/joined select with no business rule attached.
 *  - WRITES to `catalog_items` / `channel_listings` / `orders` / `order_lines`
 *    go through the Drizzle insert builder directly against `@loxep/db`'s
 *    schema objects (a real dependency), reproducing
 *    `@loxep/commerce/src/catalog.ts`'s `createManualListing`/
 *    `findOrCreateCatalogItemBySku` and `@loxep/commerce/src/manual-sales.ts`'s
 *    `recordManualSale` field-for-field. THE REAL, TESTED VERSION OF THIS
 *    LOGIC LIVES IN `@loxep/commerce` — this is a thin, intentionally minimal
 *    duplicate, not a redesign. Once the dependency line is added, this
 *    file's write handlers should be rewritten to call
 *    `createCatalogService`/`createManualSalesService` instead.
 *  - The INVENTORY side effects (`markListed`, `reserve` +
 *    `depleteOnFulfillment`) go through the REAL `@loxep/inventory` services
 *    via `@/server/admin.ts`'s `getItemsService()`/`getAllocationsService()`,
 *    exactly like every other inventory write in this codebase — that
 *    package IS a declared dependency, so there is nothing to duplicate here.
 *
 * Role gate: `requireSession` throughout, matching `/inventory`'s reasoning
 * — creating a listing or recording a sale is ordinary operator work, not an
 * administrative action.
 */
import { randomUUID } from 'node:crypto';
import { catalogItems, channelListings, orderLines, orders } from '@loxep/db/schema';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const uuidSchema = z.uuid();

function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new Error('expected a UUID value');
  return `'${parsed.data}'`;
}

function textLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('text values must not contain NUL bytes');
  return `'${value.replaceAll("'", "''")}'`;
}

/** `LST-<year>-<seq>` — duplicated from `@loxep/commerce/src/codes.ts` pending the dependency add (see file header). */
function formatListingCode(year: number, sequence: number): string {
  return `LST-${year}-${String(sequence).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Reads — channel listings
// ---------------------------------------------------------------------------

export interface ChannelListingListItemDto {
  id: string;
  listingCode: string;
  provider: string;
  channel: string;
  status: string;
  catalogItemId: string;
  catalogItemSku: string;
  catalogItemName: string;
  listingTitle: string | null;
  currency: string | null;
  price: string | null;
  quantityAvailable: number | null;
  listedAt: string | null;
  endedAt: string | null;
  listingUrl: string | null;
  createdAt: string;
}

const listingFilterInput = z.strictObject({
  status: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  channel: z.string().trim().min(1).optional()
});

const LISTING_LIST_LIMIT = 1000;

export const fetchChannelListings = createServerFn({ method: 'GET' })
  .inputValidator(listingFilterInput)
  .handler(async ({ data }): Promise<ChannelListingListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.channelListings.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (data.status !== undefined) clauses.push(eq(table.status, data.status));
        if (data.provider !== undefined) clauses.push(eq(table.provider, data.provider));
        if (data.channel !== undefined) clauses.push(eq(table.channel, data.channel));
        return clauses.length > 0 ? and(...clauses) : undefined;
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: LISTING_LIST_LIMIT
    });
    if (rows.length === 0) return [];

    const catalogItemIds = [...new Set(rows.map((row) => row.catalogItemId))];
    const catalogItemRows = await handle.db.query.catalogItems.findMany({
      where: (table, { inArray }) => inArray(table.id, catalogItemIds),
      columns: { id: true, sku: true, name: true }
    });
    const catalogItemById = new Map(catalogItemRows.map((row) => [row.id, row]));

    return rows.map((row) => {
      const catalogItem = catalogItemById.get(row.catalogItemId);
      return {
        id: row.id,
        listingCode: row.listingCode,
        provider: row.provider,
        channel: row.channel,
        status: row.status,
        catalogItemId: row.catalogItemId,
        catalogItemSku: catalogItem?.sku ?? '',
        catalogItemName: catalogItem?.name ?? '',
        listingTitle: row.listingTitle,
        currency: row.currency,
        price: row.price,
        quantityAvailable: row.quantityAvailable,
        listedAt: iso(row.listedAt),
        endedAt: iso(row.endedAt),
        listingUrl: row.listingUrl,
        createdAt: iso(row.createdAt)
      };
    });
  });

export interface ChannelListingOrderDto {
  orderId: string;
  orderLineId: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  currency: string;
  placedAt: string;
}

export interface ChannelListingDetailDto extends ChannelListingListItemDto {
  inventoryItemId: string | null;
  inventoryItemCode: string | null;
  /** Manual sales recorded against this listing, most recent first. */
  sales: ChannelListingOrderDto[];
}

export const fetchChannelListing = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ChannelListingDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const row = await handle.db.query.channelListings.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (row === undefined) {
      throw new Error(`channel listing "${data.id}" not found`);
    }
    const catalogItem = await handle.db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.id, row.catalogItemId)
    });
    const inventoryItem =
      catalogItem !== undefined
        ? await handle.db.query.inventoryItems.findFirst({
            where: (table, { eq }) => eq(table.itemCode, catalogItem.sku),
            columns: { id: true, itemCode: true }
          })
        : undefined;

    const lineRows = await handle.db.query.orderLines.findMany({
      where: (table, { eq }) => eq(table.channelListingId, row.id)
    });
    const orderIds = [...new Set(lineRows.map((line) => line.orderId))];
    const orderRows =
      orderIds.length > 0
        ? await handle.db.query.orders.findMany({
            where: (table, { inArray }) => inArray(table.id, orderIds),
            columns: { id: true, placedAt: true }
          })
        : [];
    const placedAtByOrderId = new Map(orderRows.map((order) => [order.id, order.placedAt]));

    return {
      id: row.id,
      listingCode: row.listingCode,
      provider: row.provider,
      channel: row.channel,
      status: row.status,
      catalogItemId: row.catalogItemId,
      catalogItemSku: catalogItem?.sku ?? '',
      catalogItemName: catalogItem?.name ?? '',
      listingTitle: row.listingTitle,
      currency: row.currency,
      price: row.price,
      quantityAvailable: row.quantityAvailable,
      listedAt: iso(row.listedAt),
      endedAt: iso(row.endedAt),
      listingUrl: row.listingUrl,
      createdAt: iso(row.createdAt),
      inventoryItemId: inventoryItem?.id ?? null,
      inventoryItemCode: inventoryItem?.itemCode ?? null,
      sales: lineRows
        .map((line) => {
          const placedAt = placedAtByOrderId.get(line.orderId);
          if (placedAt === undefined) return null;
          return {
            orderId: line.orderId,
            orderLineId: line.id,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            currency: row.currency ?? 'USD',
            placedAt: iso(placedAt)
          };
        })
        .filter((sale): sale is ChannelListingOrderDto => sale !== null)
        // A fresh array from `.filter()`, so sorting in place mutates
        // nothing the caller holds a reference to.
        .sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1))
    };
  });

/**
 * The item-detail panel's read ("the market→inventory→listing weave" — an
 * item detail gains a listings panel). Joins on the minting convention
 * `catalog_items.sku = inventory_items.item_code`
 * (`findOrCreateCatalogItemBySku`, design 4b's "cheap answer").
 */
export const fetchListingsForInventoryItem = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ inventoryItemId: z.uuid() }))
  .handler(async ({ data }): Promise<ChannelListingListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const item = await handle.db.query.inventoryItems.findFirst({
      where: (table, { eq }) => eq(table.id, data.inventoryItemId),
      columns: { itemCode: true }
    });
    if (item === undefined) return [];
    const catalogItem = await handle.db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.sku, item.itemCode)
    });
    if (catalogItem === undefined) return [];

    const rows = await handle.db.query.channelListings.findMany({
      where: (table, { eq }) => eq(table.catalogItemId, catalogItem.id),
      orderBy: (table, { desc }) => [desc(table.createdAt)]
    });
    return rows.map((row) => ({
      id: row.id,
      listingCode: row.listingCode,
      provider: row.provider,
      channel: row.channel,
      status: row.status,
      catalogItemId: row.catalogItemId,
      catalogItemSku: catalogItem.sku,
      catalogItemName: catalogItem.name,
      listingTitle: row.listingTitle,
      currency: row.currency,
      price: row.price,
      quantityAvailable: row.quantityAvailable,
      listedAt: iso(row.listedAt),
      endedAt: iso(row.endedAt),
      listingUrl: row.listingUrl,
      createdAt: iso(row.createdAt)
    }));
  });

// ---------------------------------------------------------------------------
// Reads — catalog items (`/commerce/catalog`)
// ---------------------------------------------------------------------------

export interface CatalogItemListItemDto {
  id: string;
  sku: string;
  name: string;
  kind: string;
  status: string;
  defaultCurrency: string | null;
  defaultPrice: string | null;
  createdAt: string;
}

export const fetchCatalogItems = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CatalogItemListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const rows = await handle.db.query.catalogItems.findMany({
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: 1000
    });
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      kind: row.kind,
      status: row.status,
      defaultCurrency: row.defaultCurrency,
      defaultPrice: row.defaultPrice,
      createdAt: iso(row.createdAt)
    }));
  }
);

// ---------------------------------------------------------------------------
// Writes — manual channel listing creation
// ---------------------------------------------------------------------------

const createManualListingInput = z.strictObject({
  inventoryItemId: z.uuid(),
  channel: z.enum([
    'facebook_marketplace',
    'craigslist',
    'offerup',
    'in_person',
    'local_pickup',
    'consignment_shop',
    'other'
  ]),
  status: z.enum(['draft', 'active']).default('draft'),
  listingTitle: z.string().trim().min(1).nullish(),
  listingUrl: z.string().trim().min(1).nullish(),
  price: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish()
});

export const createManualChannelListing = createServerFn({ method: 'POST' })
  .inputValidator(createManualListingInput)
  .handler(async ({ data }): Promise<{ id: string; listingCode: string }> => {
    const { requireSession, getAdminServices, getItemsService } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const itemsService = await getItemsService();

    const item = await itemsService.get(data.inventoryItemId);

    // findOrCreateCatalogItemBySku — the design's "cheap answer" to open
    // question 5 (see @loxep/commerce/src/catalog.ts's real, tested version
    // of this exact function).
    let catalogItem = await handle.db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.sku, item.itemCode)
    });
    if (catalogItem === undefined) {
      const inserted = await handle.db
        .insert(catalogItems)
        .values({
          sku: item.itemCode,
          name: item.label,
          kind: 'simple',
          status: 'active',
          economicEntityId: item.economicEntityId,
          conditionCode: item.conditionCode,
          defaultCurrency: item.currency,
          defaultPrice: item.estimatedValueAmount
        })
        .returning();
      catalogItem = inserted[0];
    }
    if (catalogItem === undefined) {
      throw new Error('catalog item resolution failed');
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const seqResult = await handle.db.execute(
      `select coalesce(max(
                (substring(listing_code from '^LST-[0-9]{4}-([0-9]+)$'))::integer
              ), 0)::text as max_seq
         from channel_listings
        where listing_code like ${textLiteral(`LST-${year}-`)} || '%'`
    );
    const nextSeq = Number(seqResult.rows[0]?.['max_seq'] ?? '0') + 1;
    const listingCode = formatListingCode(year, nextSeq);

    const listedAt = data.status === 'active' ? now : null;
    const insertedListings = await handle.db
      .insert(channelListings)
      .values({
        listingCode,
        catalogItemId: catalogItem.id,
        connectionId: null,
        provider: 'manual',
        channel: data.channel,
        externalListingId: null,
        externalVariationId: null,
        status: data.status,
        listingUrl: data.listingUrl ?? null,
        listingTitle: data.listingTitle ?? item.label,
        currency: (data.currency ?? item.currency).toUpperCase(),
        price: data.price ?? item.estimatedValueAmount,
        quantityAvailable: 1,
        listedAt
      })
      .returning();
    const listing = insertedListings[0];
    if (listing === undefined) {
      throw new Error('manual listing insert returned no row');
    }

    // Real @loxep/inventory write: sets listed_at + advances available -> listed.
    await itemsService.markListed(data.inventoryItemId);

    return { id: listing.id, listingCode: listing.listingCode };
  });

// ---------------------------------------------------------------------------
// Writes — manual sale recording (design open question 7, PROVISIONAL)
// ---------------------------------------------------------------------------

const recordManualSaleInput = z.strictObject({
  channelListingId: z.uuid(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('1'),
  unitPrice: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
});

export interface RecordManualSaleResultDto {
  orderId: string;
  orderLineId: string;
  listingStatus: string;
  oversell: boolean;
}

export const recordManualListingSale = createServerFn({ method: 'POST' })
  .inputValidator(recordManualSaleInput)
  .handler(async ({ data }): Promise<RecordManualSaleResultDto> => {
    const { requireSession, getAdminServices, getItemsService, getAllocationsService } =
      await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();

    const listing = await handle.db.query.channelListings.findFirst({
      where: (table, { eq }) => eq(table.id, data.channelListingId)
    });
    if (listing === undefined) {
      throw new Error(`channel listing "${data.channelListingId}" not found`);
    }
    if (listing.provider !== 'manual') {
      throw new Error(
        `channel listing "${listing.listingCode}" is provider "${listing.provider}", not "manual"`
      );
    }
    if (listing.status === 'sold_out' || listing.status === 'ended') {
      throw new Error(`channel listing "${listing.listingCode}" is already "${listing.status}"`);
    }
    const catalogItem = await handle.db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.id, listing.catalogItemId)
    });
    if (catalogItem === undefined) {
      throw new Error(`catalog item "${listing.catalogItemId}" not found`);
    }

    const itemsService = await getItemsService();
    const inventoryItem = await itemsService.getByCode(catalogItem.sku);

    const currency = (listing.currency ?? 'USD').toUpperCase();
    const now = new Date();
    const lineSubtotalNumber = Number(data.unitPrice) * Number(data.quantity);
    const lineSubtotal = lineSubtotalNumber.toFixed(6);
    const externalOrderId = `manual:${randomUUID()}`;

    const insertedOrders = await handle.db
      .insert(orders)
      .values({
        connectionId: null,
        provider: 'manual',
        channel: listing.channel,
        marketplace: null,
        sourceAccountKey: 'manual:default',
        externalOrderId,
        externalOrderNumber: listing.listingCode,
        economicEntityId: null,
        entityAttributionSource: 'unattributed',
        status: 'completed',
        paymentStatus: 'paid',
        fulfillmentStatus: 'fulfilled',
        currency,
        subtotalAmount: lineSubtotal,
        totalAmount: lineSubtotal,
        placedAt: now
      })
      .returning();
    const order = insertedOrders[0];
    if (order === undefined) {
      throw new Error('manual order insert returned no row');
    }

    const insertedLines = await handle.db
      .insert(orderLines)
      .values({
        orderId: order.id,
        lineNumber: 1,
        catalogItemId: catalogItem.id,
        channelListingId: listing.id,
        channelSku: catalogItem.sku,
        title: listing.listingTitle ?? catalogItem.name,
        quantity: data.quantity,
        unitPrice: Number(data.unitPrice).toFixed(6),
        lineSubtotal,
        lineTotal: lineSubtotal
      })
      .returning();
    const line = insertedLines[0];
    if (line === undefined) {
      throw new Error('manual order line insert returned no row');
    }

    const remaining =
      listing.quantityAvailable === null
        ? null
        : Math.max(0, listing.quantityAvailable - Number(data.quantity));
    const listingStatus = remaining === 0 ? 'sold_out' : listing.status;
    await handle.db.execute(
      `update channel_listings
          set quantity_available = ${remaining === null ? 'null' : String(remaining)},
              status = ${textLiteral(listingStatus)},
              ended_at = ${listingStatus === 'sold_out' ? 'now()' : listing.endedAt ? `'${listing.endedAt.toISOString()}'::timestamptz` : 'null'},
              updated_at = now()
        where id = ${uuidLiteral(listing.id)}`
    );

    // Real @loxep/inventory writes: reserve then deplete-on-fulfillment. A
    // synthesized `orderFulfillmentId` is fine — that column is an
    // unconstrained uuid used only to compose the movement's deduplication
    // key (`packages/inventory/src/movements.ts`'s `movementKeys.depletionSale`),
    // and a manual sale has no real `order_fulfillments` row.
    const allocationsService = await getAllocationsService();
    await allocationsService.reserve({
      inventoryItemId: inventoryItem.id,
      allocationKind: 'order_line',
      orderLineId: line.id,
      quantity: data.quantity,
      createdByUserId: session.user.id
    });
    const depletion = await allocationsService.depleteOnFulfillment({
      orderFulfillmentId: randomUUID(),
      orderLineId: line.id,
      quantity: data.quantity,
      actorUserId: session.user.id
    });

    return {
      orderId: order.id,
      orderLineId: line.id,
      listingStatus,
      oversell: depletion.depletions.some((entry) => entry.oversell)
    };
  });
