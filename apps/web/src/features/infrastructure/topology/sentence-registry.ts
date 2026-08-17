/**
 * The edge tooltip sentence registry (UI overhaul 2026 design §4, rule G3,
 * `loxep-m4m`). Design's own table, verbatim:
 *
 * ```text
 * fronted by       "Traffic for A arrives through B first."
 * apex points at   "domain's apex record points at target."
 * routes to        "sub.domain is proxied through Pangolin to target."
 * zone hosted at   "domain's DNS zone lives at this provider connection."
 * proxied via      "target publishes its resources through this provider connection."
 * watched by       "tool is linked to target - Loxep records it as a
 *                   companion, and probes its health."
 * ```
 *
 * ## Why an edge without a registered sentence structurally cannot render
 *
 * {@link EDGE_SENTENCE_REGISTRY}'s type is a MAPPED TYPE over the full
 * {@link TopologyEdgeKind} union — `{ [K in TopologyEdgeKind]: ... }` — not a
 * `Partial<Record<...>>` or a `Record<string, ...>`. TypeScript refuses to
 * compile this file if a member of the union is missing an entry, and
 * refuses to compile it if an entry exists for a kind outside the union.
 * `buildInfrastructureTopology` (`@/server/infrastructure-topology-
 * functions.ts`) calls {@link buildEdgeSentence} for every single
 * `TopologyEdgeDto` it constructs — there is no code path that appends an
 * edge without going through this registry — so widening
 * `TOPOLOGY_EDGE_KINDS` with a seventh edge kind and forgetting its sentence
 * fails the BUILD, not just a review. `sentence-registry.test.ts` asserts
 * the same thing at runtime, over every kind the pure builder can actually
 * emit, as a second, falsifiable witness.
 */
import type { TopologyEdgeKind } from '@/server/infrastructure-topology-functions';

/** Named substitution parameters per edge kind — each sentence's own "real names substituted" inputs. */
export interface EdgeSentenceParamsByKind {
  fronted_by: { frontedName: string; frontingName: string };
  apex_points_at: { domainName: string; targetName: string };
  routes_to: { fullDomain: string; targetName: string };
  zone_hosted_at: { domainName: string; providerLabel: string };
  proxied_via: { targetName: string; providerLabel: string };
  watched_by: { toolName: string; targetName: string };
}

/** The registry itself — see this file's module doc for why its type makes an unregistered edge kind a compile error. */
export const EDGE_SENTENCE_REGISTRY: {
  [K in TopologyEdgeKind]: (params: EdgeSentenceParamsByKind[K]) => string;
} = {
  fronted_by: ({ frontedName, frontingName }) =>
    `Traffic for ${frontedName} arrives through ${frontingName} first.`,
  apex_points_at: ({ domainName, targetName }) =>
    `${domainName}'s apex record points at ${targetName}.`,
  routes_to: ({ fullDomain, targetName }) =>
    `${fullDomain} is proxied through Pangolin to ${targetName}.`,
  zone_hosted_at: ({ domainName, providerLabel }) =>
    `${domainName}'s DNS zone lives at this ${providerLabel} connection.`,
  proxied_via: ({ targetName, providerLabel }) =>
    `${targetName} publishes its resources through this ${providerLabel} connection.`,
  watched_by: ({ toolName, targetName }) =>
    `${toolName} is linked to ${targetName} — Loxep records it as a companion, and probes its health.`
};

/** The one call site every edge-constructing caller uses — see this file's module doc. */
export function buildEdgeSentence<K extends TopologyEdgeKind>(
  kind: K,
  params: EdgeSentenceParamsByKind[K]
): string {
  return EDGE_SENTENCE_REGISTRY[kind](params);
}
