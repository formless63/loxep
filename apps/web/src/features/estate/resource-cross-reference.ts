/**
 * The shared "is this live-read object already discovered, and is it
 * already linked to a hosting target" cross-reference (loxep-47o.6/
 * loxep-47o.7) — the SAME shape `tailscale-estate-functions.ts`,
 * `beszel-estate-functions.ts`, and `termix-estate-functions.ts` each build
 * against `external_resources`/`resource_links`, extracted once so the
 * mapping logic is tested in one place instead of three (Estate Browsers
 * Design §2.2's "cross-reference column" rule, applied identically by every
 * fleet-adapter estate page that discovers by node/system/host id).
 *
 * Every caller does the SAME three-step read: (1) every `external_resources`
 * row for this provider+type+connection, (2) every `resource_links` row of
 * type `hosting_target` pointing at one of those, (3) the linked hosting
 * targets' names. This module is the PURE final step — turning those three
 * already-fetched maps into one row's cross-reference — so it takes no
 * database dependency of its own and is trivially unit-testable.
 */

export interface EstateCrossReferenceResult {
  /** `external_resources.id` for this live object, or `null` when the last discovery sweep has never seen it yet. */
  externalResourceId: string | null;
  /** Non-null exactly when a `resource_links` row already attaches this object to a hosting target. */
  linked: { hostingTargetId: string; hostingTargetName: string } | null;
}

export interface EstateDiscoveredResource {
  id: string;
}

/**
 * @param externalId The live-read object's own stable id (a tailnet node id, a Beszel system id, a Termix host id) — NEVER a name, which no provider here contracts as unique.
 * @param resourceByExternalId Every `external_resources` row for this provider+type+connection, keyed by its own `externalId`.
 * @param linkedHostingTargetIdByExternalResourceId Every `resource_links` (type `hosting_target`) row's target id, keyed by `externalResourceId`.
 * @param hostingTargetNameById Every linked hosting target's name, keyed by id.
 */
export function estateResourceCrossReference(
  externalId: string,
  resourceByExternalId: ReadonlyMap<string, EstateDiscoveredResource>,
  linkedHostingTargetIdByExternalResourceId: ReadonlyMap<string, string>,
  hostingTargetNameById: ReadonlyMap<string, string>
): EstateCrossReferenceResult {
  const resource = resourceByExternalId.get(externalId);
  if (resource === undefined) {
    return { externalResourceId: null, linked: null };
  }
  const hostingTargetId = linkedHostingTargetIdByExternalResourceId.get(resource.id);
  if (hostingTargetId === undefined) {
    return { externalResourceId: resource.id, linked: null };
  }
  return {
    externalResourceId: resource.id,
    linked: {
      hostingTargetId,
      hostingTargetName: hostingTargetNameById.get(hostingTargetId) ?? hostingTargetId
    }
  };
}
