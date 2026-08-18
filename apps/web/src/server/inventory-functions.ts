/**
 * Server functions for the /inventory workspace surfaces and the /market
 * "I bought this" handoff (loxep-dgf.2, M2).
 *
 * `@loxep/inventory` (items, acquisitions, acquisition_costs, movements,
 * locations, profitability — nine tables, eleven service modules, 125 tests)
 * shipped in Phase 4 with ZERO runtime consumers until this file. It is now
 * an `apps/web` dependency and `@/server/admin.ts` registers its five
 * services (`getItemsService`, `getAcquisitionsService`,
 * `getLocationsService`, `getMovementsService`,
 * `getOpportunityLinksService`) behind a lazy `@vite-ignore` dynamic import —
 * `@loxep/inventory/decimal.ts` imports bare `@loxep/commerce`, whose index
 * reaches `graphile-worker` via `@loxep/jobs`, the same SSR-bundling hazard
 * `@loxep/market`/`@loxep/notifications` carry (see `admin.ts`'s
 * `getInventoryModule` doc).
 *
 * What this file does:
 *
 *  - READS go straight through `@loxep/db` (`getAdminServices().handle.db.query.<table>`,
 *    the same pattern `@/server/market-functions.ts` and
 *    `@/server/dashboard-functions.ts` use) rather than the package's
 *    services, because every read here is a flat or joined select with no
 *    business rule attached — mirroring `packages/inventory/src/acquisitions.ts`'s
 *    own `landedCost` query for the one grouped aggregate. The six
 *    profitability read models (`acquisitionRoi`, `sourcingChannelPerformance`,
 *    `inventoryOnHandAtCost`, `inventoryAging`, `openLots`,
 *    `oversells`/`unmatchedDepletions`) are NOT wired here — composing
 *    revenue/refund/fee/shipping facts across `@loxep/commerce` correctly is
 *    exactly the logic those functions exist to not duplicate, and no
 *    surface in this milestone's file scope needs them yet.
 *  - WRITES call the real `@loxep/inventory` services through `@/server/admin.ts`,
 *    dynamically imported per handler (mirrors `@/server/market-functions.ts`),
 *    so the business logic (item code generation with retry, movement
 *    recording with append-only dedup keys and the single-writer
 *    `quantity_on_hand` cache, acquisition reference codes, attribution
 *    resolution, the largest-remainder cost allocation engine,
 *    opportunity-link idempotency) lives in exactly one place.
 *
 * Role gate: `requireSession` throughout, matching `/finance`'s reasoning —
 * recording stock or a lot is ordinary operator work, not an administrative
 * action.
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { mediaObjectPurpose, servingUrlFor } from '@/server/media-serving-url';
import type { ShipmentRow } from '@loxep/inventory';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// SQL literals for the one raw aggregate (`fetchAcquisitionCosts`'s landed-cost
// group-by-currency roll-up) — same discipline as `@/server/dashboard-functions.ts`:
// every interpolated value is validated here first.
// ---------------------------------------------------------------------------

const uuidSchema = z.uuid();

function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new Error('expected a UUID value');
  return `'${parsed.data}'`;
}

function decimal(value: unknown): string {
  return value === null || value === undefined ? '0.000000' : String(value);
}

// ---------------------------------------------------------------------------
// Items — stock list + detail
// ---------------------------------------------------------------------------

export interface InventoryItemListItemDto {
  id: string;
  itemCode: string;
  label: string;
  status: string;
  conditionCode: string;
  locationId: string | null;
  locationCode: string | null;
  locationName: string | null;
  quantity: string;
  quantityOnHand: string;
  currency: string;
  acquisitionCostAmount: string;
  landedCostAmount: string;
  estimatedValueAmount: string | null;
  acquisitionId: string | null;
  acquisitionReferenceCode: string | null;
  acquiredAt: string;
  createdAt: string;
}

const itemFilterInput = z.strictObject({
  status: z.string().trim().min(1).optional(),
  locationId: z.uuid().optional(),
  conditionCode: z.string().trim().min(1).optional()
});

const ITEM_LIST_LIMIT = 1000;

export const fetchInventoryItems = createServerFn({ method: 'GET' })
  .inputValidator(itemFilterInput)
  .handler(async ({ data }): Promise<InventoryItemListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.inventoryItems.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (data.status !== undefined) clauses.push(eq(table.status, data.status));
        if (data.locationId !== undefined) clauses.push(eq(table.locationId, data.locationId));
        if (data.conditionCode !== undefined) {
          clauses.push(eq(table.conditionCode, data.conditionCode));
        }
        return clauses.length > 0 ? and(...clauses) : undefined;
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: ITEM_LIST_LIMIT
    });
    if (rows.length === 0) return [];

    const locationIds = [
      ...new Set(rows.map((row) => row.locationId).filter((id): id is string => id !== null))
    ];
    const acquisitionIds = [
      ...new Set(rows.map((row) => row.acquisitionId).filter((id): id is string => id !== null))
    ];
    const [locations, acquisitions] = await Promise.all([
      locationIds.length > 0
        ? handle.db.query.inventoryLocations.findMany({
            where: (table, { inArray }) => inArray(table.id, locationIds),
            columns: { id: true, code: true, name: true }
          })
        : Promise.resolve([]),
      acquisitionIds.length > 0
        ? handle.db.query.acquisitions.findMany({
            where: (table, { inArray }) => inArray(table.id, acquisitionIds),
            columns: { id: true, referenceCode: true }
          })
        : Promise.resolve([])
    ]);
    const locationById = new Map(locations.map((location) => [location.id, location]));
    const referenceCodeByAcquisitionId = new Map(
      acquisitions.map((acquisition) => [acquisition.id, acquisition.referenceCode])
    );

    return rows.map((row) => {
      const location = row.locationId ? (locationById.get(row.locationId) ?? null) : null;
      return {
        id: row.id,
        itemCode: row.itemCode,
        label: row.label,
        status: row.status,
        conditionCode: row.conditionCode,
        locationId: row.locationId,
        locationCode: location?.code ?? null,
        locationName: location?.name ?? null,
        quantity: row.quantity,
        quantityOnHand: row.quantityOnHand,
        currency: row.currency,
        acquisitionCostAmount: row.acquisitionCostAmount,
        landedCostAmount: row.landedCostAmount,
        estimatedValueAmount: row.estimatedValueAmount,
        acquisitionId: row.acquisitionId,
        acquisitionReferenceCode: row.acquisitionId
          ? (referenceCodeByAcquisitionId.get(row.acquisitionId) ?? null)
          : null,
        acquiredAt: iso(row.acquiredAt),
        createdAt: iso(row.createdAt)
      };
    });
  });

export interface InventoryMovementDto {
  id: string;
  movementKind: string;
  quantity: string;
  locationId: string | null;
  locationCode: string | null;
  transferGroupId: string | null;
  /**
   * Provenance FKs the `inventory_movements` row actually carries
   * (loxep-1zg): dropping these made a `depletion_sale` movement a GUI dead
   * end — visible in the ledger with no way to trace WHY it happened (which
   * order line sold it, which allocation reserved it, which shipment carried
   * it, or which earlier movement a `reversal` undoes). None of these is a
   * link to a page that exists yet except `acquisitionId` (the item's own
   * "Sourced from" already shows THAT relationship at the item level; here
   * it is per-movement, e.g. distinguishing which lot a `receipt` restocked
   * from when an item spans more than one), so the rest render as plain
   * identifiers rather than fabricated links.
   */
  acquisitionId: string | null;
  inventoryAllocationId: string | null;
  orderLineId: string | null;
  shipmentId: string | null;
  reversesMovementId: string | null;
  reasonCode: string | null;
  note: string | null;
  occurredAt: string;
  recordedAt: string;
}

export interface MarketItemLinkDto {
  id: string;
  linkKind: string;
  marketplaceItemId: string | null;
  marketplaceItemTitle: string | null;
  marketEventId: string | null;
  scoreAtLink: string | null;
  targetPriceAmount: string | null;
  targetCurrency: string | null;
  linkedAt: string;
}

/** `inventory_item_specifics` row (M3, loxep-dgf.3) — typed key/value product specifics. */
export interface ItemSpecificDto {
  id: string;
  name: string;
  value: string;
  valueNumeric: string | null;
  unit: string | null;
  sortOrder: number;
  source: string;
}

/** One `media_links` row over the item's gallery (M3). Primary is whichever `gallery` row sorts first. */
export interface ItemMediaDto {
  mediaObjectId: string;
  purpose: string;
  sortOrder: number | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
  servingUrl: string;
}

export interface InventoryItemDetailDto extends InventoryItemListItemDto {
  lotReference: string | null;
  serialNumber: string | null;
  conditionNotes: string | null;
  gradingAuthority: string | null;
  gradeLabel: string | null;
  gradeNumeric: string | null;
  certificateNumber: string | null;
  costAllocationBasis: string;
  costBasisLockedAt: string | null;
  receivedAt: string | null;
  listedAt: string | null;
  depletedAt: string | null;
  /** `quantity_on_hand − sum(open reservations)`, read live (not cached). */
  availableToSell: string;
  movements: InventoryMovementDto[];
  /** The reverse `/market` wire: the marketplace item(s) this unit traces back to, snapshot-frozen at link time. */
  sourcedFrom: MarketItemLinkDto[];
  /** M3 enrichment (loxep-dgf.3): plain text/Markdown authoring source, never listing HTML. */
  description: string | null;
  /** M3: how this unit is going to be sold — see `ITEM_SALE_MODES`. */
  saleMode: string;
  packageWeightGrams: string | null;
  packageLengthMm: string | null;
  packageWidthMm: string | null;
  packageHeightMm: string | null;
  originItemId: string | null;
  /** Typed key/value product specifics, ordered by `sort_order` then `name`. */
  specifics: ItemSpecificDto[];
  /** The gallery, ordered by `sort_order` — the first `gallery`-purpose row is the primary image. */
  media: ItemMediaDto[];
}

export const fetchInventoryItem = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<InventoryItemDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getSpecificsService,
      getInventoryMediaService,
      getMediaService
    } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const item = await handle.db.query.inventoryItems.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (item === undefined) {
      throw new Error(`Inventory item "${data.id}" not found`);
    }

    const [
      location,
      acquisition,
      movementRows,
      linkRows,
      reserved,
      specificsService,
      inventoryMediaService
    ] = await Promise.all([
      item.locationId
        ? handle.db.query.inventoryLocations.findFirst({
            where: (table, { eq }) => eq(table.id, item.locationId as string),
            columns: { id: true, code: true, name: true }
          })
        : Promise.resolve(null),
      item.acquisitionId
        ? handle.db.query.acquisitions.findFirst({
            where: (table, { eq }) => eq(table.id, item.acquisitionId as string),
            columns: { id: true, referenceCode: true }
          })
        : Promise.resolve(null),
      handle.db.query.inventoryMovements.findMany({
        where: (table, { eq }) => eq(table.inventoryItemId, data.id),
        orderBy: (table, { desc }) => [desc(table.occurredAt)]
      }),
      handle.db.query.acquisitionOpportunityLinks.findMany({
        where: (table, { eq }) => eq(table.inventoryItemId, data.id),
        orderBy: (table, { desc }) => [desc(table.linkedAt)]
      }),
      // `availableToSell` — mirrors `@loxep/inventory/items.ts`'s own query verbatim:
      // on-hand minus the sum of `reserved`-status allocations. A single small
      // read, safe to reproduce (it is not an allocation of business rules,
      // just a computed availability figure).
      handle.db.execute(
        `select (i.quantity_on_hand - coalesce(a.reserved, 0))::numeric(20, 6)::text as available
           from inventory_items i
           left join (select inventory_item_id, sum(quantity) as reserved
                        from inventory_allocations
                       where status = 'reserved'
                       group by inventory_item_id) a
                  on a.inventory_item_id = i.id
          where i.id = ${uuidLiteral(data.id)}`
      ),
      getSpecificsService(),
      getInventoryMediaService()
    ]);

    const [specificRows, mediaLinkRows] = await Promise.all([
      specificsService.list(data.id),
      inventoryMediaService.list(data.id)
    ]);

    const movementLocationIds = [
      ...new Set(
        movementRows.map((row) => row.locationId).filter((id): id is string => id !== null)
      )
    ];
    const movementLocations =
      movementLocationIds.length > 0
        ? await handle.db.query.inventoryLocations.findMany({
            where: (table, { inArray }) => inArray(table.id, movementLocationIds),
            columns: { id: true, code: true }
          })
        : [];
    const movementLocationCodeById = new Map(movementLocations.map((row) => [row.id, row.code]));

    const marketItemIds = [
      ...new Set(
        linkRows.map((row) => row.marketplaceItemId).filter((id): id is string => id !== null)
      )
    ];
    const marketItems =
      marketItemIds.length > 0
        ? await handle.db.query.marketplaceItems.findMany({
            where: (table, { inArray }) => inArray(table.id, marketItemIds),
            columns: { id: true, title: true, externalItemId: true }
          })
        : [];
    const marketItemTitleById = new Map(
      marketItems.map((row) => [row.id, row.title ?? row.externalItemId])
    );

    // Mirrors `fetchExpense`'s `receiptsService.list` + per-link
    // `mediaService.getMediaObject` composition: the link carries no
    // filename/mime/size of its own.
    const mediaService = await getMediaService();
    const mediaDtos: ItemMediaDto[] = await Promise.all(
      mediaLinkRows.map(async (link): Promise<ItemMediaDto> => {
        const mediaObject = await mediaService.getMediaObject(link.mediaObjectId);
        return {
          mediaObjectId: link.mediaObjectId,
          purpose: link.purpose,
          sortOrder: link.sortOrder,
          originalFilename: mediaObject.originalFilename,
          mimeType: mediaObject.mimeType,
          sizeBytes: mediaObject.sizeBytes,
          createdAt: iso(link.createdAt),
          servingUrl: `/api/media/inventory/${link.mediaObjectId}`
        };
      })
    );

    return {
      id: item.id,
      itemCode: item.itemCode,
      label: item.label,
      status: item.status,
      conditionCode: item.conditionCode,
      locationId: item.locationId,
      locationCode: location?.code ?? null,
      locationName: location?.name ?? null,
      quantity: item.quantity,
      quantityOnHand: item.quantityOnHand,
      currency: item.currency,
      acquisitionCostAmount: item.acquisitionCostAmount,
      landedCostAmount: item.landedCostAmount,
      estimatedValueAmount: item.estimatedValueAmount,
      acquisitionId: item.acquisitionId,
      acquisitionReferenceCode: acquisition?.referenceCode ?? null,
      acquiredAt: iso(item.acquiredAt),
      createdAt: iso(item.createdAt),
      lotReference: item.lotReference,
      serialNumber: item.serialNumber,
      conditionNotes: item.conditionNotes,
      gradingAuthority: item.gradingAuthority,
      gradeLabel: item.gradeLabel,
      gradeNumeric: item.gradeNumeric,
      certificateNumber: item.certificateNumber,
      costAllocationBasis: item.costAllocationBasis,
      costBasisLockedAt: iso(item.costBasisLockedAt),
      receivedAt: iso(item.receivedAt),
      listedAt: iso(item.listedAt),
      depletedAt: iso(item.depletedAt),
      availableToSell: decimal(reserved.rows[0]?.['available']),
      description: item.description,
      saleMode: item.saleMode,
      packageWeightGrams: item.packageWeightGrams,
      packageLengthMm: item.packageLengthMm,
      packageWidthMm: item.packageWidthMm,
      packageHeightMm: item.packageHeightMm,
      originItemId: item.originItemId,
      specifics: specificRows.map((row) => ({
        id: row.id,
        name: row.name,
        value: row.value,
        valueNumeric: row.valueNumeric,
        unit: row.unit,
        sortOrder: row.sortOrder,
        source: row.source
      })),
      media: mediaDtos,
      movements: movementRows.map((row) => ({
        id: row.id,
        movementKind: row.movementKind,
        quantity: row.quantity,
        locationId: row.locationId,
        locationCode: row.locationId
          ? (movementLocationCodeById.get(row.locationId) ?? null)
          : null,
        transferGroupId: row.transferGroupId,
        acquisitionId: row.acquisitionId,
        inventoryAllocationId: row.inventoryAllocationId,
        orderLineId: row.orderLineId,
        shipmentId: row.shipmentId,
        reversesMovementId: row.reversesMovementId,
        reasonCode: row.reasonCode,
        note: row.note,
        occurredAt: iso(row.occurredAt),
        recordedAt: iso(row.recordedAt)
      })),
      sourcedFrom: linkRows.map((row) => ({
        id: row.id,
        linkKind: row.linkKind,
        marketplaceItemId: row.marketplaceItemId,
        marketplaceItemTitle: row.marketplaceItemId
          ? (marketItemTitleById.get(row.marketplaceItemId) ?? null)
          : null,
        marketEventId: row.marketEventId,
        scoreAtLink: row.scoreAtLink,
        targetPriceAmount: row.targetPriceAmount,
        targetCurrency: row.targetCurrency,
        linkedAt: iso(row.linkedAt)
      }))
    };
  });

/**
 * `createItemsService(...).create(...)` — see `packages/inventory/src/items.ts`.
 * This is the create half of the intake review screen (loxep-dgf.2's "one
 * surface serving three producers" — hand entry today; an ingested eBay
 * purchase and a parsed receipt land in the same shape in a later
 * milestone). The input shape mirrors `CreateItemInput` field-for-field.
 */
const createInventoryItemInput = z.strictObject({
  label: z.string().trim().min(1),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  acquisitionId: z.uuid().nullish(),
  locationId: z.uuid().nullish(),
  lotReference: z.string().trim().min(1).nullish(),
  serialNumber: z.string().trim().min(1).nullish(),
  conditionCode: z
    .enum([
      'new_sealed',
      'new_open_box',
      'like_new',
      'very_good',
      'good',
      'acceptable',
      'for_parts',
      'damaged',
      'unknown'
    ])
    .default('unknown'),
  conditionNotes: z.string().trim().min(1).nullish(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('1'),
  acquisitionCostAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .optional(),
  estimatedValueAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullish(),
  /**
   * A27 (loxep-wx3) — `ItemsService.create`'s own schema already accepts
   * this (`packages/inventory/src/items.ts:108`); see `createAcquisitionInput`'s
   * `economicEntityId` doc above for the same undefined-vs-null distinction.
   * Without it, every item created through the UI landed
   * `entity_attribution_source: 'unattributed'` permanently.
   */
  economicEntityId: z.uuid().nullish()
});

export const createInventoryItem = createServerFn({ method: 'POST' })
  .inputValidator(createInventoryItemInput)
  .handler(async ({ data }): Promise<{ id: string; itemCode: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    const session = await requireSession();
    const itemsService = await getItemsService();
    const item = await itemsService.create({
      label: data.label,
      currency: data.currency,
      acquisitionId: data.acquisitionId,
      locationId: data.locationId,
      lotReference: data.lotReference,
      serialNumber: data.serialNumber,
      conditionCode: data.conditionCode,
      conditionNotes: data.conditionNotes,
      quantity: data.quantity,
      ...(data.acquisitionCostAmount !== undefined
        ? { acquisitionCostAmount: data.acquisitionCostAmount }
        : {}),
      estimatedValueAmount: data.estimatedValueAmount,
      economicEntityId: data.economicEntityId,
      createdByUserId: session.user.id
    });
    return { id: item.id, itemCode: item.itemCode };
  });

/**
 * "Complete review" — the ONLY exit from `intake` (`itemsService.completeIntakeReview`,
 * `packages/inventory/src/items.ts`). Status-only: no quantity or movement
 * changes. Session-gated like every other write here — completing a review
 * is ordinary operator work, not an administrative action. The service
 * refuses (`InventoryValidationError`) when the item is not currently
 * `intake`, which reaches the caller as a mutation error.
 */
export const completeItemIntakeReview = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string; status: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    await requireSession();
    const itemsService = await getItemsService();
    const item = await itemsService.completeIntakeReview(data.id);
    return { id: item.id, status: item.status };
  });

// ---------------------------------------------------------------------------
// M3 enrichment (loxep-dgf.3): description/dimensions/weight, the sale-mode
// declaration, part-out, and typed specifics. `itemsService.update()` /
// `.setSaleMode()` / `.partOut()` — see `packages/inventory/src/items.ts`.
// ---------------------------------------------------------------------------

const decimalInput = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive decimal, e.g. 850 or 850.5');

const updateInventoryItemInput = z.strictObject({
  id: z.uuid(),
  description: z.string().trim().min(1).nullish(),
  packageWeightGrams: decimalInput.nullish(),
  packageLengthMm: decimalInput.nullish(),
  packageWidthMm: decimalInput.nullish(),
  packageHeightMm: decimalInput.nullish()
});

export const updateInventoryItem = createServerFn({ method: 'POST' })
  .inputValidator(updateInventoryItemInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    await requireSession();
    const itemsService = await getItemsService();
    const item = await itemsService.update({
      inventoryItemId: data.id,
      description: data.description,
      packageWeightGrams: data.packageWeightGrams,
      packageLengthMm: data.packageLengthMm,
      packageWidthMm: data.packageWidthMm,
      packageHeightMm: data.packageHeightMm
    });
    return { id: item.id };
  });

/**
 * The declaration only — `'parted_out'` is deliberately absent from this
 * enum (matches `settableSaleModes`, `packages/inventory/src/items.ts`), so
 * a caller cannot even construct a request for it. The service refuses the
 * change again at the domain layer if the item has already been parted out.
 */
export const setInventoryItemSaleMode = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      id: z.uuid(),
      saleMode: z.enum(['unit', 'lot', 'set', 'parts_donor', 'bundle_component'])
    })
  )
  .handler(async ({ data }): Promise<{ id: string; saleMode: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    const session = await requireSession();
    const itemsService = await getItemsService();
    const item = await itemsService.setSaleMode({
      inventoryItemId: data.id,
      saleMode: data.saleMode,
      actorUserId: session.user.id
    });
    return { id: item.id, saleMode: item.saleMode };
  });

/**
 * `itemsService.partOut(...)` — the one new inventory verb. See that
 * function's doc: N children, basis divided by `distributeByWeights`, the
 * parent depleted through the movement writer and marked `parted_out`.
 */
const partOutInput = z.strictObject({
  id: z.uuid(),
  children: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1),
        quantity: z
          .string()
          .trim()
          .regex(/^\d+(\.\d{1,6})?$/)
          .default('1'),
        weight: decimalInput.optional()
      })
    )
    .min(1)
    .max(200),
  note: z.string().trim().min(1).nullish()
});

export const partOutInventoryItem = createServerFn({ method: 'POST' })
  .inputValidator(partOutInput)
  .handler(
    async ({ data }): Promise<{ parentId: string; childIds: string[]; childCodes: string[] }> => {
      const { requireSession, getItemsService } = await import('@/server/admin');
      const session = await requireSession();
      const itemsService = await getItemsService();
      const result = await itemsService.partOut({
        inventoryItemId: data.id,
        children: data.children.map((child) => ({
          label: child.label,
          quantity: child.quantity,
          ...(child.weight !== undefined ? { weight: child.weight } : {})
        })),
        note: data.note,
        actorUserId: session.user.id
      });
      return {
        parentId: result.parent.id,
        childIds: result.children.map((child) => child.id),
        childCodes: result.children.map((child) => child.itemCode)
      };
    }
  );

/** `specificsService.set(...)` — upserts on `(inventory_item_id, name, value)`. */
const setSpecificInput = z.strictObject({
  inventoryItemId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(2000),
  unit: z.string().trim().min(1).max(32).nullish()
});

export const setInventoryItemSpecific = createServerFn({ method: 'POST' })
  .inputValidator(setSpecificInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getSpecificsService } = await import('@/server/admin');
    const session = await requireSession();
    const specificsService = await getSpecificsService();
    const { specific } = await specificsService.set({
      inventoryItemId: data.inventoryItemId,
      name: data.name,
      value: data.value,
      unit: data.unit,
      source: 'manual',
      actorUserId: session.user.id
    });
    return { id: specific.id };
  });

export const removeInventoryItemSpecific = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      inventoryItemId: z.uuid(),
      name: z.string().trim().min(1),
      value: z.string().trim().min(1)
    })
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireSession, getSpecificsService } = await import('@/server/admin');
    const session = await requireSession();
    const specificsService = await getSpecificsService();
    await specificsService.remove({
      inventoryItemId: data.inventoryItemId,
      name: data.name,
      value: data.value,
      actorUserId: session.user.id
    });
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Item media gallery (loxep-dgf.3) — attach happens through the binary
// upload route (`routes/api.inventory.image.ts`), mirroring the receipt/
// avatar upload split. Detach and reorder are plain JSON calls.
// ---------------------------------------------------------------------------

const itemMediaPurpose = z
  .enum(['gallery', 'condition_evidence', 'supporting_document'])
  .default('gallery');

export const detachInventoryItemMedia = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      inventoryItemId: z.uuid(),
      mediaObjectId: z.uuid(),
      purpose: itemMediaPurpose
    })
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireSession, getInventoryMediaService } = await import('@/server/admin');
    const session = await requireSession();
    const inventoryMediaService = await getInventoryMediaService();
    await inventoryMediaService.detach({
      inventoryItemId: data.inventoryItemId,
      mediaObjectId: data.mediaObjectId,
      purpose: data.purpose,
      actorUserId: session.user.id
    });
    return { ok: true };
  });

/**
 * Simple up/down reorder (the design's sanctioned "drag-to-reorder writes
 * sort_order only" rule, applied without DnD Kit): the caller passes the two
 * media objects trading places and the `sort_order` each should take.
 */
export const reorderInventoryItemMedia = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      inventoryItemId: z.uuid(),
      purpose: itemMediaPurpose,
      moves: z
        .array(z.strictObject({ mediaObjectId: z.uuid(), sortOrder: z.number().int().min(0) }))
        .min(1)
        .max(2)
    })
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireSession, getInventoryMediaService } = await import('@/server/admin');
    await requireSession();
    const inventoryMediaService = await getInventoryMediaService();
    for (const move of data.moves) {
      await inventoryMediaService.reorder({
        inventoryItemId: data.inventoryItemId,
        purpose: data.purpose,
        mediaObjectId: move.mediaObjectId,
        sortOrder: move.sortOrder
      });
    }
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface InventoryLocationDto {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentLocationId: string | null;
  path: string;
  depth: number;
  isDefault: boolean;
  active: boolean;
  notes: string | null;
}

export const fetchInventoryLocations = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InventoryLocationDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const rows = await handle.db.query.inventoryLocations.findMany({
      orderBy: (table, { asc }) => [asc(table.path)]
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      parentLocationId: row.parentLocationId,
      path: row.path,
      depth: row.depth,
      isDefault: row.isDefault,
      active: row.active,
      notes: row.notes
    }));
  }
);

/**
 * `createLocationsService({ db }).create(...)` (loxep-wx3, A6) —
 * `LocationsService.create`/`setParent`/`subtree`/`getDefault`/
 * `reconcilePaths` all had zero callers, and `getLocationsService` was
 * referenced only in a doc comment: `/inventory/locations` was read-only and
 * a fresh install could never create the first location, which left the
 * `locationId` field on intake and the location filter on `/inventory/stock`
 * permanently empty. Mounts the existing `create` verb; `code`'s validation
 * (scannable label, no `/`) mirrors `@loxep/inventory/locations.ts`'s own
 * `codeSchema` exactly, since the service's own error is the only refusal
 * surfaced to the operator either way.
 */
const createLocationInput = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .refine((value) => !value.includes('/')),
  name: z.string().trim().min(1),
  kind: z.enum(['site', 'room', 'area', 'shelf', 'bin', 'container', 'vehicle', 'in_transit']),
  parentLocationId: z.uuid().nullish(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().trim().min(1).nullish()
});

export const createLocation = createServerFn({ method: 'POST' })
  .inputValidator(createLocationInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getLocationsService } = await import('@/server/admin');
    await requireSession();
    const locationsService = await getLocationsService();
    const location = await locationsService.create({
      code: data.code,
      name: data.name,
      kind: data.kind,
      parentLocationId: data.parentLocationId,
      isDefault: data.isDefault,
      active: data.active,
      notes: data.notes
    });
    return { id: location.id };
  });

/** `createLocationsService({ db }).setParent(...)` — the "Move to parent" row action. */
export const setLocationParent = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ locationId: z.uuid(), parentLocationId: z.uuid().nullable() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getLocationsService } = await import('@/server/admin');
    await requireSession();
    const locationsService = await getLocationsService();
    const location = await locationsService.setParent({
      locationId: data.locationId,
      parentLocationId: data.parentLocationId
    });
    return { id: location.id };
  });

// ---------------------------------------------------------------------------
// Movements ledger (all items, filterable) — `/inventory/movements`
// ---------------------------------------------------------------------------

const movementFilterInput = z.strictObject({
  inventoryItemId: z.uuid().optional(),
  acquisitionId: z.uuid().optional(),
  movementKind: z.string().trim().min(1).optional()
});

const MOVEMENT_LIST_LIMIT = 500;

export interface InventoryMovementListItemDto extends InventoryMovementDto {
  inventoryItemId: string;
  itemCode: string;
  itemLabel: string;
}

export const fetchInventoryMovements = createServerFn({ method: 'GET' })
  .inputValidator(movementFilterInput)
  .handler(async ({ data }): Promise<InventoryMovementListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.inventoryMovements.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (data.inventoryItemId !== undefined) {
          clauses.push(eq(table.inventoryItemId, data.inventoryItemId));
        }
        if (data.acquisitionId !== undefined)
          clauses.push(eq(table.acquisitionId, data.acquisitionId));
        if (data.movementKind !== undefined)
          clauses.push(eq(table.movementKind, data.movementKind));
        return clauses.length > 0 ? and(...clauses) : undefined;
      },
      orderBy: (table, { desc }) => [desc(table.occurredAt)],
      limit: MOVEMENT_LIST_LIMIT
    });
    if (rows.length === 0) return [];

    const itemIds = [...new Set(rows.map((row) => row.inventoryItemId))];
    const locationIds = [
      ...new Set(rows.map((row) => row.locationId).filter((id): id is string => id !== null))
    ];
    const [items, locations] = await Promise.all([
      handle.db.query.inventoryItems.findMany({
        where: (table, { inArray }) => inArray(table.id, itemIds),
        columns: { id: true, itemCode: true, label: true }
      }),
      locationIds.length > 0
        ? handle.db.query.inventoryLocations.findMany({
            where: (table, { inArray }) => inArray(table.id, locationIds),
            columns: { id: true, code: true }
          })
        : Promise.resolve([])
    ]);
    const itemById = new Map(items.map((row) => [row.id, row]));
    const locationCodeById = new Map(locations.map((row) => [row.id, row.code]));

    return rows
      .map((row) => {
        const item = itemById.get(row.inventoryItemId);
        if (item === undefined) return null;
        return {
          id: row.id,
          inventoryItemId: row.inventoryItemId,
          itemCode: item.itemCode,
          itemLabel: item.label,
          movementKind: row.movementKind,
          quantity: row.quantity,
          locationId: row.locationId,
          locationCode: row.locationId ? (locationCodeById.get(row.locationId) ?? null) : null,
          transferGroupId: row.transferGroupId,
          acquisitionId: row.acquisitionId,
          inventoryAllocationId: row.inventoryAllocationId,
          orderLineId: row.orderLineId,
          shipmentId: row.shipmentId,
          reversesMovementId: row.reversesMovementId,
          reasonCode: row.reasonCode,
          note: row.note,
          occurredAt: iso(row.occurredAt),
          recordedAt: iso(row.recordedAt)
        };
      })
      .filter((row): row is InventoryMovementListItemDto => row !== null);
  });

export interface InventoryMovementTrendRowDto {
  movementKind: string;
  quantity: string;
  occurredAt: string;
}

const MOVEMENT_TREND_WINDOW_DAYS = 90;

/**
 * BOUNDED new read (loxep-8e2, priority 1): "am I receiving faster than
 * selling, and is shrinkage trending up" needs a genuine calendar trend, not
 * `fetchInventoryMovements`'s `MOVEMENT_LIST_LIMIT = 500` most-recent-N
 * across every item — at any real movement volume 500 rows spans hours, not
 * weeks, so reusing that query's cache would silently mislabel a few hours
 * of activity as a trend. This reads `inventory_movements` bounded to
 * `occurred_at >= now() - 90 days` (stated here, not re-derived per caller),
 * with no additional row cap. It returns bare kind/quantity/day rows rather
 * than a server-side aggregate so the day+kind bucketing stays a pure,
 * independently testable client function (`shapeMovementsTrend`), mirroring
 * `market-functions.ts`'s `shapePriceTrends` split.
 */
export const fetchInventoryMovementTrend = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InventoryMovementTrendRowDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const since = new Date(Date.now() - MOVEMENT_TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const rows = await handle.db.query.inventoryMovements.findMany({
      where: (table, { gte }) => gte(table.occurredAt, since),
      columns: { movementKind: true, quantity: true, occurredAt: true },
      orderBy: (table, { asc }) => [asc(table.occurredAt)]
    });

    return rows.map((row) => ({
      movementKind: row.movementKind,
      quantity: row.quantity,
      occurredAt: iso(row.occurredAt)
    }));
  }
);

/**
 * `createMovementsService({ db }).record(...)` (loxep-wx3, A8) —
 * `record`/`reverse`/`ledgerBalance`/`reconcile` had zero callers: no
 * cycle-count adjustment, found stock, shrinkage, disposal, or consumption
 * could be entered, and the ledger is append-only by trigger, so `reverse`
 * is the ONLY correction path once a bad row exists. This exposes the
 * "manual adjustment" subset of `movementKind` — `adjustment_in`/
 * `adjustment_out` (cycle counts), `found`, `shrinkage`, `disposal`,
 * `consumption` — never `receipt`/`transfer_*`/`depletion_sale`/`reversal`,
 * which are written by other flows (intake, `moveToLocation`, a sale,
 * `reverse` itself) and would double-book if entered here too.
 * `deduplicationKey` is generated per submission (`randomUUID()`) — an
 * operator-typed adjustment is, by construction, a new fact each time, never
 * a replay of a prior one.
 */
const MANUAL_MOVEMENT_KINDS = [
  'adjustment_in',
  'adjustment_out',
  'found',
  'shrinkage',
  'disposal',
  'consumption'
] as const;

const recordInventoryMovementInput = z.strictObject({
  inventoryItemId: z.uuid(),
  movementKind: z.enum(MANUAL_MOVEMENT_KINDS),
  /** SIGNED. Positive increases on-hand, negative decreases it — validated against `movementKind`'s own sign requirement server-side by `@loxep/inventory`. */
  quantity: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/),
  locationId: z.uuid().nullish(),
  reasonCode: z.string().trim().min(1).nullish(),
  note: z.string().trim().min(1).nullish()
});

export interface RecordInventoryMovementResultDto {
  id: string;
  created: boolean;
  quantityOnHand: string;
  oversell: boolean;
}

export const recordInventoryMovement = createServerFn({ method: 'POST' })
  .inputValidator(recordInventoryMovementInput)
  .handler(async ({ data }): Promise<RecordInventoryMovementResultDto> => {
    const { requireSession, getMovementsService } = await import('@/server/admin');
    const session = await requireSession();
    const movementsService = await getMovementsService();
    const result = await movementsService.record({
      inventoryItemId: data.inventoryItemId,
      movementKind: data.movementKind,
      quantity: data.quantity,
      locationId: data.locationId,
      reasonCode: data.reasonCode,
      note: data.note,
      deduplicationKey: randomUUID(),
      actorUserId: session.user.id
    });
    return {
      id: result.movement.id,
      created: result.created,
      quantityOnHand: result.quantityOnHand,
      oversell: result.oversell
    };
  });

/**
 * `createMovementsService({ db }).reverse(...)` — the ONLY correction path
 * for an append-only ledger row: writes a `reversal` movement of the
 * opposite sign, deterministically deduplicated on the original movement's
 * own id (`@loxep/inventory/movements.ts`'s `movementKeys.reversal`), so
 * reversing the same movement twice is a no-op rather than a double
 * correction.
 */
const reverseInventoryMovementInput = z.strictObject({
  movementId: z.uuid(),
  reasonCode: z.string().trim().min(1).nullish(),
  note: z.string().trim().min(1).nullish()
});

export const reverseInventoryMovement = createServerFn({ method: 'POST' })
  .inputValidator(reverseInventoryMovementInput)
  .handler(async ({ data }): Promise<RecordInventoryMovementResultDto> => {
    const { requireSession, getMovementsService } = await import('@/server/admin');
    const session = await requireSession();
    const movementsService = await getMovementsService();
    const result = await movementsService.reverse({
      movementId: data.movementId,
      reasonCode: data.reasonCode,
      note: data.note,
      actorUserId: session.user.id
    });
    return {
      id: result.movement.id,
      created: result.created,
      quantityOnHand: result.quantityOnHand,
      oversell: result.oversell
    };
  });

// ---------------------------------------------------------------------------
// Item actions — row/detail actions on `/inventory/stock/$id` (loxep-wx3, A8):
// `ItemsService.moveToLocation`/`setCondition`/`transferEntity` had zero
// callers. `correctCostBasis` (the ONLY way a locked cost basis changes,
// audited) is deliberately NOT mounted here — see this pass's own report.
// ---------------------------------------------------------------------------

const moveItemToLocationInput = z.strictObject({
  inventoryItemId: z.uuid(),
  toLocationId: z.uuid(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/)
    .nullish(),
  note: z.string().trim().min(1).nullish()
});

export const moveItemToLocation = createServerFn({ method: 'POST' })
  .inputValidator(moveItemToLocationInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    const session = await requireSession();
    const itemsService = await getItemsService();
    const result = await itemsService.moveToLocation({
      inventoryItemId: data.inventoryItemId,
      toLocationId: data.toLocationId,
      quantity: data.quantity ?? undefined,
      note: data.note,
      actorUserId: session.user.id
    });
    return { id: result.destinationItem.id };
  });

const setItemConditionInput = z.strictObject({
  inventoryItemId: z.uuid(),
  conditionCode: z.enum([
    'new_sealed',
    'new_open_box',
    'like_new',
    'very_good',
    'good',
    'acceptable',
    'for_parts',
    'damaged',
    'unknown'
  ]),
  conditionNotes: z.string().trim().min(1).nullish()
});

export const setItemCondition = createServerFn({ method: 'POST' })
  .inputValidator(setItemConditionInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    await requireSession();
    const itemsService = await getItemsService();
    const item = await itemsService.setCondition({
      inventoryItemId: data.inventoryItemId,
      conditionCode: data.conditionCode,
      conditionNotes: data.conditionNotes
    });
    return { id: item.id };
  });

const transferItemEntityInput = z.strictObject({
  inventoryItemId: z.uuid(),
  toEconomicEntityId: z.uuid(),
  basisTreatment: z.enum(['carryover', 'fair_market_value']),
  fairMarketValueAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullish(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/)
    .nullish(),
  toLocationId: z.uuid().nullish(),
  note: z.string().trim().min(1).nullish()
});

export const transferItemEntity = createServerFn({ method: 'POST' })
  .inputValidator(transferItemEntityInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    const session = await requireSession();
    const itemsService = await getItemsService();
    const result = await itemsService.transferEntity({
      inventoryItemId: data.inventoryItemId,
      toEconomicEntityId: data.toEconomicEntityId,
      basisTreatment: data.basisTreatment,
      fairMarketValueAmount: data.fairMarketValueAmount ?? undefined,
      quantity: data.quantity ?? undefined,
      toLocationId: data.toLocationId,
      note: data.note,
      actorUserId: session.user.id
    });
    return { id: result.destinationItem.id };
  });

/**
 * `createItemsService({ db }).reattribute(...)` (loxep-wx3, A27) — the
 * bulk correction for a default that was never a decision (rewrites only
 * rows whose `entity_attribution_source` is `installation_default`/
 * `acquisition_default`/`connection_default`/`unattributed`; a `manual` row
 * is never touched, per `@loxep/inventory/attribution.ts`'s own module doc).
 * Mounted scoped to one lot's items — the acquisition detail page's own
 * "Reattribute this lot's items" action — since `reattribute` has no
 * single-item filter of its own, only `acquisitionId`/`acquiredBefore`.
 */
const reattributeInventoryItemsInput = z.strictObject({
  economicEntityId: z.uuid().nullable(),
  acquisitionId: z.uuid()
});

export const reattributeInventoryItems = createServerFn({ method: 'POST' })
  .inputValidator(reattributeInventoryItemsInput)
  .handler(async ({ data }): Promise<{ updated: number }> => {
    const { requireSession, getItemsService } = await import('@/server/admin');
    const session = await requireSession();
    const itemsService = await getItemsService();
    return itemsService.reattribute({
      economicEntityId: data.economicEntityId,
      acquisitionId: data.acquisitionId,
      actorUserId: session.user.id
    });
  });

// ---------------------------------------------------------------------------
// Acquisitions — lot list + detail, cost breakdown
// ---------------------------------------------------------------------------

export interface AcquisitionListItemDto {
  id: string;
  referenceCode: string;
  title: string;
  sourceKind: string;
  status: string;
  vendorName: string | null;
  currency: string;
  costAllocationBasis: string;
  costAllocationStatus: string;
  itemCount: number;
  acquiredAt: string;
  createdAt: string;
  /**
   * Set when this lot came from a connector sync (e.g. eBay purchase-history
   * ingestion, loxep-dgf.5) rather than an operator typing it in — the
   * "imported, review it" signal the acquisitions list badges on `sourceKind`.
   */
  connectionId: string | null;
}

const acquisitionFilterInput = z.strictObject({
  status: z.string().trim().min(1).optional(),
  sourceKind: z.string().trim().min(1).optional(),
  connectionId: z.uuid().optional()
});

const ACQUISITION_LIST_LIMIT = 500;

export const fetchAcquisitions = createServerFn({ method: 'GET' })
  .inputValidator(acquisitionFilterInput)
  .handler(async ({ data }): Promise<AcquisitionListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.acquisitions.findMany({
      where: (table, { and, eq }) => {
        const clauses = [];
        if (data.status !== undefined) clauses.push(eq(table.status, data.status));
        if (data.sourceKind !== undefined) clauses.push(eq(table.sourceKind, data.sourceKind));
        if (data.connectionId !== undefined)
          clauses.push(eq(table.connectionId, data.connectionId));
        return clauses.length > 0 ? and(...clauses) : undefined;
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: ACQUISITION_LIST_LIMIT
    });
    if (rows.length === 0) return [];

    const acquisitionIds = rows.map((row) => row.id);
    const itemRows = await handle.db.query.inventoryItems.findMany({
      where: (table, { inArray }) => inArray(table.acquisitionId, acquisitionIds),
      columns: { acquisitionId: true }
    });
    const itemCountByAcquisitionId = new Map<string, number>();
    for (const row of itemRows) {
      if (row.acquisitionId === null) continue;
      itemCountByAcquisitionId.set(
        row.acquisitionId,
        (itemCountByAcquisitionId.get(row.acquisitionId) ?? 0) + 1
      );
    }

    return rows.map((row) => ({
      id: row.id,
      referenceCode: row.referenceCode,
      title: row.title,
      sourceKind: row.sourceKind,
      status: row.status,
      vendorName: row.vendorName,
      currency: row.currency,
      costAllocationBasis: row.costAllocationBasis,
      costAllocationStatus: row.costAllocationStatus,
      itemCount: itemCountByAcquisitionId.get(row.id) ?? 0,
      acquiredAt: iso(row.acquiredAt),
      createdAt: iso(row.createdAt),
      connectionId: row.connectionId
    }));
  });

export interface AcquisitionCostDto {
  id: string;
  costScope: string;
  costType: string;
  costClass: string;
  capitalize: boolean;
  description: string | null;
  vendorName: string | null;
  currency: string;
  amount: string;
  inventoryItemId: string | null;
  incurredAt: string | null;
  createdAt: string;
}

/** Grouped by currency, per the design's rule — never summed across. */
export interface LandedCostGroupDto {
  currency: string;
  goodsAmount: string;
  ancillaryAmount: string;
  landedCostAmount: string;
  /** `capitalize = false` rows: real spend, excluded from basis. */
  nonCapitalizedAmount: string;
}

export interface LinkedExpenseHintDto {
  expenseId: string;
  referenceCode: string;
  expenseDate: string;
  currency: string;
  amount: string;
  category: string;
}

export interface AcquisitionDetailDto extends AcquisitionListItemDto {
  vendorLocation: string | null;
  externalReference: string | null;
  connectionId: string | null;
  /**
   * `connections.name`, resolved so the "Imported — needs review" badge can
   * link to the connection instead of just naming the fact that one exists
   * (loxep-1zg) — there is no per-connection detail route yet, so the badge
   * links to the unified `/settings/connections` table pre-filtered to this
   * name via its "Account" search filter. `null` when `connectionId` is
   * `null`, or in the (should-not-happen) case the connection row is gone.
   */
  connectionName: string | null;
  expectedItemCount: number | null;
  notes: string | null;
  receivedAt: string | null;
  costs: AcquisitionCostDto[];
  landedCost: LandedCostGroupDto[];
  items: InventoryItemListItemDto[];
  /**
   * Costs promoted from a `/finance` expense (`expenses.acquisition_cost_id`)
   * — the acquisition seam, read the other direction from
   * `ExpenseDetail`'s "linked to a lot's cost" alert. A real read against
   * `@loxep/accounting`'s `expenses` table (already an `apps/web`
   * dependency); no `@loxep/inventory` needed for this hint.
   */
  linkedExpenses: LinkedExpenseHintDto[];
  sourcedFrom: MarketItemLinkDto[];
  evidence: AcquisitionEvidenceDto[];
}

/**
 * A `media_links(resource_type='acquisition', purpose='invoice')` row —
 * `confirmCandidatesAsAcquisition`'s (loxep-cd3.6, M6) evidence attach, the
 * acquisition-side sibling of `ReceiptGallery`'s expense receipts. Read-only
 * here: upload/detach affordances are a separate surface this milestone does
 * not build (the write path is the confirm function; nothing here writes a
 * `media_links` row).
 */
export interface AcquisitionEvidenceDto {
  mediaObjectId: string;
  originalFilename: string | null;
  purpose: string;
  servingUrl: string | null;
  createdAt: string;
}

export const fetchAcquisition = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<AcquisitionDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const acquisition = await handle.db.query.acquisitions.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (acquisition === undefined) {
      throw new Error(`Acquisition "${data.id}" not found`);
    }

    const [costRows, itemRows, linkRows, landedCostResult, connection, evidenceLinkRows] =
      await Promise.all([
        handle.db.query.acquisitionCosts.findMany({
          where: (table, { eq }) => eq(table.acquisitionId, data.id),
          orderBy: (table, { asc }) => [asc(table.createdAt)]
        }),
        handle.db.query.inventoryItems.findMany({
          where: (table, { eq }) => eq(table.acquisitionId, data.id),
          orderBy: (table, { asc }) => [asc(table.createdAt)]
        }),
        handle.db.query.acquisitionOpportunityLinks.findMany({
          where: (table, { eq }) => eq(table.acquisitionId, data.id),
          orderBy: (table, { desc }) => [desc(table.linkedAt)]
        }),
        // Reproduces `@loxep/inventory/acquisitions.ts`'s `landedCost` query
        // verbatim — a grouped SUM with no allocation logic, safe to mirror.
        handle.db.execute(
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
          where acquisition_id = ${uuidLiteral(data.id)}
          group by currency
          order by currency`
        ),
        acquisition.connectionId
          ? handle.db.query.connections.findFirst({
              where: (table, { eq }) => eq(table.id, acquisition.connectionId as string),
              columns: { name: true }
            })
          : Promise.resolve(null),
        // Evidence attached by `confirmCandidatesAsAcquisition` (loxep-cd3.6,
        // M6) as `resource_type = 'acquisition'` — a plain `text` column with
        // no `CHECK`, matching `@loxep/inventory/confirm.ts`'s own reasoning
        // for writing it without a schema-level constant.
        handle.db.query.mediaLinks.findMany({
          where: (table, { and, eq }) =>
            and(eq(table.resourceType, 'acquisition'), eq(table.resourceId, data.id)),
          orderBy: (table, { asc }) => [asc(table.createdAt)]
        })
      ]);

    const costIds = costRows.map((row) => row.id);
    const linkedExpenseRows =
      costIds.length > 0
        ? await handle.db.query.expenses.findMany({
            where: (table, { inArray }) => inArray(table.acquisitionCostId, costIds),
            orderBy: (table, { desc }) => [desc(table.expenseDate)]
          })
        : [];

    const locationIds = [
      ...new Set(itemRows.map((row) => row.locationId).filter((id): id is string => id !== null))
    ];
    const locations =
      locationIds.length > 0
        ? await handle.db.query.inventoryLocations.findMany({
            where: (table, { inArray }) => inArray(table.id, locationIds),
            columns: { id: true, code: true, name: true }
          })
        : [];
    const locationById = new Map(locations.map((row) => [row.id, row]));

    const evidenceMediaObjectIds = [...new Set(evidenceLinkRows.map((row) => row.mediaObjectId))];
    const evidenceMediaObjects =
      evidenceMediaObjectIds.length > 0
        ? await handle.db.query.mediaObjects.findMany({
            where: (table, { inArray }) => inArray(table.id, evidenceMediaObjectIds),
            columns: { id: true, originalFilename: true, metadata: true }
          })
        : [];
    const evidenceMediaObjectById = new Map(evidenceMediaObjects.map((row) => [row.id, row]));

    // Resolves the title `sourcedFrom` needs — mirrors `fetchInventoryItem`'s
    // identical lookup verbatim; this handler used to hardcode `null` here
    // (loxep-1zg), the one thing that made its "Sourced from /market" card
    // diverge from the item-detail page's near-identical one.
    const linkMarketItemIds = [
      ...new Set(
        linkRows.map((row) => row.marketplaceItemId).filter((id): id is string => id !== null)
      )
    ];
    const linkMarketItems =
      linkMarketItemIds.length > 0
        ? await handle.db.query.marketplaceItems.findMany({
            where: (table, { inArray }) => inArray(table.id, linkMarketItemIds),
            columns: { id: true, title: true, externalItemId: true }
          })
        : [];
    const linkMarketItemTitleById = new Map(
      linkMarketItems.map((row) => [row.id, row.title ?? row.externalItemId])
    );

    return {
      id: acquisition.id,
      referenceCode: acquisition.referenceCode,
      title: acquisition.title,
      sourceKind: acquisition.sourceKind,
      status: acquisition.status,
      vendorName: acquisition.vendorName,
      currency: acquisition.currency,
      costAllocationBasis: acquisition.costAllocationBasis,
      costAllocationStatus: acquisition.costAllocationStatus,
      itemCount: itemRows.length,
      acquiredAt: iso(acquisition.acquiredAt),
      createdAt: iso(acquisition.createdAt),
      vendorLocation: acquisition.vendorLocation,
      externalReference: acquisition.externalReference,
      connectionId: acquisition.connectionId,
      connectionName: connection?.name ?? null,
      expectedItemCount: acquisition.expectedItemCount,
      notes: acquisition.notes,
      receivedAt: iso(acquisition.receivedAt),
      costs: costRows.map((row) => ({
        id: row.id,
        costScope: row.costScope,
        costType: row.costType,
        costClass: row.costClass,
        capitalize: row.capitalize,
        description: row.description,
        vendorName: row.vendorName,
        currency: row.currency,
        amount: row.amount,
        inventoryItemId: row.inventoryItemId,
        incurredAt: iso(row.incurredAt),
        createdAt: iso(row.createdAt)
      })),
      landedCost: landedCostResult.rows.map((row) => ({
        currency: row['currency'] as string,
        goodsAmount: decimal(row['goods']),
        ancillaryAmount: decimal(row['ancillary']),
        landedCostAmount: decimal(row['landed']),
        nonCapitalizedAmount: decimal(row['non_capitalized'])
      })),
      items: itemRows.map((row) => {
        const location = row.locationId ? (locationById.get(row.locationId) ?? null) : null;
        return {
          id: row.id,
          itemCode: row.itemCode,
          label: row.label,
          status: row.status,
          conditionCode: row.conditionCode,
          locationId: row.locationId,
          locationCode: location?.code ?? null,
          locationName: location?.name ?? null,
          quantity: row.quantity,
          quantityOnHand: row.quantityOnHand,
          currency: row.currency,
          acquisitionCostAmount: row.acquisitionCostAmount,
          landedCostAmount: row.landedCostAmount,
          estimatedValueAmount: row.estimatedValueAmount,
          acquisitionId: row.acquisitionId,
          acquisitionReferenceCode: acquisition.referenceCode,
          acquiredAt: iso(row.acquiredAt),
          createdAt: iso(row.createdAt)
        };
      }),
      linkedExpenses: linkedExpenseRows.map((row) => ({
        expenseId: row.id,
        referenceCode: row.referenceCode,
        expenseDate: row.expenseDate,
        currency: row.currency,
        amount: row.amount,
        category: row.category
      })),
      sourcedFrom: linkRows.map((row) => ({
        id: row.id,
        linkKind: row.linkKind,
        marketplaceItemId: row.marketplaceItemId,
        marketplaceItemTitle: row.marketplaceItemId
          ? (linkMarketItemTitleById.get(row.marketplaceItemId) ?? null)
          : null,
        marketEventId: row.marketEventId,
        scoreAtLink: row.scoreAtLink,
        targetPriceAmount: row.targetPriceAmount,
        targetCurrency: row.targetCurrency,
        linkedAt: iso(row.linkedAt)
      })),
      evidence: evidenceLinkRows.map((row) => {
        const mediaObject = evidenceMediaObjectById.get(row.mediaObjectId);
        return {
          mediaObjectId: row.mediaObjectId,
          originalFilename: mediaObject?.originalFilename ?? null,
          purpose: row.purpose,
          servingUrl: servingUrlFor(mediaObjectPurpose(mediaObject?.metadata), row.mediaObjectId),
          createdAt: iso(row.createdAt)
        };
      })
    };
  });

/** Would call `createAcquisitionsService({ db }).create(...)` — `packages/inventory/src/acquisitions.ts`. */
const createAcquisitionInput = z.strictObject({
  title: z.string().trim().min(1),
  sourceKind: z.enum([
    'auction_lot',
    'estate_sale',
    'thrift_retail',
    'retail_arbitrage',
    'liquidation_pallet',
    'wholesale_purchase',
    'online_marketplace',
    'trade_in',
    'consignment_intake',
    'personal_conversion',
    'customer_return',
    'found_stock',
    'other'
  ]),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  vendorName: z.string().trim().min(1).nullish(),
  externalReference: z.string().trim().min(1).nullish(),
  costAllocationBasis: z
    .enum(['equal', 'relative_value', 'weight', 'manual', 'direct'])
    .default('relative_value'),
  notes: z.string().trim().min(1).nullish(),
  /**
   * A27 (loxep-wx3) — `AcquisitionsService.create`'s own schema already
   * accepts this (`packages/inventory/src/acquisitions.ts:132`); it was
   * simply never exposed here, which is why every acquisition created
   * through the UI landed `entity_attribution_source: 'unattributed'`
   * permanently (the `installation_default` rung has no registered setting
   * to resolve from — see this pass's own report). `undefined` (field
   * omitted) falls through the resolution ladder same as before; explicit
   * `null` is an operator deliberately choosing "Unattributed", which is NOT
   * the same as omitting the field (`resolveAcquisitionAttribution`'s own
   * `!== undefined && !== null` check).
   */
  economicEntityId: z.uuid().nullish()
});

export const createAcquisition = createServerFn({ method: 'POST' })
  .inputValidator(createAcquisitionInput)
  .handler(async ({ data }): Promise<{ id: string; referenceCode: string }> => {
    const { requireSession, getAcquisitionsService } = await import('@/server/admin');
    const session = await requireSession();
    const acquisitionsService = await getAcquisitionsService();
    const acquisition = await acquisitionsService.create({
      title: data.title,
      sourceKind: data.sourceKind,
      currency: data.currency,
      vendorName: data.vendorName,
      externalReference: data.externalReference,
      costAllocationBasis: data.costAllocationBasis,
      notes: data.notes,
      economicEntityId: data.economicEntityId,
      createdByUserId: session.user.id
    });
    return { id: acquisition.id, referenceCode: acquisition.referenceCode };
  });

/**
 * `createAcquisitionsService({ db }).addCost(...)`. Exposes the fields the
 * underlying service's own `addCostSchema` (`@loxep/inventory/acquisitions.ts:148`)
 * already accepts — `currency` (defaults to the acquisition's own currency
 * when omitted) and `incurredAt` were previously left off this DTO, which is
 * why the ONLY entry path into this function
 * (`promoteExpenseToAcquisitionCost`) had to hard-code `costType: 'goods'`
 * and leave shipping/buyer's-premium/sales-tax unenterable (loxep-wx3, A7).
 * No new domain logic — this mounts the existing verb's real input shape.
 */
const addAcquisitionCostInput = z.strictObject({
  acquisitionId: z.uuid(),
  costType: z.string().trim().min(1),
  costClass: z.enum(['goods', 'ancillary']),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish(),
  /** `null`/omitted is lot scope; a uuid scopes the cost to one item, bypassing allocation. */
  inventoryItemId: z.uuid().nullish(),
  capitalize: z.boolean().default(true),
  description: z.string().trim().min(1).nullish(),
  vendorName: z.string().trim().min(1).nullish(),
  /** ISO datetime string on the wire, mirroring `@/server/market-functions.ts`'s own `detectedAtFrom`/`detectedAtTo` — converted to a `Date` below for the service's own `z.date()` field. */
  incurredAt: z.string().trim().min(1).nullish()
});

export const addAcquisitionCost = createServerFn({ method: 'POST' })
  .inputValidator(addAcquisitionCostInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getAcquisitionsService } = await import('@/server/admin');
    const session = await requireSession();
    const acquisitionsService = await getAcquisitionsService();
    const cost = await acquisitionsService.addCost({
      acquisitionId: data.acquisitionId,
      costType: data.costType,
      costClass: data.costClass,
      amount: data.amount,
      currency: data.currency ?? undefined,
      inventoryItemId: data.inventoryItemId,
      capitalize: data.capitalize,
      description: data.description,
      vendorName: data.vendorName,
      incurredAt: data.incurredAt ? new Date(data.incurredAt) : undefined,
      createdByUserId: session.user.id
    });
    return { id: cost.id };
  });

/** `createAcquisitionsService({ db }).allocateCosts(...)` — the largest-remainder allocation engine. */
const allocateAcquisitionCostsInput = z.strictObject({
  acquisitionId: z.uuid(),
  basis: z.enum(['equal', 'relative_value', 'weight', 'manual', 'direct']).optional(),
  finalize: z.boolean().default(false)
});

export interface AllocateAcquisitionCostsResultDto {
  basis: string;
  currency: string;
  lotPoolAmount: string;
  lockedAmount: string;
  allocatablePoolAmount: string;
  unallocatedAmount: string;
  foreignCurrencyCostCount: number;
  costAllocationStatus: string;
  allocatedItemCount: number;
  lockedItemCount: number;
}

export const allocateAcquisitionCosts = createServerFn({ method: 'POST' })
  .inputValidator(allocateAcquisitionCostsInput)
  .handler(async ({ data }): Promise<AllocateAcquisitionCostsResultDto> => {
    const { requireSession, getAcquisitionsService } = await import('@/server/admin');
    await requireSession();
    const acquisitionsService = await getAcquisitionsService();
    // Refuses (throws `InventoryConflictError`) rather than silently clamping
    // when basis-locked items already consume more than the lot's pool —
    // the design's explicit rule, surfaced to the UI as a mutation error.
    const outcome = await acquisitionsService.allocateCosts({
      acquisitionId: data.acquisitionId,
      basis: data.basis,
      finalize: data.finalize
    });
    return {
      basis: outcome.basis,
      currency: outcome.currency,
      lotPoolAmount: outcome.lotPoolAmount,
      lockedAmount: outcome.lockedAmount,
      allocatablePoolAmount: outcome.allocatablePoolAmount,
      unallocatedAmount: outcome.unallocatedAmount,
      foreignCurrencyCostCount: outcome.foreignCurrencyCostCount,
      costAllocationStatus: outcome.costAllocationStatus,
      allocatedItemCount: outcome.allocations.length,
      lockedItemCount: outcome.lockedItems.length
    };
  });

// ---------------------------------------------------------------------------
// The /market handoff — "I bought this"
// ---------------------------------------------------------------------------

export interface MarketAcquisitionLinkDto {
  id: string;
  linkKind: string;
  acquisitionId: string | null;
  acquisitionReferenceCode: string | null;
  acquisitionStatus: string | null;
  inventoryItemId: string | null;
  inventoryItemCode: string | null;
  inventoryItemStatus: string | null;
  scoreAtLink: string | null;
  targetPriceAmount: string | null;
  targetCurrency: string | null;
  linkedAt: string;
}

/**
 * The "we bought one" panel on `/market/items/$itemId`: every
 * `acquisition_opportunity_links` row this marketplace item is named on,
 * joined out to the acquisition/item it points at. A real, working read —
 * the link table shipped in Phase 4 and needs no `@loxep/inventory` service
 * to be listed, only to be WRITTEN (see {@link createAcquisitionFromMarketItem}).
 */
export const fetchMarketItemAcquisitionLinks = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ marketplaceItemId: z.uuid() }))
  .handler(async ({ data }): Promise<MarketAcquisitionLinkDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.acquisitionOpportunityLinks.findMany({
      where: (table, { eq }) => eq(table.marketplaceItemId, data.marketplaceItemId),
      orderBy: (table, { desc }) => [desc(table.linkedAt)]
    });
    if (rows.length === 0) return [];

    const acquisitionIds = [
      ...new Set(rows.map((row) => row.acquisitionId).filter((id): id is string => id !== null))
    ];
    const itemIds = [
      ...new Set(rows.map((row) => row.inventoryItemId).filter((id): id is string => id !== null))
    ];
    const [acquisitions, items] = await Promise.all([
      acquisitionIds.length > 0
        ? handle.db.query.acquisitions.findMany({
            where: (table, { inArray }) => inArray(table.id, acquisitionIds),
            columns: { id: true, referenceCode: true, status: true }
          })
        : Promise.resolve([]),
      itemIds.length > 0
        ? handle.db.query.inventoryItems.findMany({
            where: (table, { inArray }) => inArray(table.id, itemIds),
            columns: { id: true, itemCode: true, status: true }
          })
        : Promise.resolve([])
    ]);
    const acquisitionById = new Map(acquisitions.map((row) => [row.id, row]));
    const itemById = new Map(items.map((row) => [row.id, row]));

    return rows.map((row) => {
      const acquisition = row.acquisitionId
        ? (acquisitionById.get(row.acquisitionId) ?? null)
        : null;
      const item = row.inventoryItemId ? (itemById.get(row.inventoryItemId) ?? null) : null;
      return {
        id: row.id,
        linkKind: row.linkKind,
        acquisitionId: row.acquisitionId,
        acquisitionReferenceCode: acquisition?.referenceCode ?? null,
        acquisitionStatus: acquisition?.status ?? null,
        inventoryItemId: row.inventoryItemId,
        inventoryItemCode: item?.itemCode ?? null,
        inventoryItemStatus: item?.status ?? null,
        scoreAtLink: row.scoreAtLink,
        targetPriceAmount: row.targetPriceAmount,
        targetCurrency: row.targetCurrency,
        linkedAt: iso(row.linkedAt)
      };
    });
  });

/**
 * "I bought this" (design: `flipping-lifecycle-design.md`, "the weave" →
 * "Handoff by handoff"): opens acquisition intake prefilled from the
 * marketplace item and, on submit, runs three calls in sequence —
 *
 *   1. `acquisitionsService.create({ title, sourceKind: 'online_marketplace', currency, vendorName, externalReference })`
 *   2. `itemsService.create({ label, currency, acquisitionId, acquisitionCostAmount })`
 *   3. `opportunityLinksService.link({ linkKind: 'sourced_from', acquisitionId, marketplaceItemId, marketEventId, scoreAtLink, targetCurrency, targetPriceAmount })`
 *
 * SEQUENTIAL, not one shared database transaction: each of the three
 * services owns its own transaction boundary per call (`createAcquisitionsService`/
 * `createItemsService`/`createOpportunityLinksService` each take a plain
 * `LoxepDb` and open `db.transaction(...)` internally), and composing three
 * independently-designed service factories under one externally-supplied
 * transaction is not a shape their APIs support without reaching into their
 * internals. A failure partway leaves a recoverable state (an acquisition
 * with no item, or an item with no link) rather than corrupted data — never
 * a half-written row. `scoreAtLink`/`targetPriceAmount` are snapshotted from
 * the caller's input BEFORE any of the three calls run, so the frozen
 * decision is fixed regardless of what happens after (the design's explicit
 * rule: editing an opportunity rule later must never rewrite how good a past
 * decision looked).
 */
const createAcquisitionFromMarketItemInput = z.strictObject({
  marketplaceItemId: z.uuid(),
  marketEventId: z.uuid().nullish(),
  label: z.string().trim().min(1),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  goodsCostAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullish(),
  vendorName: z.string().trim().min(1).nullish(),
  externalReference: z.string().trim().min(1).nullish(),
  scoreAtLink: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullish(),
  targetPriceAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullish()
});

export interface CreateAcquisitionFromMarketItemResultDto {
  acquisitionId: string;
  acquisitionReferenceCode: string;
  inventoryItemId: string;
  inventoryItemCode: string;
  linkId: string;
}

export const createAcquisitionFromMarketItem = createServerFn({ method: 'POST' })
  .inputValidator(createAcquisitionFromMarketItemInput)
  .handler(async ({ data }): Promise<CreateAcquisitionFromMarketItemResultDto> => {
    const { requireSession, getAcquisitionsService, getItemsService, getOpportunityLinksService } =
      await import('@/server/admin');
    const session = await requireSession();
    const [acquisitionsService, itemsService, opportunityLinksService] = await Promise.all([
      getAcquisitionsService(),
      getItemsService(),
      getOpportunityLinksService()
    ]);

    const acquisition = await acquisitionsService.create({
      title: data.label,
      sourceKind: 'online_marketplace',
      currency: data.currency,
      vendorName: data.vendorName,
      externalReference: data.externalReference,
      createdByUserId: session.user.id
    });

    const item = await itemsService.create({
      label: data.label,
      currency: data.currency,
      acquisitionId: acquisition.id,
      ...(data.goodsCostAmount !== undefined && data.goodsCostAmount !== null
        ? { acquisitionCostAmount: data.goodsCostAmount }
        : {}),
      createdByUserId: session.user.id
    });

    const link = await opportunityLinksService.link({
      linkKind: 'sourced_from',
      acquisitionId: acquisition.id,
      marketEventId: data.marketEventId,
      marketplaceItemId: data.marketplaceItemId,
      scoreAtLink: data.scoreAtLink,
      ...(data.targetPriceAmount !== undefined && data.targetPriceAmount !== null
        ? { targetCurrency: data.currency, targetPriceAmount: data.targetPriceAmount }
        : {}),
      linkedByUserId: session.user.id
    });

    return {
      acquisitionId: acquisition.id,
      acquisitionReferenceCode: acquisition.referenceCode,
      inventoryItemId: item.id,
      inventoryItemCode: item.itemCode,
      linkId: link.id
    };
  });

// ---------------------------------------------------------------------------
// Profitability — /inventory/profitability (loxep-7fs, A11).
//
// `@loxep/inventory/profitability.ts` shipped ten exported read models
// (acquisitionRoi, sourcingChannelPerformance, inventoryOnHandAtCost,
// inventoryAging, unmatchedDepletions, oversells, plus
// itemRealizedContribution/orderRealizedContribution/openLots/
// costReconciliation) with zero callers repo-wide — this is the entire "did
// flipping make money" question. This handler wires the six read models this
// milestone's page surfaces: ROI per acquisition, sourcing-channel
// performance, on-hand-at-cost + aging, and the two integrity worklists
// (oversells, unmatchedDepletions). `itemRealizedContribution`/
// `orderRealizedContribution` (per-sale-line/per-order granularity) and
// `openLots`/`costReconciliation` (lot-hygiene worklists) remain unwired —
// see this pass's report.
//
// One combined DTO, one server function: every read here is independent
// (no read depends on another's result) and each is already cheap/bounded,
// so composing them into a single round trip is simpler than six separate
// queries for a page that always wants all of them together. No filter
// UI in this pass — every read runs unfiltered (`{}`), matching the
// module's own default.
// ---------------------------------------------------------------------------

export interface AcquisitionRoiDto {
  acquisitionId: string;
  referenceCode: string;
  sourceKind: string;
  currency: string;
  acquiredAt: string;
  costAllocationStatus: string;
  landedCostAmount: string;
  nonCapitalizedAmount: string;
  itemCount: number;
  depletedItemCount: number;
  onHandItemCount: number;
  onHandCostAmount: string;
  realizedContributionAmount: string;
}

export interface SourcingChannelDto {
  sourceKind: string;
  currency: string;
  acquisitionCount: number;
  landedCostAmount: string;
  realizedContributionAmount: string;
  onHandCostAmount: string;
}

export interface OnHandAtCostDto {
  economicEntityId: string | null;
  locationId: string | null;
  locationPath: string | null;
  currency: string;
  itemCount: number;
  quantityOnHand: string;
  onHandCostAmount: string;
  consignmentItemCount: number;
}

export interface AgingBucketDto {
  bucket: string;
  currency: string;
  itemCount: number;
  onHandCostAmount: string;
}

export interface OversellDto {
  inventoryItemId: string;
  itemCode: string;
  quantityOnHand: string;
}

export interface UnmatchedDepletionDto {
  orderId: string;
  orderLineId: string;
  title: string | null;
  quantityFulfilled: string;
  currency: string;
  lineTotal: string;
}

export interface InventoryProfitabilityDto {
  /** Never "profit" — see `@loxep/inventory/profitability.ts`'s module doc. Render wherever a contribution figure appears. */
  contributionLabel: string;
  acquisitionRoi: AcquisitionRoiDto[];
  sourcingChannelPerformance: SourcingChannelDto[];
  onHandAtCost: OnHandAtCostDto[];
  aging: AgingBucketDto[];
  oversells: OversellDto[];
  unmatchedDepletions: UnmatchedDepletionDto[];
  /** `ShipmentsService.unlinkedShippingLabelFees` (A14) — folded into this combined DTO since the route already treats the whole page as one round trip. */
  unlinkedShippingLabelFees: UnlinkedShippingLabelFeeDto[];
}

export const fetchInventoryProfitability = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InventoryProfitabilityDto> => {
    const { requireSession, getInventoryModule, getAdminServices, getShipmentsService } =
      await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const inventory = await getInventoryModule();
    const shipmentsService = await getShipmentsService();

    const [
      acquisitionRoi,
      sourcingChannelPerformance,
      onHandAtCost,
      aging,
      oversells,
      unmatchedDepletions,
      unlinkedShippingLabelFees
    ] = await Promise.all([
      inventory.acquisitionRoi(handle.db),
      inventory.sourcingChannelPerformance(handle.db),
      inventory.inventoryOnHandAtCost(handle.db),
      inventory.inventoryAging(handle.db),
      inventory.oversells(handle.db),
      inventory.unmatchedDepletions(handle.db),
      shipmentsService.unlinkedShippingLabelFees()
    ]);

    return {
      contributionLabel: inventory.CONTRIBUTION_LABEL,
      acquisitionRoi: acquisitionRoi.map((row) => ({
        acquisitionId: row.acquisitionId,
        referenceCode: row.referenceCode,
        sourceKind: row.sourceKind,
        currency: row.currency,
        acquiredAt: iso(row.acquiredAt),
        costAllocationStatus: row.costAllocationStatus,
        landedCostAmount: row.landedCostAmount,
        nonCapitalizedAmount: row.nonCapitalizedAmount,
        itemCount: row.itemCount,
        depletedItemCount: row.depletedItemCount,
        onHandItemCount: row.onHandItemCount,
        onHandCostAmount: row.onHandCostAmount,
        realizedContributionAmount: row.realizedContributionAmount
      })),
      sourcingChannelPerformance: sourcingChannelPerformance.map((row) => ({
        sourceKind: row.sourceKind,
        currency: row.currency,
        acquisitionCount: row.acquisitionCount,
        landedCostAmount: row.landedCostAmount,
        realizedContributionAmount: row.realizedContributionAmount,
        onHandCostAmount: row.onHandCostAmount
      })),
      onHandAtCost: onHandAtCost.map((row) => ({
        economicEntityId: row.economicEntityId,
        locationId: row.locationId,
        locationPath: row.locationPath,
        currency: row.currency,
        itemCount: row.itemCount,
        quantityOnHand: row.quantityOnHand,
        onHandCostAmount: row.onHandCostAmount,
        consignmentItemCount: row.consignmentItemCount
      })),
      aging: aging.map((row) => ({
        bucket: row.bucket,
        currency: row.currency,
        itemCount: row.itemCount,
        onHandCostAmount: row.onHandCostAmount
      })),
      oversells: oversells.map((row) => ({
        inventoryItemId: row.inventoryItemId,
        itemCode: row.itemCode,
        quantityOnHand: row.quantityOnHand
      })),
      unmatchedDepletions: unmatchedDepletions.map((row) => ({
        orderId: row.orderId,
        orderLineId: row.orderLineId,
        title: row.title,
        quantityFulfilled: row.quantityFulfilled,
        currency: row.currency,
        lineTotal: row.lineTotal
      })),
      unlinkedShippingLabelFees: unlinkedShippingLabelFees.map((row) => ({
        orderFeeId: row.orderFeeId,
        orderId: row.orderId,
        currency: row.currency,
        amount: row.amount
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Shipments — outbound carrier reality (loxep-7fs, A14).
//
// `ShipmentsService` (`@loxep/inventory/shipments.ts`) was dead in its
// entirety: zero references repo-wide, not even a `getShipmentsService` on
// the admin registry. `adjustment_amount` — the carrier post-audit reweigh,
// "one of the most reliably underestimated costs in resale" per the
// module's own doc — was therefore silently missing from every margin
// figure. Mounted here: record a shipment (from an order detail), record a
// cost adjustment against one, and the `unlinkedShippingLabelFees`
// money-leak worklist (rendered on `/inventory/profitability`).
// ---------------------------------------------------------------------------

export interface ShipmentDto {
  id: string;
  shipmentKind: string;
  orderId: string | null;
  orderFeeId: string | null;
  status: string;
  carrierCode: string | null;
  carrierName: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  currency: string | null;
  postageAmount: string;
  insuranceAmount: string;
  surchargeAmount: string;
  adjustmentAmount: string;
  refundAmount: string;
  netCostAmount: string;
  costSource: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/**
 * `netCostAmount` goes through `@loxep/inventory`'s own `netShipmentCost` —
 * exact decimal (`numeric`-safe) arithmetic, never `Number()` on a
 * persisted-adjacent money figure — so this needs the dynamically-imported
 * module (`getInventoryModule()`), not a plain sync mapper.
 */
function toShipmentDto(
  row: ShipmentRow,
  netShipmentCost: (shipment: ShipmentRow) => string
): ShipmentDto {
  return {
    id: row.id,
    shipmentKind: row.shipmentKind,
    orderId: row.orderId,
    orderFeeId: row.orderFeeId,
    status: row.status,
    carrierCode: row.carrierCode,
    carrierName: row.carrierName,
    serviceCode: row.serviceCode,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    currency: row.currency,
    postageAmount: row.postageAmount,
    insuranceAmount: row.insuranceAmount,
    surchargeAmount: row.surchargeAmount,
    adjustmentAmount: row.adjustmentAmount,
    refundAmount: row.refundAmount,
    netCostAmount: netShipmentCost(row),
    costSource: row.costSource,
    shippedAt: iso(row.shippedAt),
    deliveredAt: iso(row.deliveredAt),
    createdAt: iso(row.createdAt)
  };
}

export const fetchShipmentsForOrder = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ orderId: z.uuid() }))
  .handler(async ({ data }): Promise<ShipmentDto[]> => {
    const { requireSession, getAdminServices, getInventoryModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const inventory = await getInventoryModule();
    const rows = await handle.db.query.shipments.findMany({
      where: (table, { eq }) => eq(table.orderId, data.orderId),
      orderBy: (table, { desc }) => [desc(table.createdAt)]
    });
    return rows.map((row) => toShipmentDto(row, inventory.netShipmentCost));
  });

const recordShipmentInput = z.strictObject({
  shipmentKind: z
    .enum(['outbound_sale', 'return_to_vendor', 'transfer', 'replacement', 'other'])
    .default('outbound_sale'),
  orderId: z.uuid().nullish(),
  carrierCode: z.string().trim().min(1).nullish(),
  carrierName: z.string().trim().min(1).nullish(),
  serviceCode: z.string().trim().min(1).nullish(),
  trackingNumber: z.string().trim().min(1).nullish(),
  trackingUrl: z.string().trim().min(1).nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish(),
  postageAmount: decimalInput.default('0'),
  insuranceAmount: decimalInput.default('0'),
  surchargeAmount: decimalInput.default('0'),
  /** The order lines this shipment fulfilled, each at its full order quantity — the profitability engine's `gatherShipping` allocates net cost across these. */
  orderLineIds: z.array(z.uuid()).default([]),
  shippedAt: z.iso.datetime().nullish()
});

export const recordShipment = createServerFn({ method: 'POST' })
  .inputValidator(recordShipmentInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getShipmentsService, getAdminServices } =
      await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();
    const shipmentsService = await getShipmentsService();

    let items: { orderLineId: string; quantity: string }[] = [];
    if (data.orderLineIds.length > 0) {
      const lineRows = await handle.db.query.orderLines.findMany({
        where: (table, { inArray }) => inArray(table.id, data.orderLineIds)
      });
      items = lineRows.map((line) => ({ orderLineId: line.id, quantity: line.quantity }));
    }

    const { shipment } = await shipmentsService.record({
      shipmentKind: data.shipmentKind,
      orderId: data.orderId,
      carrierCode: data.carrierCode,
      carrierName: data.carrierName,
      serviceCode: data.serviceCode,
      trackingNumber: data.trackingNumber,
      trackingUrl: data.trackingUrl,
      currency: data.currency,
      postageAmount: data.postageAmount,
      insuranceAmount: data.insuranceAmount,
      surchargeAmount: data.surchargeAmount,
      costSource: 'manual',
      shippedAt: data.shippedAt ? new Date(data.shippedAt) : undefined,
      createdByUserId: session.user.id,
      items
    });
    return { id: shipment.id };
  });

const recordShipmentCostAdjustmentInput = z
  .strictObject({
    shipmentId: z.uuid(),
    adjustmentAmount: decimalInput.optional(),
    refundAmount: decimalInput.optional(),
    note: z.string().trim().min(1).nullish()
  })
  .refine((input) => input.adjustmentAmount !== undefined || input.refundAmount !== undefined, {
    message: 'a cost adjustment must change the adjustment or the refund amount'
  });

/**
 * `ShipmentsService.recordCostAdjustment` — the ONLY way to enter a carrier
 * post-audit reweigh charge or a label refund arriving after the shipment
 * was first recorded. Accumulates; never replaces.
 */
export const recordShipmentCostAdjustment = createServerFn({ method: 'POST' })
  .inputValidator(recordShipmentCostAdjustmentInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getShipmentsService } = await import('@/server/admin');
    await requireSession();
    const shipmentsService = await getShipmentsService();
    const shipment = await shipmentsService.recordCostAdjustment({
      shipmentId: data.shipmentId,
      adjustmentAmount: data.adjustmentAmount,
      refundAmount: data.refundAmount,
      note: data.note
    });
    return { id: shipment.id };
  });

/** The design's recommended reconciliation for the shipping double-count guard (open question 6) — see `InventoryProfitabilityDto.unlinkedShippingLabelFees`'s doc, which is where this DTO is populated (folded into that combined read rather than its own round trip). */
export interface UnlinkedShippingLabelFeeDto {
  orderFeeId: string;
  orderId: string;
  currency: string;
  amount: string;
}
