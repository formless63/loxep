/**
 * Every Termix path this adapter may build, and — just as importantly — the
 * segments it must never touch, given how large and dangerous the rest of
 * Termix's surface is.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner-supplied primary source, https://docs.termix.site/api/termix-api/,
 * is a JavaScript-rendered API-reference site (Docusaurus +
 * `docusaurus-openapi-docs`) this environment could not fetch as readable
 * text beyond its navigation. Its GENERATING SOURCE is public at
 * `Termix-SSH/Docs` (the repo behind docs.termix.site, found via
 * `Termix-SSH/Termix`'s own README/homepage link), specifically
 * `static/openapi.json` — a full OpenAPI 3.0.3 document, 274 paths, last
 * regenerated 2026-08-06 ("feat: update API docs for 2.6.1"). That IS the
 * published spec this doc site renders, so every path/field cited here is
 * read directly from it, not inferred.
 *
 * **One documentation inconsistency is worth recording rather than
 * drifting past.** The individual per-operation `.mdx` pages under
 * `docs/api/` are a SEPARATE generated artifact that were last regenerated
 * 2026-01-13 ("feat: add openapi json support") and have not been
 * regenerated since — `docs/api/get-all-ssh-hosts.api.mdx` still shows the
 * path as `/ssh/db/host`, while the current `openapi.json` (2026-08-06) has
 * it at `/host/db/host`. This module follows `openapi.json` as the more
 * current, machine-generated source; the stale `.mdx` path is recorded here
 * so a future reader who spots the mismatch on the live site does not
 * mistake it for an adapter bug.
 *
 * ## Auth: a global `bearerAuth` requirement the spec never actually narrows
 *
 * `openapi.json`'s top-level `security` is `[{"bearerAuth": []}]`, and
 * **no individual operation overrides it** — not even `POST /users/login`,
 * whose own description reads *"Authenticates a user and returns a JWT."*
 * A login endpoint cannot literally require the JWT it is about to issue,
 * so this adapter treats login as the one unauthenticated exception the
 * spec should have declared and does not, exactly as
 * `TERMIX_ALLOWED_NON_GET_PATHS` encodes below.
 *
 * The JWT itself: `GET /users/me/token` ("Get current session token")
 * documents the field name directly — response `{ "token": string }" —
 * and its own description, *"Returns the JWT for the currently
 * authenticated session. Intended for mobile WebView clients that cannot
 * read HTTP-only cookies,"* describes precisely this adapter's situation: a
 * headless server-to-server client. `credentials.ts` and `adapter.ts`
 * explain the two-step exchange this implies.
 *
 * ## Read-only by construction
 *
 * Termix's full surface includes container start/stop/restart, systemd
 * service control, process signals, file deletion, terminal exec, and
 * snippet execution against every connected host — an order of magnitude
 * larger danger surface than Dockhand's. This module therefore enumerates
 * `TERMIX_FORBIDDEN_PATH_SEGMENTS` defensively even though the four read
 * paths below never approach them, exactly as Dockhand's does, and
 * `test/boundary.test.ts` asserts neither the adapter's traffic nor its
 * declared paths ever touch one.
 */

/** `POST` — authenticate; the one exception to the spec's global bearerAuth. */
export const TERMIX_LOGIN_PATH = "/users/login";

/** `GET` — mint a JWT for the just-established session (see module doc). */
export const TERMIX_ME_TOKEN_PATH = "/users/me/token";

/** `GET` — whoami-equivalent identity check; this adapter's probe. */
export const TERMIX_ME_PATH = "/users/me";

/** `GET` — all SSH hosts for the authenticated user. Current path (2026-08-06 spec). */
export const TERMIX_HOSTS_PATH = "/host/db/host";

/** `GET` — a map of host id -> status entry, for every host. */
export const TERMIX_STATUS_PATH = "/status";

/** `GET` — active terminal sessions (own and shared-with-me). Fully-specified schema. */
export const TERMIX_ACTIVE_SESSIONS_PATH = "/open-tabs/active-sessions";

/** The complete set of paths this adapter may ever request. */
export const TERMIX_ALLOWED_PATHS = [
  TERMIX_LOGIN_PATH,
  TERMIX_ME_TOKEN_PATH,
  TERMIX_ME_PATH,
  TERMIX_HOSTS_PATH,
  TERMIX_STATUS_PATH,
  TERMIX_ACTIVE_SESSIONS_PATH,
] as const;

/** The only path reachable with a method other than `GET`. */
export const TERMIX_ALLOWED_NON_GET_PATHS = [TERMIX_LOGIN_PATH] as const;

/**
 * Path segments that mark a call as reaching Termix's lifecycle/write
 * surface — enumerated from `openapi.json`'s own tag list (Docker, SSH
 * Tunnels, Terminal, RBAC, Credentials, Snippets, File Manager, Host
 * Metrics managers) so "the adapter refuses them" is an assertion rather
 * than an intention.
 */
export const TERMIX_FORBIDDEN_PATH_SEGMENTS = [
  "docker",
  "containers",
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "kill",
  "signal",
  "exec",
  "terminal",
  "tunnel",
  "tunnels",
  "snippets",
  "credentials",
  "rbac",
  "share",
  "shared-hosts",
  "file_manager",
  "files",
  "delete",
  "remove",
  "bulk-import",
  "bulk-update",
  "ssh-config-import",
  "autostart",
  "folders",
  "guacamole",
  "session-sharing",
  "webauthn",
  "totp",
  "ldap",
  "sso",
  "opkssh",
  "managers",
  "processes",
  "services",
  "wireguard",
] as const;

/** Verbs no exported member of this package may be named after. */
export const TERMIX_FORBIDDEN_MEMBER_VERBS = [
  "start",
  "stop",
  "restart",
  "kill",
  "pause",
  "unpause",
  "exec",
  "delete",
  "remove",
  "destroy",
  "create",
  "update",
  "share",
  "revoke",
  "execute",
  "signal",
] as const;
