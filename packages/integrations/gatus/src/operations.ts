/**
 * Every Gatus path this adapter may build, in one place, so the boundary test
 * can enumerate the surface and prove what is absent.
 *
 * ## Verification trail, 2026-08-13
 *
 * gatus.io/docs is a client-rendered SPA and returns an empty body to a
 * fetcher — it is NOT a usable reference for this package. Every route below
 * is quoted from the upstream Go SOURCE, `github.com/TwiN/gatus`, tag
 * `v5.36.0`, file `api/api.go`, `createRouter`:
 *
 * ```go
 * apiRouter := app.Group("/api")
 * ////////////////////////
 * // UNPROTECTED ROUTES //
 * ////////////////////////
 * unprotectedAPIRouter := apiRouter.Group("/")
 * unprotectedAPIRouter.Get("/v1/config", ConfigHandler{...}.GetConfig)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/health/badge.svg", HealthBadge)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/health/badge.shields", HealthBadgeShields)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/uptimes/:duration", UptimeRaw)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/uptimes/:duration/badge.svg", UptimeBadge)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/response-times/:duration", ResponseTimeRaw)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/response-times/:duration/badge.svg", ResponseTimeBadge(cfg))
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/response-times/:duration/chart.svg", ResponseTimeChart)
 * unprotectedAPIRouter.Get("/v1/endpoints/:key/response-times/:duration/history", ResponseTimeHistory)
 * // This endpoint requires authz with bearer token, so technically it is protected
 * unprotectedAPIRouter.Post("/v1/endpoints/:key/external", CreateExternalEndpointResult(cfg))
 * ...
 * // Health endpoint
 * healthHandler := health.Handler().WithJSON(true)
 * app.Get("/health", func(c *fiber.Ctx) error { ... })
 * ...
 * //////////////////////
 * // PROTECTED ROUTES //
 * //////////////////////
 * // ORDER IS IMPORTANT: all routes applied AFTER the security middleware require authn
 * protectedAPIRouter := apiRouter.Group("/")
 * if cfg.Security != nil {
 *     cfg.Security.RegisterHandlers(app)
 *     cfg.Security.ApplySecurityMiddleware(protectedAPIRouter)
 * }
 * protectedAPIRouter.Get("/v1/endpoints/statuses", EndpointStatuses(cfg))
 * protectedAPIRouter.Get("/v1/endpoints/:key/statuses", EndpointStatus(cfg))
 * protectedAPIRouter.Get("/v1/suites/statuses", SuiteStatuses(cfg))
 * protectedAPIRouter.Get("/v1/suites/:key/statuses", SuiteStatus(cfg))
 * ```
 *
 * Two structural facts fall directly out of that source, and both are load-
 * bearing for the rest of this package:
 *
 * 1. **The security middleware is only ever attached when `cfg.Security != nil`.**
 *    An installation with no `security:` block in its YAML applies NO auth
 *    middleware to `protectedAPIRouter` at all — "protected" is the group's
 *    NAME, not a guarantee. Every route on it is then reachable with no
 *    credential whatsoever, which is exactly what the fleet-observability
 *    design's verdict table records: *"The API is fully open when no
 *    `security` block is configured."*
 * 2. **The unprotected group needs no credential ever, by construction** —
 *    it sits above the `if cfg.Security != nil` branch entirely, so it is
 *    unreachable-to-secure even if an operator wanted to lock it down. The
 *    per-endpoint uptime/response-time reads this adapter falls back to in
 *    OIDC mode live here, which is WHY that fallback exists at all.
 *
 * ## The auth branch this adapter exists to implement
 *
 * `GET /api/v1/config` (unprotected) answers `{oidc, authenticated}` —
 * `api/config.go`'s `ConfigHandler.GetConfig`:
 *
 * ```go
 * hasOIDC := false
 * isAuthenticated := true // Default to true if no security config is set
 * if handler.securityConfig != nil {
 *     hasOIDC = handler.securityConfig.OIDC != nil
 *     isAuthenticated = handler.securityConfig.IsAuthenticated(c)
 * }
 * ```
 *
 * `security/config.go`'s `IsAuthenticated` only ever returns non-false when a
 * `g8` session gate exists, and that gate is built ONLY in the OIDC branch of
 * `ApplySecurityMiddleware` — Basic auth never sets it. So `authenticated` is
 * not "is this request allowed in" (Basic auth is checked per-request by
 * fiber's `basicauth` middleware, independent of this field); it only ever
 * reflects whether an OIDC session cookie was already valid on THIS
 * unauthenticated probe request, which for a server-to-server reader sending
 * no cookies is always `false`. The three reachable states are therefore:
 *
 * ```text
 * {oidc:false, authenticated:true}   no security block at all — fully open
 * {oidc:false, authenticated:false}  Basic auth configured
 * {oidc:true,  authenticated:false}  OIDC configured (a bearer/basic reader
 *                                    can never present a session cookie, so
 *                                    this is the only value `oidc:true` can
 *                                    practically take here)
 * ```
 *
 * `oidc === true` is therefore the whole branch: it means `security.oidc` is
 * present in the operator's YAML, `security/oidc.go` proves OIDC has no
 * server-to-server bearer path at all (session cookie only, minted by
 * `POST /authorization-code/callback` after a browser redirect through the
 * identity provider), and the adapter must not even attempt
 * `/api/v1/endpoints/statuses` — it degrades to the two unprotected
 * per-endpoint routes below, against endpoint keys the caller already knows
 * (the `external_resources` rows the operator registered).
 *
 * Basic auth (`security/config.go`'s other branch) is `fiber`'s
 * `basicauth.New` middleware — ordinary `Authorization: Basic
 * base64(username:password)`, checked per request, ANY username/password
 * accepted when the operator omitted `password-bcrypt-base64` from their YAML
 * (`Authorizer` returns `true` unconditionally in that case) and otherwise
 * bcrypt-compared. That is machine-consumable, so `oidc === false` always
 * means "attempt the bulk statuses read, sending Basic auth if a credential
 * is configured" — harmless to send even against a genuinely open server,
 * since no middleware is registered to look at it there.
 *
 * ## Only GET, and there is no login exchange at all
 *
 * Unlike Beszel (which needs one `POST` to exchange a login for a token),
 * Gatus's Basic auth carries the credential in a header on every request —
 * there is no token to mint and no session to establish. **Every request this
 * adapter can possibly make is a `GET`.** `test/boundary.test.ts` asserts
 * that directly rather than allowing an exception list the way Beszel's login
 * `POST` requires one.
 */
import { GatusAdapterError } from "./errors.ts";

/** Fully unauthenticated, sits above any `security` middleware. **api.go** */
export const GATUS_CONFIG_PATH = "/api/v1/config";

/** Not under `/api` at all — Gatus's own process liveness. **api.go** */
export const GATUS_HEALTH_PATH = "/health";

/**
 * Behind `security` when configured, open otherwise (see the module doc).
 * **api.go**: `protectedAPIRouter.Get("/v1/endpoints/statuses", ...)`.
 */
export const GATUS_ENDPOINT_STATUSES_PATH = "/api/v1/endpoints/statuses";

/** The four duration buckets Gatus accepts. **api/raw.go**'s `switch`. */
export const GATUS_UPTIME_DURATIONS = ["30d", "7d", "24h", "1h"] as const;
export type GatusUptimeDuration = (typeof GATUS_UPTIME_DURATIONS)[number];

/**
 * `GET /api/v1/endpoints/:key/uptimes/:duration` — always unauthenticated,
 * even against an OIDC- or Basic-secured Gatus. Source: `api.go`, `api/raw.go`.
 * Response is `text/plain`, a bare `%f` fraction (0..1), NOT a percentage.
 */
export function gatusEndpointUptimePath(
  key: string,
  duration: GatusUptimeDuration,
): string {
  return `/api/v1/endpoints/${encodeURIComponent(key)}/uptimes/${duration}`;
}

/**
 * `GET /api/v1/endpoints/:key/response-times/:duration` — always
 * unauthenticated. Source: `api.go`, `api/raw.go`. Response is `text/plain`,
 * a bare `%d` in MILLISECONDS (`storage/store/store.go`'s own doc comment on
 * `GetAverageResponseTimeByKey`).
 */
export function gatusEndpointResponseTimePath(
  key: string,
  duration: GatusUptimeDuration,
): string {
  return `/api/v1/endpoints/${encodeURIComponent(key)}/response-times/${duration}`;
}

/**
 * Recognizes any path this adapter is allowed to have built, dynamic
 * segments included — `GATUS_ALLOWED_PATHS` cannot be a closed literal list
 * the way Beszel's is, because two of the four routes carry an
 * operator-chosen endpoint key. `test/boundary.test.ts` asserts every
 * recorded request URL matches one of these.
 */
export const GATUS_ALLOWED_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/v1\/config$/,
  /^\/health$/,
  /^\/api\/v1\/endpoints\/statuses$/,
  /^\/api\/v1\/endpoints\/[^/]+\/uptimes\/(30d|7d|24h|1h)$/,
  /^\/api\/v1\/endpoints\/[^/]+\/response-times\/(30d|7d|24h|1h)$/,
];

export function isGatusAllowedPath(pathname: string): boolean {
  return GATUS_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function assertGatusUptimeDuration(
  value: string,
): asserts value is GatusUptimeDuration {
  if (!(GATUS_UPTIME_DURATIONS as readonly string[]).includes(value)) {
    throw new GatusAdapterError(
      "invalid_request",
      `Gatus duration must be one of ${GATUS_UPTIME_DURATIONS.join(", ")}`,
      { duration: value },
    );
  }
}
