/**
 * Every Dockhand path this adapter may build, and — just as importantly — an
 * enumerated list of the ones it may **never** build.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://finsys-dockhand.mintlify.app/api/overview as the
 * primary source, with the ruling that *"the repo's no-AI-ingestion wish covers
 * source, not published docs"*. Every path below is transcribed from that
 * documentation site — its API overview, its authentication page, and the
 * per-endpoint pages the site's own `llms.txt` manifest enumerates. No Dockhand
 * source was read.
 *
 * Two facts from the overview shape everything here:
 *
 * - **the base path is `/api`, unversioned**, and upstream states the tradeoff
 *   plainly: *"The API currently does not use versioning. Breaking changes are
 *   avoided, and new fields are added in a backward-compatible manner."* An
 *   additive-compatibility promise is weaker than a version, so every response
 *   field this adapter reads is optional except an identifier;
 * - **authentication is session-cookie only.** The API reference documents
 *   *"HTTP-only session cookies"* obtained from `POST /api/auth/login` and sent
 *   back as `Cookie: session=YOUR_SESSION_TOKEN`. There is no API key, bearer
 *   token, or service account anywhere in the published authentication
 *   documentation. This resolves — in the API reference's favour — the
 *   fleet-observability design's complaint of *"contradictory auth
 *   documentation"*.
 *
 * ## The line this module draws, and why it is drawable
 *
 * [Rule 13](../../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * forbids Loxep calling *"a companion's mutating endpoints"*. The owner ruled
 * one carve-out on 2026-08-13: host registration and configuration are Phase
 * 7-style desired state, while container lifecycle verbs stay forbidden. That
 * carve-out only holds if the two are separable by inspection, and against
 * Dockhand's endpoint map they are:
 *
 * ```text
 * /api/environments…    edits Dockhand's OWN INVENTORY of which hosts it
 *                       manages — an address, a connection type, a TLS bundle,
 *                       a label. Nothing executes on the target machine.
 * everything else       acts on a Docker daemon: containers, stacks, images,
 *                       networks, volumes, schedules. Code runs ON a host.
 * ```
 *
 * **The review test is the second column, not the HTTP method.** "Is this a
 * POST?" would have blocked the login exchange and permitted nothing useful;
 * "does this cause code to run on a managed host?" separates
 * `PUT /api/environments/{id}` from `POST /api/containers/{id}/start` exactly
 * where the fourth row of the inherited line already sits.
 *
 * {@link DOCKHAND_FORBIDDEN_PATH_SEGMENTS} encodes the second column, and
 * `test/forbidden-verbs.test.ts` asserts that no exported member and no
 * request the adapter makes touches it.
 */

/** The unversioned API prefix. Upstream's own words are in the module doc. */
export const DOCKHAND_API_PREFIX = "/api";

/** `GET` — is authentication enabled, and is this session still valid. */
export const DOCKHAND_SESSION_PATH = `${DOCKHAND_API_PREFIX}/auth/session`;

/** `POST` — the login exchange that yields the session cookie. */
export const DOCKHAND_LOGIN_PATH = `${DOCKHAND_API_PREFIX}/auth/login`;

/**
 * `GET` / `POST` / `PUT` — Dockhand's inventory of managed Docker hosts.
 *
 * **Dockhand calls a host an "environment".** That naming is worth stating
 * once: Loxep's fleet vocabulary says *host*, `hosting_targets` says *target*,
 * and Dockhand says *environment*, and all three mean one machine running a
 * Docker daemon. This is the ONE Dockhand resource Loxep may write, per the
 * owner's 2026-08-13 carve-out.
 */
export const DOCKHAND_ENVIRONMENTS_PATH = `${DOCKHAND_API_PREFIX}/environments`;

export function dockhandEnvironmentPath(id: number | string): string {
  return `${DOCKHAND_ENVIRONMENTS_PATH}/${String(id)}`;
}

/** `GET` — containers in one environment. Read-only, forever. */
export const DOCKHAND_CONTAINERS_PATH = `${DOCKHAND_API_PREFIX}/containers`;

/** `GET` — Compose stacks in one environment. Read-only, forever. */
export const DOCKHAND_STACKS_PATH = `${DOCKHAND_API_PREFIX}/stacks`;

/**
 * The connection types Dockhand documents for a managed host, transcribed from
 * its remote-hosts integration page.
 *
 * Kept as a closed list because each one has different required fields, and a
 * desired-state record that names a type Dockhand does not support would fail
 * at apply time rather than at validation time.
 */
export const DOCKHAND_CONNECTION_TYPES = [
  /** Local Docker socket; `socketPath` (default `/var/run/docker.sock`). */
  "socket",
  /** TCP to a remote daemon; needs `host`, `port`, `protocol`, TLS optional. */
  "direct",
  /** *"HTTP connection with token authentication via Hawser agent"*. */
  "hawser-standard",
  /** *"WebSocket connection for NAT traversal and edge deployments"*. */
  "hawser-edge",
] as const;

export type DockhandConnectionType =
  (typeof DOCKHAND_CONNECTION_TYPES)[number];

/** Upstream defaults, so Loxep's diff does not report noise as drift. */
export const DOCKHAND_DEFAULT_PORT = 2375;
export const DOCKHAND_DEFAULT_PROTOCOL = "http";
export const DOCKHAND_DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
/** Upstream documents `labels` as *"string array, max 10"*. */
export const DOCKHAND_MAX_LABELS = 10;

/** The complete set of path prefixes this adapter may request. */
export const DOCKHAND_ALLOWED_PATH_PREFIXES = [
  DOCKHAND_SESSION_PATH,
  DOCKHAND_LOGIN_PATH,
  DOCKHAND_ENVIRONMENTS_PATH,
  DOCKHAND_CONTAINERS_PATH,
  DOCKHAND_STACKS_PATH,
] as const;

/**
 * The paths that may be reached with a method other than `GET`.
 *
 * Three, and each is justified separately:
 * - `/api/auth/login` — the credential exchange, which mutates nothing on any
 *   host and is the only way Dockhand lets a machine authenticate at all;
 * - `/api/environments` (`POST`) and `/api/environments/{id}` (`PUT`) — the
 *   owner's host-registration carve-out. See the module doc.
 */
export const DOCKHAND_ALLOWED_NON_GET_PREFIXES = [
  DOCKHAND_LOGIN_PATH,
  DOCKHAND_ENVIRONMENTS_PATH,
] as const;

/**
 * Path segments that mark a call as *"anything that runs ON a host"* — the
 * fourth row of the inherited line, and the verbs rule 13 forbids.
 *
 * These endpoints all exist and are all reachable against any Dockhand
 * instance; the fleet-observability design lists them by name (*"Start, stop,
 * restart, exec a terminal, browse files inside a container, edit and redeploy
 * a Compose stack, inject secrets at deploy time"*). They are enumerated here
 * so that "the adapter refuses them" is an assertion in
 * `test/forbidden-verbs.test.ts` rather than an intention in a comment.
 *
 * Note `containers` and `stacks` are absent: reading them is permitted, and it
 * is the *sub-resources and non-GET methods* beneath them that are not. The
 * request guard enforces that split by method; this list catches the segments
 * that have no read meaning at all.
 */
export const DOCKHAND_FORBIDDEN_PATH_SEGMENTS = [
  "exec",
  "logs",
  "start",
  "stop",
  "restart",
  "kill",
  "pause",
  "unpause",
  "lifecycle",
  "deploy",
  "redeploy",
  "prune",
  "pull",
  "push",
  "images",
  "networks",
  "volumes",
  "schedules",
  "auto-update",
  "git-sync",
  "terminal",
  "files",
] as const;

/**
 * The verbs no exported member of this package may be named after. Used by
 * `test/forbidden-verbs.test.ts` to assert the SURFACE, not just the traffic —
 * because the failure mode being guarded against is a future edit adding
 * `restartContainer` and a caller finding it, not a stray fetch.
 */
export const DOCKHAND_FORBIDDEN_MEMBER_VERBS = [
  "start",
  "stop",
  "restart",
  "kill",
  "pause",
  "unpause",
  "exec",
  "deploy",
  "redeploy",
  "recreate",
  "prune",
  "pull",
  "push",
  "remove",
  "delete",
  "destroy",
  "logs",
  "terminal",
  "shell",
] as const;
