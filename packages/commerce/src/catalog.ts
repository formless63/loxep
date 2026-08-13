/**
 * Catalog items and channel listings (loxep-xh9.5).
 *
 * Two different things live here, and the design document is emphatic that
 * they must not be collapsed:
 *
 * ```text
 * catalog_items      Loxep's INTERNAL SKU identity. Exists before it is ever
 *                    listed or sold. Owned by Catalog and Listings.
 * channel_listings   an OWNED PUBLICATION of a catalog item to one channel
 *                    through one connection. Definitely ours.
 * marketplace_items  an OBSERVED PUBLIC listing, possibly someone else's.
 *                    Owned by Market Intelligence; never written here.
 * ```
 *
 * `channel_listings.marketplace_item_id` is the nullable, opportunistic link
 * from the second to the third. It is a DISCOVERY, not an identity: the
 * channel listing was complete and correct before the public listing was ever
 * observed, and un-monitoring the public listing must not touch it.
 *
 * ## PROVISIONAL (design open question 7): SKU uniqueness is installation-wide
 *
 * `catalog_items.sku` is `unique(sku)`, not `(economic_entity_id, sku)`. Two
 * operating identities using one SKU string for different goods produces
 * silently wrong profitability, and the per-entity variant has a nasty
 * null-entity case. Widening later is additive if a real conflict appears.
 *
 * ## Matching is a SUGGESTION, never an auto-link
 *
 * {@link CatalogService.suggestChannelLinks} is read-only. It proposes
 * catalog-item ↔ channel-listing pairs from SKU evidence and writes nothing.
 * Auto-linking a mis-typed SKU would silently move revenue onto the wrong
 * product, and the resulting `channel_listings` row is exactly the kind of
 * thing an operator should confirm once and never think about again.
 */
import type { LoxepDb } from "@loxep/db";
import { catalogItems, channelListings } from "@loxep/db/schema";
import type {
  CatalogItemKind,
  CatalogItemStatus,
  ChannelListingStatus,
} from "@loxep/db/schema";
import { MANUAL_PROVIDER } from "@loxep/db/schema";
import type { WooProductFact } from "@loxep/integration-woo";
import { z } from "zod";
import { listingCode as formatListingCode, withCodeRetry } from "./codes.ts";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  CommerceValidationError,
} from "./errors.ts";
import {
  nullable,
  numericLiteral,
  textLiteral,
  timestamptzLiteral,
  uuidLiteral,
} from "./sql.ts";
import { WOO_PROVIDER } from "./woo.ts";

type Tx = Parameters<Parameters<LoxepDb["transaction"]>[0]>[0];

/**
 * `LST-<year>-<seq>`, derived per year from the rows that already exist —
 * the same shape `packages/accounting/src/expenses.ts`'s
 * `generateReferenceCode` and `packages/inventory/src/acquisitions.ts`'s
 * `nextSequence` use. Required on EVERY insert, connector-synced rows
 * included: `listing_code` is `NOT NULL` for the whole table (design 4a).
 */
async function generateListingCode(tx: Tx, year: number): Promise<string> {
  const result = await tx.execute(
    `select coalesce(max(
              (substring(listing_code from '^LST-[0-9]{4}-([0-9]+)$'))::integer
            ), 0)::text as max_seq
       from channel_listings
      where listing_code like ${textLiteral(`LST-${year}-`)} || '%'`,
  );
  const next = Number(result.rows[0]?.["max_seq"] ?? "0") + 1;
  return formatListingCode(year, next);
}

export type CatalogItemRow = typeof catalogItems.$inferSelect;
export type ChannelListingRow = typeof channelListings.$inferSelect;

/* ---------------------------------------------------------------- schemas */

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\s{2,}/.test(value), "SKU must not contain runs of spaces");
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

const createCatalogItemSchema = z
  .strictObject({
    sku: skuSchema,
    name: z.string().trim().min(1),
    kind: z.enum(["simple", "variant_group", "variant"]).default("simple"),
    status: z.enum(["draft", "active", "archived"]).default("active"),
    economicEntityId: z.uuid().nullish(),
    parentCatalogItemId: z.uuid().nullish(),
    variantLabel: z.string().trim().min(1).nullish(),
    description: z.string().nullish(),
    conditionCode: z.string().trim().min(1).nullish(),
    defaultCurrency: currencyCode.nullish(),
    defaultPrice: decimalString.nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine(
    (item) =>
      (item.kind === "variant") ===
      (item.parentCatalogItemId !== undefined &&
        item.parentCatalogItemId !== null),
    {
      message:
        "kind 'variant' requires parentCatalogItemId, and vice versa (catalog_items_variant_parent_check)",
      path: ["parentCatalogItemId"],
    },
  );

const updateCatalogItemSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    status: z.enum(["draft", "active", "archived"]).optional(),
    economicEntityId: z.uuid().nullish(),
    variantLabel: z.string().trim().min(1).nullish(),
    description: z.string().nullish(),
    conditionCode: z.string().trim().min(1).nullish(),
    defaultCurrency: currencyCode.nullish(),
    defaultPrice: decimalString.nullish(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty update" });

const upsertChannelListingSchema = z.strictObject({
  catalogItemId: z.uuid(),
  connectionId: z.uuid(),
  provider: z.string().min(1),
  channel: z.string().min(1),
  marketplace: z.string().min(1).nullish(),
  externalListingId: z.string().min(1),
  externalVariationId: z.string().min(1).nullish(),
  marketplaceItemId: z.uuid().nullish(),
  status: z
    .enum(["draft", "active", "ended", "sold_out", "unknown"])
    .default("active"),
  listingUrl: z.string().min(1).nullish(),
  listingTitle: z.string().min(1).nullish(),
  currency: currencyCode.nullish(),
  price: decimalString.nullish(),
  quantityAvailable: z.number().int().nullish(),
  listedAt: z.date().nullish(),
  endedAt: z.date().nullish(),
});

/**
 * A manual/offline listing (design 4a) or a Loxep-authored DRAFT of any
 * provider — the same object at different points in its life (4b). No
 * `connectionId`/`externalListingId` here on purpose: the whole point of the
 * manual/draft shape is that neither exists yet.
 */
const createManualListingSchema = z.strictObject({
  catalogItemId: z.uuid(),
  channel: z.string().min(1),
  provider: z.string().min(1).default(MANUAL_PROVIDER),
  status: z
    .enum(["draft", "active", "ended", "sold_out", "unknown"])
    .default("draft"),
  listingUrl: z.string().min(1).nullish(),
  listingTitle: z.string().min(1).nullish(),
  currency: currencyCode.nullish(),
  price: decimalString.nullish(),
  quantityAvailable: z.number().int().nullish(),
  listedAt: z.date().nullish(),
});

export type CreateCatalogItemInput = z.input<typeof createCatalogItemSchema>;
export type UpdateCatalogItemInput = z.input<typeof updateCatalogItemSchema>;
export type UpsertChannelListingInput = z.input<
  typeof upsertChannelListingSchema
>;
export type CreateManualListingInput = z.input<
  typeof createManualListingSchema
>;

/* ------------------------------------------------------------ suggestions */

/** One proposed catalog ↔ channel link. Nothing is written. */
export interface ChannelLinkSuggestion {
  /** The provider's listing id (a Woo product id). */
  externalListingId: string;
  externalVariationId: string | null;
  /** The SKU the channel reported. */
  channelSku: string;
  catalogItemId: string;
  catalogItemSku: string;
  catalogItemName: string;
  listingTitle: string | null;
  /**
   * Why this pair was proposed.
   *
   * ```text
   * exact_sku            channel SKU equals a catalog SKU byte for byte
   * normalized_sku       equal after trimming and case folding
   * ```
   *
   * There is deliberately no fuzzy tier: a near-miss SKU is a data-entry
   * problem to fix, not a match to guess at.
   */
  matchReason: "exact_sku" | "normalized_sku";
  /** True when a `channel_listings` row already exists for this identity. */
  alreadyLinked: boolean;
}

/** A channel listing candidate, provider-neutral. */
export interface ChannelListingCandidate {
  externalListingId: string;
  externalVariationId?: string | null;
  sku: string | null;
  title?: string | null;
}

/* ---------------------------------------------------------------- service */

export interface CatalogService {
  createCatalogItem: (input: CreateCatalogItemInput) => Promise<CatalogItemRow>;
  getCatalogItem: (catalogItemId: string) => Promise<CatalogItemRow>;
  findCatalogItemBySku: (sku: string) => Promise<CatalogItemRow | null>;
  listCatalogItems: (filter?: {
    status?: CatalogItemStatus;
    kind?: CatalogItemKind;
    economicEntityId?: string | null;
    parentCatalogItemId?: string;
  }) => Promise<CatalogItemRow[]>;
  updateCatalogItem: (
    catalogItemId: string,
    patch: UpdateCatalogItemInput,
  ) => Promise<CatalogItemRow>;
  /** Archive, never delete: order lines may reference the item forever. */
  archiveCatalogItem: (catalogItemId: string) => Promise<CatalogItemRow>;

  upsertChannelListing: (
    input: UpsertChannelListingInput,
  ) => Promise<ChannelListingRow>;
  /**
   * A manual/offline listing (design 4a) or a Loxep-authored draft of any
   * provider (4b) — `provider = 'manual'` and `connectionId = null` by
   * default, or an explicit `provider` for a future-milestone draft. Mints
   * `listing_code` the same way {@link upsertChannelListing} does.
   */
  createManualListing: (
    input: CreateManualListingInput,
  ) => Promise<ChannelListingRow>;
  /**
   * The "cheap answer" to design open question 5: find a catalog item by
   * SKU, or mint one (`kind = 'simple'`) when none exists — the operation
   * `createManualListing`'s caller runs first, giving it a `catalogItemId`
   * to pass in. Exposed separately (rather than folded into
   * `createManualListing`) because the same "mint at listing time" rule will
   * apply to a future connector publish flow too.
   */
  findOrCreateCatalogItemBySku: (input: {
    sku: string;
    name: string;
    economicEntityId?: string | null;
  }) => Promise<CatalogItemRow>;
  getChannelListing: (channelListingId: string) => Promise<ChannelListingRow>;
  listChannelListings: (filter?: {
    connectionId?: string;
    catalogItemId?: string;
    status?: ChannelListingStatus;
  }) => Promise<ChannelListingRow[]>;
  /** Resolve the opportunistic link to an observed public listing. */
  linkMarketplaceItem: (
    channelListingId: string,
    marketplaceItemId: string | null,
  ) => Promise<ChannelListingRow>;

  /** READ-ONLY. Proposes links; writes nothing. */
  suggestChannelLinks: (input: {
    connectionId: string;
    candidates: readonly ChannelListingCandidate[];
    provider?: string;
  }) => Promise<ChannelLinkSuggestion[]>;
  /** Convenience wrapper mapping WooCommerce product facts onto candidates. */
  suggestWooChannelLinks: (input: {
    connectionId: string;
    products: readonly WooProductFact[];
  }) => Promise<ChannelLinkSuggestion[]>;
}

function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase();
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
}

/**
 * Is this a PostgreSQL unique violation on a named constraint?
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the `code` and
 * `constraint` fields live on the `cause` chain rather than the thrown value.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate !== null && candidate !== undefined; depth += 1) {
    const pgError = candidate as { code?: string; constraint?: string };
    if (
      pgError.code === "23505" &&
      (pgError.constraint === constraint || pgError.constraint === undefined)
    ) {
      return true;
    }
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

export function createCatalogService(options: {
  db: LoxepDb;
}): CatalogService {
  const { db } = options;

  async function getCatalogItem(catalogItemId: string): Promise<CatalogItemRow> {
    const row = await db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.id, catalogItemId),
    });
    if (row === undefined) {
      throw new CommerceNotFoundError(`unknown catalog item "${catalogItemId}"`);
    }
    return row;
  }

  async function findCatalogItemBySku(
    sku: string,
  ): Promise<CatalogItemRow | null> {
    const row = await db.query.catalogItems.findFirst({
      where: (table, { eq }) => eq(table.sku, sku.trim()),
    });
    return row ?? null;
  }

  async function createCatalogItem(
    input: CreateCatalogItemInput,
  ): Promise<CatalogItemRow> {
    const parsed = createCatalogItemSchema.safeParse(input);
    if (!parsed.success) {
      throw new CommerceValidationError(
        `invalid catalog item: ${issuesOf(parsed.error)}`,
      );
    }
    const item = parsed.data;
    try {
      const inserted = await db
        .insert(catalogItems)
        .values({
          sku: item.sku,
          name: item.name,
          kind: item.kind,
          status: item.status,
          economicEntityId: item.economicEntityId ?? null,
          parentCatalogItemId: item.parentCatalogItemId ?? null,
          variantLabel: item.variantLabel ?? null,
          description: item.description ?? null,
          conditionCode: item.conditionCode ?? null,
          defaultCurrency: item.defaultCurrency?.toUpperCase() ?? null,
          defaultPrice: item.defaultPrice ?? null,
          createdByUserId: item.createdByUserId ?? null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new CommerceNotFoundError("catalog item insert returned no row");
      }
      return row;
    } catch (error) {
      if (isUniqueViolation(error, "catalog_items_sku_uq")) {
        throw new CommerceConflictError(
          `catalog SKU "${item.sku}" already exists; SKUs are unique installation-wide`,
        );
      }
      throw error;
    }
  }

  async function listCatalogItems(filter?: {
    status?: CatalogItemStatus;
    kind?: CatalogItemKind;
    economicEntityId?: string | null;
    parentCatalogItemId?: string;
  }): Promise<CatalogItemRow[]> {
    return db.query.catalogItems.findMany({
      where: (table, { and, eq, isNull }) => {
        const conditions = [];
        if (filter?.status !== undefined) {
          conditions.push(eq(table.status, filter.status));
        }
        if (filter?.kind !== undefined) {
          conditions.push(eq(table.kind, filter.kind));
        }
        if (filter?.economicEntityId !== undefined) {
          conditions.push(
            filter.economicEntityId === null
              ? isNull(table.economicEntityId)
              : eq(table.economicEntityId, filter.economicEntityId),
          );
        }
        if (filter?.parentCatalogItemId !== undefined) {
          conditions.push(
            eq(table.parentCatalogItemId, filter.parentCatalogItemId),
          );
        }
        return conditions.length > 0 ? and(...conditions) : undefined;
      },
      orderBy: (table, { asc }) => [asc(table.sku)],
    });
  }

  async function updateCatalogItem(
    catalogItemId: string,
    patch: UpdateCatalogItemInput,
  ): Promise<CatalogItemRow> {
    const parsed = updateCatalogItemSchema.safeParse(patch);
    if (!parsed.success) {
      throw new CommerceValidationError(
        `invalid catalog item patch: ${issuesOf(parsed.error)}`,
      );
    }
    const existing = await getCatalogItem(catalogItemId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const data = parsed.data;
    if (data.name !== undefined) set["name"] = data.name;
    if (data.status !== undefined) set["status"] = data.status;
    if (data.economicEntityId !== undefined) {
      set["economicEntityId"] = data.economicEntityId;
    }
    if (data.variantLabel !== undefined) set["variantLabel"] = data.variantLabel;
    if (data.description !== undefined) set["description"] = data.description;
    if (data.conditionCode !== undefined) {
      set["conditionCode"] = data.conditionCode;
    }
    if (data.defaultCurrency !== undefined) {
      set["defaultCurrency"] = data.defaultCurrency?.toUpperCase() ?? null;
    }
    if (data.defaultPrice !== undefined) set["defaultPrice"] = data.defaultPrice;

    // Primary-key upsert: this package's standing pattern for UPDATE without a
    // direct drizzle-orm dependency.
    await db
      .insert(catalogItems)
      .values({
        id: existing.id,
        sku: existing.sku,
        name: existing.name,
        kind: existing.kind,
        status: existing.status,
      })
      .onConflictDoUpdate({ target: catalogItems.id, set });
    return getCatalogItem(catalogItemId);
  }

  async function archiveCatalogItem(
    catalogItemId: string,
  ): Promise<CatalogItemRow> {
    return updateCatalogItem(catalogItemId, { status: "archived" });
  }

  async function getChannelListing(
    channelListingId: string,
  ): Promise<ChannelListingRow> {
    const row = await db.query.channelListings.findFirst({
      where: (table, { eq }) => eq(table.id, channelListingId),
    });
    if (row === undefined) {
      throw new CommerceNotFoundError(
        `unknown channel listing "${channelListingId}"`,
      );
    }
    return row;
  }

  async function upsertChannelListing(
    input: UpsertChannelListingInput,
  ): Promise<ChannelListingRow> {
    const parsed = upsertChannelListingSchema.safeParse(input);
    if (!parsed.success) {
      throw new CommerceValidationError(
        `invalid channel listing: ${issuesOf(parsed.error)}`,
      );
    }
    const listing = parsed.data;
    const now = new Date();
    const mutable = {
      catalogItemId: listing.catalogItemId,
      channel: listing.channel,
      marketplace: listing.marketplace ?? null,
      marketplaceItemId: listing.marketplaceItemId ?? null,
      status: listing.status,
      listingUrl: listing.listingUrl ?? null,
      listingTitle: listing.listingTitle ?? null,
      currency: listing.currency?.toUpperCase() ?? null,
      price: listing.price ?? null,
      quantityAvailable: listing.quantityAvailable ?? null,
      listedAt: listing.listedAt ?? null,
      endedAt: listing.endedAt ?? null,
      lastSyncedAt: now,
      updatedAt: now,
    };
    // Raw SQL rather than Drizzle's `.onConflictDoUpdate()`: PostgreSQL only
    // considers a PARTIAL unique index as an ON CONFLICT arbiter when the
    // inference specification repeats the index's own predicate
    // (`WHERE external_listing_id is not null`, design 4a), and expressing
    // that predicate through Drizzle needs its `sql` template tag — a
    // `drizzle-orm` import this package deliberately does not take (see
    // `sql.ts`'s module doc). `listing_code` is `NOT NULL` on every row, so
    // the INSERT needs one even though this path never reads it back on a
    // re-sync — the `DO UPDATE SET` below deliberately omits it, so an
    // existing row's code is never touched.
    return withCodeRetry(
      () =>
        db.transaction(async (tx) => {
          const year = now.getUTCFullYear();
          const code = await generateListingCode(tx, year);
          const result = await tx.execute(
            `insert into channel_listings (
               listing_code, catalog_item_id, connection_id, provider, channel,
               marketplace, external_listing_id, external_variation_id,
               marketplace_item_id, status, listing_url, listing_title,
               currency, price, quantity_available, listed_at, ended_at,
               first_ingested_at, last_synced_at, created_at, updated_at
             ) values (
               ${textLiteral(code)}, ${uuidLiteral(listing.catalogItemId)},
               ${uuidLiteral(listing.connectionId)}, ${textLiteral(listing.provider)},
               ${textLiteral(listing.channel)}, ${nullable(mutable.marketplace, textLiteral)},
               ${textLiteral(listing.externalListingId)},
               ${nullable(listing.externalVariationId ?? null, textLiteral)},
               ${nullable(mutable.marketplaceItemId, uuidLiteral)},
               ${textLiteral(mutable.status)}, ${nullable(mutable.listingUrl, textLiteral)},
               ${nullable(mutable.listingTitle, textLiteral)},
               ${nullable(mutable.currency, textLiteral)}, ${nullable(mutable.price, numericLiteral)},
               ${mutable.quantityAvailable === null ? "null" : Math.trunc(mutable.quantityAvailable)},
               ${nullable(mutable.listedAt, timestamptzLiteral)},
               ${nullable(mutable.endedAt, timestamptzLiteral)},
               now(), now(), now(), now()
             )
             on conflict (connection_id, provider, external_listing_id, external_variation_id)
               where external_listing_id is not null
             do update set
               catalog_item_id = excluded.catalog_item_id,
               channel = excluded.channel,
               marketplace = excluded.marketplace,
               marketplace_item_id = excluded.marketplace_item_id,
               status = excluded.status,
               listing_url = excluded.listing_url,
               listing_title = excluded.listing_title,
               currency = excluded.currency,
               price = excluded.price,
               quantity_available = excluded.quantity_available,
               listed_at = excluded.listed_at,
               ended_at = excluded.ended_at,
               last_synced_at = now(),
               updated_at = now()
             returning id`,
          );
          const id = result.rows[0]?.["id"] as string | undefined;
          if (id === undefined) {
            throw new CommerceNotFoundError(
              "channel listing upsert returned no row",
            );
          }
          const row = await tx.query.channelListings.findFirst({
            where: (table, { eq }) => eq(table.id, id),
          });
          if (row === undefined) {
            throw new CommerceNotFoundError(
              "channel listing upsert returned no row",
            );
          }
          return row;
        }),
      { label: "listing code" },
    );
  }

  async function createManualListing(
    input: CreateManualListingInput,
  ): Promise<ChannelListingRow> {
    const parsed = createManualListingSchema.safeParse(input);
    if (!parsed.success) {
      throw new CommerceValidationError(
        `invalid manual listing: ${issuesOf(parsed.error)}`,
      );
    }
    const listing = parsed.data;
    // catalog_items.id is a real FK; a bad id fails loudly here rather than
    // as an opaque insert error.
    await getCatalogItem(listing.catalogItemId);
    const now = new Date();
    return withCodeRetry(
      () =>
        db.transaction(async (tx) => {
          const code = await generateListingCode(tx, now.getUTCFullYear());
          const inserted = await tx
            .insert(channelListings)
            .values({
              listingCode: code,
              catalogItemId: listing.catalogItemId,
              connectionId: null,
              provider: listing.provider,
              channel: listing.channel,
              externalListingId: null,
              externalVariationId: null,
              status: listing.status,
              listingUrl: listing.listingUrl ?? null,
              listingTitle: listing.listingTitle ?? null,
              currency: listing.currency?.toUpperCase() ?? null,
              price: listing.price ?? null,
              // Defaults to 1, not null: a manual listing is almost always
              // one physical unit, and `recordManualSale` (`manual-sales.ts`)
              // needs a starting count to decrement so it can tell "still
              // for sale" from "sold out" without guessing.
              quantityAvailable: listing.quantityAvailable ?? 1,
              listedAt: listing.listedAt ?? (listing.status === "active" ? now : null),
              firstIngestedAt: now,
              lastSyncedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const row = inserted[0];
          if (row === undefined) {
            throw new CommerceNotFoundError(
              "manual listing insert returned no row",
            );
          }
          return row;
        }),
      { label: "listing code" },
    );
  }

  async function findOrCreateCatalogItemBySku(input: {
    sku: string;
    name: string;
    economicEntityId?: string | null;
  }): Promise<CatalogItemRow> {
    const existing = await findCatalogItemBySku(input.sku);
    if (existing !== null) return existing;
    try {
      return await createCatalogItem({
        sku: input.sku,
        name: input.name,
        kind: "simple",
        status: "active",
        economicEntityId: input.economicEntityId ?? null,
      });
    } catch (error) {
      // Two operators listing the same freshly-minted SKU at once: the
      // insert lost the race, so the row the other one created IS the
      // answer.
      if (error instanceof CommerceConflictError) {
        const raced = await findCatalogItemBySku(input.sku);
        if (raced !== null) return raced;
      }
      throw error;
    }
  }

  async function listChannelListings(filter?: {
    connectionId?: string;
    catalogItemId?: string;
    status?: ChannelListingStatus;
  }): Promise<ChannelListingRow[]> {
    return db.query.channelListings.findMany({
      where: (table, { and, eq }) => {
        const conditions = [];
        if (filter?.connectionId !== undefined) {
          conditions.push(eq(table.connectionId, filter.connectionId));
        }
        if (filter?.catalogItemId !== undefined) {
          conditions.push(eq(table.catalogItemId, filter.catalogItemId));
        }
        if (filter?.status !== undefined) {
          conditions.push(eq(table.status, filter.status));
        }
        return conditions.length > 0 ? and(...conditions) : undefined;
      },
      orderBy: (table, { asc }) => [
        asc(table.externalListingId),
        asc(table.id),
      ],
    });
  }

  async function linkMarketplaceItem(
    channelListingId: string,
    marketplaceItemId: string | null,
  ): Promise<ChannelListingRow> {
    await getChannelListing(channelListingId);
    const literal =
      marketplaceItemId === null
        ? "null"
        : `${uuidLiteral(marketplaceItemId)}::uuid`;
    await db.execute(
      `update channel_listings
          set marketplace_item_id = ${literal}, updated_at = now()
        where id = ${uuidLiteral(channelListingId)}`,
    );
    return getChannelListing(channelListingId);
  }

  async function suggestChannelLinks(input: {
    connectionId: string;
    candidates: readonly ChannelListingCandidate[];
    provider?: string;
  }): Promise<ChannelLinkSuggestion[]> {
    const provider = input.provider ?? WOO_PROVIDER;
    const withSku = input.candidates.filter(
      (candidate): candidate is ChannelListingCandidate & { sku: string } =>
        candidate.sku !== null &&
        candidate.sku !== undefined &&
        candidate.sku.trim() !== "",
    );
    if (withSku.length === 0) return [];

    // One read per call, not one per candidate: the catalog is small and the
    // alternative is an N+1 against a table this method scans anyway.
    const skus = new Set(withSku.map((candidate) => normalizeSku(candidate.sku)));
    const items = await db.query.catalogItems.findMany({
      columns: { id: true, sku: true, name: true, status: true, kind: true },
    });
    const bySku = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      if (item.status === "archived") continue;
      // Only leaf items may be sold; a variant group is not a sellable thing.
      if (item.kind === "variant_group") continue;
      const normalized = normalizeSku(item.sku);
      if (!skus.has(normalized)) continue;
      // First writer wins deterministically; SKUs are unique, so a collision
      // here can only be a case-fold clash, which is worth not guessing about.
      if (!bySku.has(normalized)) bySku.set(normalized, item);
    }
    if (bySku.size === 0) return [];

    const existing = await db.query.channelListings.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, input.connectionId),
          eq(table.provider, provider),
        ),
      columns: {
        externalListingId: true,
        externalVariationId: true,
      },
    });
    const linked = new Set(
      existing.map(
        (row) => `${row.externalListingId} ${row.externalVariationId ?? ""}`,
      ),
    );

    const suggestions: ChannelLinkSuggestion[] = [];
    for (const candidate of withSku) {
      const normalized = normalizeSku(candidate.sku);
      const item = bySku.get(normalized);
      if (item === undefined) continue;
      const variation = candidate.externalVariationId ?? null;
      suggestions.push({
        externalListingId: candidate.externalListingId,
        externalVariationId: variation,
        channelSku: candidate.sku,
        catalogItemId: item.id,
        catalogItemSku: item.sku,
        catalogItemName: item.name,
        listingTitle: candidate.title ?? null,
        matchReason:
          item.sku === candidate.sku ? "exact_sku" : "normalized_sku",
        alreadyLinked: linked.has(
          `${candidate.externalListingId} ${variation ?? ""}`,
        ),
      });
    }
    return suggestions;
  }

  async function suggestWooChannelLinks(input: {
    connectionId: string;
    products: readonly WooProductFact[];
  }): Promise<ChannelLinkSuggestion[]> {
    return suggestChannelLinks({
      connectionId: input.connectionId,
      provider: WOO_PROVIDER,
      candidates: input.products.map((product) => ({
        externalListingId: product.externalProductId,
        externalVariationId: null,
        sku: product.sku,
        title: product.name,
      })),
    });
  }

  return {
    createCatalogItem,
    getCatalogItem,
    findCatalogItemBySku,
    listCatalogItems,
    updateCatalogItem,
    archiveCatalogItem,
    upsertChannelListing,
    createManualListing,
    findOrCreateCatalogItemBySku,
    getChannelListing,
    listChannelListings,
    linkMarketplaceItem,
    suggestChannelLinks,
    suggestWooChannelLinks,
  };
}
