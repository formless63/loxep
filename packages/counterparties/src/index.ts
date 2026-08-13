/**
 * @loxep/counterparties — the outside parties Loxep's economic entities do
 * business with.
 *
 * ## The rule this package exists to make physical
 *
 * ```text
 * Does Loxep attribute this party's activity as OURS, and would it land in one
 * of OUR accounting books as our own revenue, expense, asset, or liability?
 *    yes -> economic_entity   (installation-owned; ADR-0017; @loxep/domain)
 *    no  -> counterparty      (an outside party; here)
 * ```
 *
 * ADR-0017, the Implementation Contract, Domain Boundaries, the Foundational
 * Data Model, cross-domain rule 10, and Master Domain Map section 6 all state
 * it in prose. Until migration 0006 there was no schema to test it against, and
 * this package is the code half of that test: `counterparties` has no
 * `economic_entity_id`, `economic_entities` gains no `counterparty_id`, a
 * person cannot hold a tax identifier, and the only API that relates the two
 * concepts is {@link CounterpartiesService.declareMirror}, which is audited and
 * reportable precisely because it is the one deliberate exception.
 *
 * ## This package is the counterparty QUARTER of Phase 6
 *
 * The Phase 6 design specifies nineteen tables across four domains. Five ship
 * here as of migration 0011: the original four (`counterparties`,
 * `counterparty_contacts`, `contact_channels`, `counterparty_entity_roles`)
 * plus `counterparty_sites`, whose first consumer (`projects`) now exists.
 * **Projects, time entries, billing rates, material uses, service plans,
 * subscriptions, service periods, invoices, invoice lines, invoice sources,
 * and payments are all absent from THIS package** — `projects`,
 * `billing_rates`, `time_entries`, and `project_material_uses` are physical
 * tables (migration 0011) with no service package yet, because open question
 * 14's own recommendation maps them to a NEW `@loxep/work` package, and new
 * package scaffolding is orchestrator-only. See `bd show loxep-nw0` and the
 * design's "Provisional implementation decisions" for the full account. The
 * own-versus-integrate line for invoicing (open question 1) is answered —
 * Invoice Ninja first-class, nothing native ships yet — but that only bounds
 * how much of the billing/services milestones exist; it does not change where
 * Projects-and-Work code lives.
 *
 * Counterparties are separable in a way the rest of Phase 6 is not — the
 * design says so explicitly: *"Migration A depends on nothing beyond the
 * foundation and Phase 3, which means the counterparty milestone can ship even
 * if Phases 4 and 5 slip."*
 *
 * ## Everything here is PROVISIONAL
 *
 * Written under an explicit owner directive to implement the recommendations
 * this slice touches and mark the result PROVISIONAL for review. The three
 * worth a reviewer's attention first, in descending order of how expensive
 * each is to reverse after data exists:
 *
 * 1. **The merge posture** (design OQ3): survivor pointer, never a rewrite,
 *    with pointer compression so the documented single-hop resolution stays
 *    true. The two postures produce different data and there is no migration
 *    between them that recovers what a rewrite discarded. See `merge.ts`.
 * 2. **The nullable entity on a role** (design OQ2): making it `not null` later
 *    means inventing an entity for every existing row; making it nullable later
 *    is free. See `roles.ts`.
 * 3. **The declared mirror** (design OQ12): a door in a wall ADR-0017 built
 *    deliberately. If the owner prefers the wall intact, the column is dropped
 *    and intercompany billing is unsupported — a defensible answer that should
 *    be written down rather than assumed. See `counterparties.ts`.
 *
 * ## What this package does NOT do
 *
 * No CRM pipeline, leads, stages, or campaigns. No project CRUD, time-entry
 * recording, rate resolution, or material-use linking — `sites.ts` is the one
 * Projects-and-Work-adjacent capability here, because sites are a
 * Counterparties-domain table (see its own header). No invoices, quotes, AR
 * aging, dunning, PDFs, email, portals, or payment collection. No address
 * validation, normalization, or geocoding — `sites.ts` stores free text plus
 * `country`/`region` and nothing richer. No personal tax identifiers, ever.
 * No fuzzy matching and no automatic merge: `dedupe.ts` produces candidates and
 * a human decides. No harvesting of names or emails out of retained provider
 * payloads — a marketplace buyer becomes a counterparty only when an operator
 * says so.
 */

export {
  CounterpartyError,
  CounterpartyValidationError,
  CounterpartyNotFoundError,
  CounterpartyConflictError,
  CounterpartyBoundaryError,
  CounterpartyMergeError,
} from "./errors.ts";

export { normalizeChannelValue, normalizeName } from "./normalize.ts";

export {
  counterpartyReferenceCode,
  counterpartySiteCode,
  isUniqueViolation,
  withCodeRetry,
} from "./codes.ts";

export {
  createMergeService,
  pickerPredicate,
  resolvedIdExpression,
} from "./merge.ts";
export type { MergeInput, MergeResult, MergeService } from "./merge.ts";

export { createCounterpartiesService } from "./counterparties.ts";
export type {
  CounterpartiesService,
  CounterpartyListFilter,
  CounterpartyRow,
  CreateCounterpartyInput,
  UpdateCounterpartyInput,
} from "./counterparties.ts";

export { createContactsService } from "./contacts.ts";
export type {
  AddChannelInput,
  AddContactInput,
  ContactChannelRow,
  ContactsService,
  CounterpartyContactRow,
} from "./contacts.ts";

export { createRolesService } from "./roles.ts";
export type {
  CounterpartyRoleRow,
  GrantRoleInput,
  RolesService,
} from "./roles.ts";

export { createDedupeService } from "./dedupe.ts";
export type {
  DedupeService,
  DuplicateCandidateGroup,
  DuplicateCandidateMember,
  DuplicateMatchKind,
} from "./dedupe.ts";

export { createSitesService } from "./sites.ts";
export type {
  CounterpartySiteRow,
  CreateSiteInput,
  SitesService,
  UpdateSiteInput,
} from "./sites.ts";
