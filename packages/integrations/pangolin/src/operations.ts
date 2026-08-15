/**
 * Every Pangolin path this adapter may build, in one place, so the boundary
 * test can enumerate the surface and prove what is absent — the same
 * one-generic-call-function-plus-one-operations-map shape the design
 * prescribes for this adapter (Purelymail's structure, not Cloudflare's),
 * because Pangolin publishes a fetchable OpenAPI document at
 * `/v1/openapi.json` and the design's own warning is to extract the schema
 * rather than transcribe method names.
 *
 * ## Verification trail, 2026-08-15
 *
 * Every literal path below is read directly from
 * `fosrl/pangolin@main`'s `server/routers/integration.ts` (the Express
 * router mounted at `/v1` by the standalone Integration API server,
 * `server/integrationApiServer.ts`), not transcribed from documentation —
 * stronger grounding than the design document's own citations, which relied
 * on `docs.pangolin.net` prose. Two corrections against that design
 * document, recorded here and folded back into it:
 *
 * 1. **The canonical resource path is `/resource`, with `/public-resource`
 *    as a registered alias** (`authenticated.get(["/resource/:resourceId",
 *    "/public-resource/:resourceId"], ...)`), not the other way around. The
 *    design's endpoint table shows only the `/public-resource` form. This
 *    adapter uses `/resource` as primary.
 * 2. **List responses nest their array under a named key plus a
 *    `pagination` object** — `GET /orgs` answers
 *    `data: {orgs: [...], pagination: {...}}`, `GET /org/:orgId/sites`
 *    answers `data: {sites: [...], pagination: {...}}`, and so on for
 *    `resources`/`targets`/`rules`/`domains`. The design's read-surface list
 *    does not spell this out. `GET .../dns-records` is the one exception —
 *    its `data` is a bare array, matching `server/routers/domain/
 *    getDNSRecords.ts`'s `Awaited<ReturnType<typeof query>>` return shape.
 *
 * `GET /orgs` (`listOrgs`) is gated by `verifyApiKeyIsRoot` in source —
 * design's own auth table already says root keys are self-hosted-only and
 * cross-org; an org-scoped key answers this route with an `auth`-shaped
 * rejection, which is expected and not a bug to work around.
 *
 * ## Read-only by construction, structurally
 *
 * M1 ships **no write verb of any kind** — not configuration, not policy:
 * the operation union this milestone's port would need does not exist yet,
 * and this adapter's own exported surface has no member named after a write
 * verb. {@link PANGOLIN_ALLOWED_NON_GET_PATHS} is empty on purpose (compare
 * Tailscale's single OAuth-token-exchange exception): Pangolin's bearer
 * token needs no separate exchange, so there is no exception to carve out.
 * `test/boundary.test.ts` asserts every request this adapter makes is a
 * `GET`.
 */

/**
 * The Integration API server's own internal mount prefix, verified from
 * `server/integrationApiServer.ts` (`const prefix = "/v1";
 * apiServer.use(prefix, authenticated)`). **This is the path the Express
 * app itself expects — it is NOT proof that any given self-hosted instance
 * exposes it at this same path publicly.** The standalone server listens on
 * its own port (`config.server.integration_port`, conventionally `3003`)
 * and is never on the same origin as the dashboard by default; an operator
 * must add their own reverse-proxy route (a dedicated subdomain, per
 * Pangolin's own self-host documentation) to reach it at all. See
 * `adapter.ts`'s module doc for the live reachability finding against the
 * owner's instance and why the connecting guide must warn about this
 * explicitly.
 */
export const PANGOLIN_API_PREFIX = "/v1";

export function pangolinOrgsPath(): string {
  return `${PANGOLIN_API_PREFIX}/orgs`;
}

export function pangolinOrgPath(orgId: string): string {
  return `${PANGOLIN_API_PREFIX}/org/${encodeURIComponent(orgId)}`;
}

export function pangolinSitesPath(orgId: string): string {
  return `${pangolinOrgPath(orgId)}/sites`;
}

/** By numeric site id — org-independent in the path (`verifyApiKeySiteAccess` resolves org internally). */
export function pangolinSitePath(siteId: string): string {
  return `${PANGOLIN_API_PREFIX}/site/${encodeURIComponent(siteId)}`;
}

/** By org-scoped `niceId` — the fallback join key when no numeric id is known yet. */
export function pangolinOrgSitePath(orgId: string, niceId: string): string {
  return `${pangolinOrgPath(orgId)}/site/${encodeURIComponent(niceId)}`;
}

export function pangolinResourcesPath(orgId: string): string {
  return `${pangolinOrgPath(orgId)}/resources`;
}

export function pangolinResourcePath(resourceId: string): string {
  return `${PANGOLIN_API_PREFIX}/resource/${encodeURIComponent(resourceId)}`;
}

export function pangolinTargetsPath(resourceId: string): string {
  return `${pangolinResourcePath(resourceId)}/targets`;
}

export function pangolinRulesPath(resourceId: string): string {
  return `${pangolinResourcePath(resourceId)}/rules`;
}

export function pangolinDomainsPath(orgId: string): string {
  return `${pangolinOrgPath(orgId)}/domains`;
}

export function pangolinDomainDnsRecordsPath(orgId: string, domainId: string): string {
  return `${pangolinOrgPath(orgId)}/domain/${encodeURIComponent(domainId)}/dns-records`;
}

/** The path prefixes this adapter may ever request. Every one is GET-only. */
export const PANGOLIN_ALLOWED_PATH_PREFIXES = [
  `${PANGOLIN_API_PREFIX}/orgs`,
  `${PANGOLIN_API_PREFIX}/org/`,
  `${PANGOLIN_API_PREFIX}/site/`,
  `${PANGOLIN_API_PREFIX}/resource/`,
] as const;

/**
 * Deliberately empty. M1 issues no write verb anywhere, so there is no path
 * this adapter may reach with a method other than `GET` — unlike Tailscale's
 * single OAuth-exchange exception, Pangolin's bearer token needs no
 * exchange call.
 */
export const PANGOLIN_ALLOWED_NON_GET_PATHS: readonly string[] = [];
