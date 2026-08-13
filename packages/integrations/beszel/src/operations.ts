/**
 * Every Beszel path this adapter may build, in one place, so the boundary test
 * can enumerate the surface and prove what is absent.
 *
 * ## Verification trail, 2026-08-13
 *
 * Beszel publishes no OpenAPI document. Its REST guide
 * (https://beszel.dev/guide/rest-api) delegates the wire contract wholesale:
 * *"Because Beszel is built on PocketBase, you can use the PocketBase web APIs
 * and client-side SDKs to read or update data from outside Beszel itself."* The
 * paths below therefore come from two sources, and each is marked with which:
 *
 * - **PB** — PocketBase's published API reference
 *   (https://pocketbase.io/docs/api-records/), which is the contract Beszel
 *   adopted;
 * - **BZ** — Beszel's own REST guide, which names the collections
 *   (`users`, `systems`) and demonstrates the filter DSL against them.
 *
 * ## Only reads, and that is enforced rather than intended
 *
 * PocketBase exposes `POST`, `PATCH`, and `DELETE` on every collection, so
 * `PATCH /api/collections/systems/records/{id}` is reachable against any Beszel
 * hub — the fleet-observability design names it explicitly: *"Beszel can update
 * a system record. Those calls exist and are reachable."*
 * [Rule 13](../../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * forbids Loxep calling it, and no Beszel milestone has a carve-out. This
 * module lists no mutating path at all, and `test/boundary.test.ts` asserts
 * that every recorded request used `GET` — except the single documented
 * exception below.
 *
 * ## The one POST, and why it is not a mutation
 *
 * `auth-with-password` is a `POST` that writes nothing: it exchanges the stored
 * readonly login for a short-lived token. PocketBase models authentication as a
 * record-collection action, which is why a read-only integration has to send
 * one `POST` to read anything. It is named `AUTH` rather than listed with the
 * reads so the boundary test can allow exactly this path and no other.
 */

/** The PocketBase API prefix Beszel inherits. **PB** */
export const BESZEL_API_PREFIX = "/api";

/**
 * The collection holding one record per monitored machine. **BZ** — the REST
 * guide's first example lists and filters `systems` records.
 */
export const BESZEL_SYSTEMS_COLLECTION = "systems";

/**
 * The collection holding ordinary Beszel accounts. **BZ/PB** — upstream states
 * that *"regular user accounts and PocketBase superuser accounts are entirely
 * separate"* (https://beszel.dev/guide/user-accounts), so this is `users` and
 * emphatically **not** `_superusers`.
 */
export const BESZEL_USERS_COLLECTION = "users";

/**
 * The superuser collection, named here **only to be excluded**.
 *
 * The fleet-observability design gated Beszel on the belief that a read
 * consumer had to authenticate here. It does not, and a boundary test asserts
 * this string never appears in a request URL — so a later change that "fixes"
 * an auth failure by reaching for the superuser endpoint fails a test instead
 * of quietly widening what Loxep holds.
 */
export const BESZEL_SUPERUSERS_COLLECTION = "_superusers";

/**
 * The unauthenticated health path, inherited from PocketBase. **PB**
 *
 * This is the whole of Beszel's tier-2 surface: a reachability probe that needs
 * no credential at all.
 */
export const BESZEL_HEALTH_PATH = `${BESZEL_API_PREFIX}/health`;

/** `POST` — the login exchange. See the module doc for why it is a POST. */
export const BESZEL_AUTH_PATH = `${BESZEL_API_PREFIX}/collections/${BESZEL_USERS_COLLECTION}/auth-with-password`;

/** `GET` — the paged list of monitored systems. **PB** shape, **BZ** collection. */
export const BESZEL_SYSTEMS_PATH = `${BESZEL_API_PREFIX}/collections/${BESZEL_SYSTEMS_COLLECTION}/records`;

/**
 * The complete set of paths this adapter may request, as a closed literal.
 *
 * A boundary test asserts that every URL the adapter produced starts with one
 * of these, which turns "the adapter is read-only" from a review convention
 * into a failing assertion — the fleet-observability design's own
 * recommendation for open question 5: *"an adapter-level rule that only `GET`
 * … may leave the fleet integration boundary, with a test per adapter rather
 * than a code-review convention"*.
 */
export const BESZEL_ALLOWED_PATHS = [
  BESZEL_HEALTH_PATH,
  BESZEL_AUTH_PATH,
  BESZEL_SYSTEMS_PATH,
] as const;

/** The only path this adapter may reach with a method other than `GET`. */
export const BESZEL_ALLOWED_NON_GET_PATHS = [BESZEL_AUTH_PATH] as const;

/**
 * PocketBase's paging cap. **PB** documents `perPage` with a default of 30;
 * Beszel installations are tens of machines, not thousands, so one page of 200
 * reads an entire fleet in a single request and the pager below it exists only
 * so a large estate degrades correctly rather than silently truncating.
 */
export const BESZEL_LIST_PER_PAGE = 200;

/** Hard stop on pagination, so a misbehaving hub cannot spin the worker. */
export const BESZEL_MAX_LIST_PAGES = 25;
