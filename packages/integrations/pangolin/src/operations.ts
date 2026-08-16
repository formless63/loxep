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
 * ## Read-only through M1/M2, tier-1 writes from M4
 *
 * M1/M2 shipped no write verb of any kind. M4 (`loxep-acj.4`) adds exactly
 * four — the tier-1 set the Pangolin chain design names, plus the
 * disable/enable verb the retirement half of `add-then-retire` needs at the
 * adapter level (the ORCHESTRATION of retirement stays gated to a later
 * milestone; see `adapter.ts`'s module doc) — and not one path more.
 * {@link PANGOLIN_ALLOWED_WRITE_SHAPES} now names exactly those four; every
 * other path stays GET-only, structurally, the same way Tailscale's single
 * OAuth-token-exchange exception is the ONLY carve-out in that adapter.
 * `test/boundary.test.ts` asserts the traffic never exceeds this exact set
 * and that DELETE is never possible — dockhand's forbidden-verbs shape,
 * applied here.
 *
 * ## THE VERB CONVENTION IS INVERTED — read this before touching a method below
 *
 * `PUT` creates. `POST` updates. That is backwards from the usual REST
 * convention, and the design document calls it "the single most likely
 * source of a wrong-verb bug in this adapter." `createResource`,
 * `addTarget`, and `createRule` are all `PUT`. `updateRuleEnabled` — the
 * only update this milestone ships — is `POST`. There is still no `DELETE`
 * anywhere in this file, and there never will be one: retirement is
 * `enabled: false`, not deletion (the design's verdict 3).
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

/** `PUT` — create. Canonical (`/resource/...`), matching every read path above. */
export function pangolinCreateResourcePath(orgId: string): string {
  return `${pangolinOrgPath(orgId)}/resource`;
}

/** `PUT` — create. */
export function pangolinCreateTargetPath(resourceId: string): string {
  return `${pangolinResourcePath(resourceId)}/target`;
}

/** `PUT` — create. */
export function pangolinCreateRulePath(resourceId: string): string {
  return `${pangolinResourcePath(resourceId)}/rule`;
}

/**
 * `POST` — update. The one member of {@link PANGOLIN_ALLOWED_WRITE_SHAPES}
 * that is not a create. Singular `/rule/{ruleId}`, NOT `/rules/{ruleId}` —
 * verified against the endpoint table's `POST /resource/{resourceId}/rule/{ruleId}`.
 */
export function pangolinRulePath(resourceId: string, ruleId: string): string {
  return `${pangolinResourcePath(resourceId)}/rule/${encodeURIComponent(ruleId)}`;
}

export function pangolinDomainsPath(orgId: string): string {
  return `${pangolinOrgPath(orgId)}/domains`;
}

export function pangolinDomainDnsRecordsPath(orgId: string, domainId: string): string {
  return `${pangolinOrgPath(orgId)}/domain/${encodeURIComponent(domainId)}/dns-records`;
}

/**
 * The path prefixes this adapter may ever request, GET or otherwise. Every
 * write path this milestone adds falls under `/org/` (the org-scoped
 * resource create) or `/resource/` (target/rule create, rule-enabled
 * update) — both already listed, so no prefix changes for M4.
 */
export const PANGOLIN_ALLOWED_PATH_PREFIXES = [
  `${PANGOLIN_API_PREFIX}/orgs`,
  `${PANGOLIN_API_PREFIX}/org/`,
  `${PANGOLIN_API_PREFIX}/site/`,
  `${PANGOLIN_API_PREFIX}/resource/`,
] as const;

/**
 * One non-GET write SHAPE this adapter may issue. A literal prefix list (the
 * pattern every sibling adapter's `_ALLOWED_NON_GET_*` constant uses) does
 * not fit here: `orgId`/`resourceId`/`ruleId` are path SEGMENTS embedded
 * before a fixed keyword (`/org/{orgId}/resource`), not a suffix appended
 * after a fixed prefix the way Dockhand's `/api/environments/{id}` is. Each
 * shape is therefore a `{method, pattern}` pair rather than a string, and
 * {@link PANGOLIN_ALLOWED_WRITE_SHAPES} is the enumerable, testable list —
 * exactly four entries, matching the four write methods this milestone
 * exports and no more.
 */
export interface PangolinWriteShape {
  method: "PUT" | "POST";
  /** Loxep's own operation label, matching the adapter method that issues it. */
  label: string;
  pattern: RegExp;
}

export const PANGOLIN_ALLOWED_WRITE_SHAPES: readonly PangolinWriteShape[] = [
  {
    method: "PUT",
    label: "resource.create",
    pattern: /^\/v1\/org\/[^/]+\/resource$/,
  },
  {
    method: "PUT",
    label: "target.create",
    pattern: /^\/v1\/resource\/[^/]+\/target$/,
  },
  {
    method: "PUT",
    label: "rule.create",
    pattern: /^\/v1\/resource\/[^/]+\/rule$/,
  },
  {
    // The only update this milestone ships, and the only POST among the
    // four — the inverted-verb-convention warning made concrete.
    method: "POST",
    label: "rule.update_enabled",
    pattern: /^\/v1\/resource\/[^/]+\/rule\/[^/]+$/,
  },
] as const;

/** `true` for exactly the four shapes above; `false` for every DELETE, always. */
export function isAllowedPangolinWrite(method: string, path: string): boolean {
  return PANGOLIN_ALLOWED_WRITE_SHAPES.some(
    (shape) => shape.method === method && shape.pattern.test(path),
  );
}
