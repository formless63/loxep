/**
 * Rule G3's falsifiable witness: every edge kind {@link buildInfrastructureTopology}
 * can emit has exactly one registered, non-empty sentence with the real
 * names actually substituted in. Run with Bun's test runner: `bun test
 * apps/web/src/features/infrastructure/topology/sentence-registry.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { TOPOLOGY_EDGE_KINDS } from '@/server/infrastructure-topology-functions';
import {
  buildEdgeSentence,
  EDGE_SENTENCE_REGISTRY,
  type EdgeSentenceParamsByKind
} from './sentence-registry';

const FIXTURE_PARAMS: EdgeSentenceParamsByKind = {
  fronted_by: { frontedName: 'origin-1', frontingName: 'edge-1' },
  apex_points_at: { domainName: 'example.com', targetName: 'origin-1' },
  routes_to: { fullDomain: 'app.example.com', targetName: 'origin-1' },
  zone_hosted_at: { domainName: 'example.com', providerLabel: 'Cloudflare' },
  proxied_via: { targetName: 'origin-1', providerLabel: 'Pangolin' },
  watched_by: { toolName: 'Beszel system', targetName: 'origin-1' }
};

describe('EDGE_SENTENCE_REGISTRY totality', () => {
  test('every declared edge kind has a registry entry', () => {
    for (const kind of TOPOLOGY_EDGE_KINDS) {
      expect(typeof EDGE_SENTENCE_REGISTRY[kind]).toBe('function');
    }
  });

  test('the registry has no keys beyond the declared edge kinds', () => {
    expect(Object.keys(EDGE_SENTENCE_REGISTRY).toSorted()).toEqual(TOPOLOGY_EDGE_KINDS.toSorted());
  });

  test('every edge kind renders a non-empty sentence with real names substituted', () => {
    for (const kind of TOPOLOGY_EDGE_KINDS) {
      const params = FIXTURE_PARAMS[kind];
      const sentence = buildEdgeSentence(kind, params);
      expect(sentence.length).toBeGreaterThan(0);
      // Every named value in this kind's params must appear verbatim in the
      // rendered sentence — the "real names substituted" half of rule G3.
      for (const value of Object.values(params)) {
        expect(sentence).toContain(value);
      }
    }
  });
});

describe('individual sentences match the design table verbatim (§4)', () => {
  test('fronted_by', () => {
    expect(buildEdgeSentence('fronted_by', FIXTURE_PARAMS.fronted_by)).toBe(
      'Traffic for origin-1 arrives through edge-1 first.'
    );
  });

  test('apex_points_at', () => {
    expect(buildEdgeSentence('apex_points_at', FIXTURE_PARAMS.apex_points_at)).toBe(
      "example.com's apex record points at origin-1."
    );
  });

  test('routes_to', () => {
    expect(buildEdgeSentence('routes_to', FIXTURE_PARAMS.routes_to)).toBe(
      'app.example.com is proxied through Pangolin to origin-1.'
    );
  });

  test('zone_hosted_at', () => {
    expect(buildEdgeSentence('zone_hosted_at', FIXTURE_PARAMS.zone_hosted_at)).toBe(
      "example.com's DNS zone lives at this Cloudflare connection."
    );
  });

  test('proxied_via', () => {
    expect(buildEdgeSentence('proxied_via', FIXTURE_PARAMS.proxied_via)).toBe(
      'origin-1 publishes its resources through this Pangolin connection.'
    );
  });

  test('watched_by', () => {
    expect(buildEdgeSentence('watched_by', FIXTURE_PARAMS.watched_by)).toBe(
      'Beszel system is linked to origin-1 — Loxep records it as a companion, and probes its health.'
    );
  });
});
