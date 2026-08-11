/**
 * Economic-entity attribution for acquisitions and inventory items
 * (ADR-0017, applied per the Phase 4 design).
 *
 * Attribution is a STORED SNAPSHOT, resolved once at creation and never a
 * read-time join. Phase 3 argued that for orders; Phase 4 repeats it and adds
 * one thing orders did not need — the item-level column — because:
 *
 * 1. an inventory item can exist with NO acquisition (opening balances, found
 *    stock, personal conversions, restocked returns), so a
 *    derived-through-acquisition attribution would leave exactly the cases a
 *    small operator cares most about unattributed;
 * 2. one lot can legitimately split across entities (a haul bought on a
 *    personal card, part kept personally and part contributed to an LLC);
 * 3. stock is a HELD ASSET, and held assets change hands. An order is a
 *    completed past event; an item is a thing you still own.
 *
 * ## The precedence ladder
 *
 * ```text
 * acquisitions                              inventory_items
 * ----------------------------------------  ----------------------------------
 * 1 explicit operator choice   'manual'      1 explicit             'manual'
 * 2 installation default       'installation_default'
 *                                            2 the acquisition's entity
 *                                                                   'acquisition_default'
 * 3 connections.economic_entity_id           3 installation default
 *     'connection_default' (reserved)        4 connection default (reserved)
 * 4 nothing                    'unattributed'  5 nothing            'unattributed'
 * ```
 *
 * Nullable throughout, because creation must never fail or block on an
 * unattributed installation. An unattributed lot is a visible backlog to
 * resolve, not a rejected fact. Operational facts before accounting.
 *
 * ## `entity_attribution_source` is not description
 *
 * It is the ELIGIBILITY MARKER for bulk re-attribution. A row whose source is
 * `manual` was chosen by a human and may never be rewritten by a bulk run;
 * `installation_default`, `acquisition_default`, `connection_default`, and
 * `unattributed` rows may. That single rule is why the column exists.
 *
 * ## On items, attribution is immutable
 *
 * Changing which entity OWNS an item is a TRANSFER, not an `UPDATE` — see
 * `items.ts`'s `transferEntity`. The bulk re-attribution here is the Phase 3
 * operation applied to items: it CORRECTS a default that was never a decision,
 * and that is a different act from moving an asset between operating
 * identities. Nothing in this module rewrites a `manual` row.
 */
import type {
  AcquisitionEntityAttributionSource,
  ItemEntityAttributionSource,
} from "@loxep/db/schema";

/** The installation-wide inventory defaults namespace (no DDL; settings keys). */
export const INVENTORY_SETTINGS_PREFIX = "inventory.";

/** Setting key for the default economic entity new acquisitions inherit. */
export const DEFAULT_ENTITY_SETTING_KEY = "inventory.default_economic_entity";

/** Setting key for the default intake location. */
export const DEFAULT_LOCATION_SETTING_KEY = "inventory.default_location";

/** Setting key for the default lot cost allocation basis. */
export const DEFAULT_ALLOCATION_BASIS_SETTING_KEY =
  "inventory.default_cost_allocation_basis";

export interface ResolvedAttribution<TSource extends string> {
  economicEntityId: string | null;
  entityAttributionSource: TSource;
  entityAttributedAt: Date | null;
  entityAttributedByUserId: string | null;
}

/**
 * The acquisition ladder. `connectionEntityId` is threaded through and
 * currently only reachable via the reserved ingested-purchase path; it is
 * accepted now so the eventual eBay-purchase-history importer needs no change
 * here and no `CHECK` widening in the database.
 */
export function resolveAcquisitionAttribution(input: {
  explicitEntityId?: string | null;
  installationDefaultEntityId?: string | null;
  connectionEntityId?: string | null;
  actorUserId?: string | null;
  now: Date;
}): ResolvedAttribution<AcquisitionEntityAttributionSource> {
  if (input.explicitEntityId !== undefined && input.explicitEntityId !== null) {
    return {
      economicEntityId: input.explicitEntityId,
      entityAttributionSource: "manual",
      entityAttributedAt: input.now,
      entityAttributedByUserId: input.actorUserId ?? null,
    };
  }
  if (
    input.installationDefaultEntityId !== undefined &&
    input.installationDefaultEntityId !== null
  ) {
    return {
      economicEntityId: input.installationDefaultEntityId,
      entityAttributionSource: "installation_default",
      entityAttributedAt: null,
      entityAttributedByUserId: null,
    };
  }
  if (input.connectionEntityId !== undefined && input.connectionEntityId !== null) {
    return {
      economicEntityId: input.connectionEntityId,
      entityAttributionSource: "connection_default",
      entityAttributedAt: null,
      entityAttributedByUserId: null,
    };
  }
  return {
    economicEntityId: null,
    entityAttributionSource: "unattributed",
    entityAttributedAt: null,
    entityAttributedByUserId: null,
  };
}

/**
 * The item ladder. An item created FROM an acquisition snapshots that lot's
 * entity with source `acquisition_default`; an item created any other way falls
 * through to the same ladder an acquisition uses.
 */
export function resolveItemAttribution(input: {
  explicitEntityId?: string | null;
  acquisitionEntityId?: string | null;
  installationDefaultEntityId?: string | null;
  connectionEntityId?: string | null;
  actorUserId?: string | null;
  now: Date;
}): ResolvedAttribution<ItemEntityAttributionSource> {
  if (input.explicitEntityId !== undefined && input.explicitEntityId !== null) {
    return {
      economicEntityId: input.explicitEntityId,
      entityAttributionSource: "manual",
      entityAttributedAt: input.now,
      entityAttributedByUserId: input.actorUserId ?? null,
    };
  }
  if (
    input.acquisitionEntityId !== undefined &&
    input.acquisitionEntityId !== null
  ) {
    return {
      economicEntityId: input.acquisitionEntityId,
      entityAttributionSource: "acquisition_default",
      entityAttributedAt: null,
      entityAttributedByUserId: null,
    };
  }
  const fallback = resolveAcquisitionAttribution({
    ...(input.installationDefaultEntityId === undefined
      ? {}
      : { installationDefaultEntityId: input.installationDefaultEntityId }),
    ...(input.connectionEntityId === undefined
      ? {}
      : { connectionEntityId: input.connectionEntityId }),
    actorUserId: input.actorUserId ?? null,
    now: input.now,
  });
  return fallback as ResolvedAttribution<ItemEntityAttributionSource>;
}

/**
 * Attribution sources a bulk re-attribution run may rewrite.
 *
 * `manual` is absent and must stay absent. It is the one value that records a
 * human decision, and a bulk operation that rewrote it would silently discard
 * the only information the column was created to preserve.
 */
export const REATTRIBUTABLE_SOURCES = [
  "installation_default",
  "acquisition_default",
  "connection_default",
  "unattributed",
] as const;
