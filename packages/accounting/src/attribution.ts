/**
 * Economic-entity attribution for expenses (ADR-0017, applied per the Phase 5
 * design).
 *
 * Attribution is a STORED SNAPSHOT resolved once at creation, never a read-time
 * join — the rule Phase 3 argued for orders and Phase 4 repeated for
 * acquisitions and items. An expense keeps its own column for the same reason
 * an acquisition does: it is a fact about money that left one operating
 * identity, and which identity that was does not change when configuration
 * does.
 *
 * ## The ladder, and why it is shorter than Phase 4's
 *
 * ```text
 * 1  explicit operator choice        'manual'
 * 2  the installation default        'installation_default'
 * 3  nothing                         'unattributed'
 * ```
 *
 * Three rungs, not five. An expense has no connection to inherit from and no
 * parent lot to inherit from, so `connection_default` and `acquisition_default`
 * would be unreachable strings in a `CHECK` — and a `CHECK` member nothing can
 * produce is worse than an absent one, because it makes a reader believe a code
 * path exists.
 *
 * Nullable throughout: recording that money was spent must never fail or block
 * on an unattributed installation. An unattributed expense is a visible backlog
 * to resolve, not a rejected fact. Operational facts before accounting.
 *
 * ## `entity_attribution_source` is not description
 *
 * It is the ELIGIBILITY MARKER for bulk re-attribution. A row whose source is
 * `manual` was chosen by a human and may never be rewritten by a bulk run;
 * `installation_default` and `unattributed` rows may. That single rule is why
 * the column exists, and `reattributeDefaults` in `expenses.ts` is the only
 * thing that reads it.
 *
 * ## Why the installation default is a parameter and not a setting read
 *
 * The natural home for "which entity do new expenses belong to" is a registered
 * application setting, exactly like `inventory.default_economic_entity`. That
 * key is NAMED here ({@link DEFAULT_ENTITY_SETTING_KEY}) and deliberately NOT
 * registered, because registration is an edit to `@loxep/domain`'s shipped
 * settings registry, which this slice does not own. The caller passes the value
 * it resolved; when the key is registered, this signature does not change.
 */
import type { ExpenseEntityAttributionSource } from "@loxep/db/schema";

/** The installation-wide accounting defaults namespace (no DDL; settings keys). */
export const ACCOUNTING_SETTINGS_PREFIX = "accounting.";

/**
 * Setting key for the default economic entity new expenses inherit.
 *
 * Named, not registered — see the module note.
 */
export const DEFAULT_ENTITY_SETTING_KEY = "accounting.default_economic_entity";

/**
 * Attribution sources a bulk re-attribution run may rewrite.
 *
 * `manual` is absent and its absence is the point.
 */
export const REATTRIBUTABLE_SOURCES = [
  "installation_default",
  "unattributed",
] as const satisfies readonly ExpenseEntityAttributionSource[];

export interface ResolvedExpenseAttribution {
  economicEntityId: string | null;
  entityAttributionSource: ExpenseEntityAttributionSource;
}

/**
 * Resolve the ladder once, at creation.
 *
 * `explicitEntityId` of `null` is a deliberate operator choice to leave an
 * expense unattributed and is NOT the same as omitting it: the former records
 * `unattributed` with no default applied, the latter falls through to the
 * installation default. Distinguishing them is what stops a later default from
 * silently claiming rows a human deliberately left alone.
 */
export function resolveExpenseAttribution(input: {
  explicitEntityId?: string | null;
  installationDefaultEntityId?: string | null;
}): ResolvedExpenseAttribution {
  if (input.explicitEntityId !== undefined) {
    return input.explicitEntityId === null
      ? { economicEntityId: null, entityAttributionSource: "unattributed" }
      : {
          economicEntityId: input.explicitEntityId,
          entityAttributionSource: "manual",
        };
  }
  const fallback = input.installationDefaultEntityId ?? null;
  return fallback === null
    ? { economicEntityId: null, entityAttributionSource: "unattributed" }
    : {
        economicEntityId: fallback,
        entityAttributionSource: "installation_default",
      };
}
