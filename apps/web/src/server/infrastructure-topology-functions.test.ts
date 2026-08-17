/**
 * Unit tests for the pure `buildInfrastructureTopology` assembler
 * (`loxep-m4m`, UI overhaul 2026 design §4). No database, no server function
 * invocation — same "extract the pure function, test it directly" shape
 * `infrastructure-functions.test.ts`'s own module doc describes. Run with
 * `bun test apps/web/src/server/infrastructure-topology-functions.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildInfrastructureTopology,
  TOPOLOGY_EDGE_KINDS,
  type BuildTopologyInput
} from './infrastructure-topology-functions';

const READ_AT = new Date('2026-08-17T12:00:00.000Z');

function baseInput(overrides: Partial<BuildTopologyInput> = {}): BuildTopologyInput {
  return {
    hostingTargets: [],
    hostAddresses: [],
    managedDomains: [],
    proxyResources: [],
    connections: [],
    externalResources: [],
    resourceLinks: [],
    health: [],
    readAt: READ_AT,
    ...overrides
  };
}

describe('buildInfrastructureTopology — node assembly', () => {
  test("assembles one node per kind and stamps Loxep's own read clock", () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        connections: [
          { id: 'conn-1', provider: 'cloudflare', name: 'Cloudflare account', status: 'active' }
        ],
        managedDomains: [
          { id: 'domain-1', name: 'example.com', dnsConnectionId: 'conn-1', apexTargetId: null }
        ],
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: 'hetzner',
            region: 'fsn1',
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ]
      })
    );

    expect(dto.readAt).toBe(READ_AT.toISOString());
    expect(dto.nodes.map((n) => n.id).sort()).toEqual(
      ['connection:conn-1', 'domain:domain-1', 'hosting_target:target-1'].sort()
    );
    const target = dto.nodes.find((n) => n.id === 'hosting_target:target-1')!;
    expect(target.href).toEqual({
      to: '/infrastructure/fleet/$name',
      params: { name: 'origin-1' }
    });
    expect(target.meta).toEqual({ provider: 'hetzner', region: 'fsn1' });
  });

  test('a hosting_target node carries WAN-first badge order from host_addresses', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ],
        hostAddresses: [
          { hostingTargetId: 'target-1', kind: 'tailnet' },
          { hostingTargetId: 'target-1', kind: 'wan' },
          { hostingTargetId: 'target-1', kind: 'lan' }
        ]
      })
    );
    const target = dto.nodes.find((n) => n.id === 'hosting_target:target-1')!;
    expect(target.badges).toEqual(['WAN', 'LAN', 'Tailnet']);
  });

  test('node health status comes from the matching subjectType/subjectId health row; absent is null, never a false ok', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          },
          {
            id: 'target-2',
            name: 'origin-2',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ],
        health: [{ subjectType: 'hosting_target', subjectId: 'target-1', status: 'failing' }]
      })
    );
    expect(dto.nodes.find((n) => n.id === 'hosting_target:target-1')!.status).toBe('failing');
    expect(dto.nodes.find((n) => n.id === 'hosting_target:target-2')!.status).toBeNull();
  });

  test('a proxy_resource node names its full domain (subdomain.domain) and deep-links to the owning domain page', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        managedDomains: [
          { id: 'domain-1', name: 'example.com', dnsConnectionId: 'conn-1', apexTargetId: null }
        ],
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ],
        proxyResources: [
          {
            id: 'resource-1',
            domainId: 'domain-1',
            hostingTargetId: 'target-1',
            subdomain: 'app',
            mode: 'http'
          }
        ]
      })
    );
    const resource = dto.nodes.find((n) => n.id === 'proxy_resource:resource-1')!;
    expect(resource.name).toBe('app.example.com');
    expect(resource.href).toEqual({
      to: '/infrastructure/domains/$name',
      params: { name: 'example.com' }
    });
  });

  test('a tool node falls back to "Provider externalType" when it has no title', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ],
        externalResources: [
          {
            id: 'resource-1',
            provider: 'beszel',
            externalType: 'system',
            title: null,
            connectionId: null
          }
        ],
        resourceLinks: [
          {
            externalResourceId: 'resource-1',
            resourceId: 'target-1',
            resourceType: 'hosting_target'
          }
        ]
      })
    );
    const tool = dto.nodes.find((n) => n.id === 'tool:resource-1')!;
    expect(tool.name).toBe('Beszel system');
    expect(tool.href).toBeNull(); // no connectionId -> no estate page to link to
  });
});

describe('buildInfrastructureTopology — edge assembly, one per design table row', () => {
  const fixture = baseInput({
    connections: [
      { id: 'conn-cf', provider: 'cloudflare', name: 'Cloudflare account', status: 'active' },
      { id: 'conn-pangolin', provider: 'pangolin', name: 'Pangolin instance', status: 'active' }
    ],
    managedDomains: [
      {
        id: 'domain-1',
        name: 'example.com',
        dnsConnectionId: 'conn-cf',
        apexTargetId: 'target-origin'
      }
    ],
    hostingTargets: [
      {
        id: 'target-origin',
        name: 'origin-1',
        provider: 'hetzner',
        region: 'fsn1',
        frontedByTargetId: 'target-edge',
        proxyConnectionId: 'conn-pangolin'
      },
      {
        id: 'target-edge',
        name: 'edge-1',
        provider: 'hetzner',
        region: 'fsn1',
        frontedByTargetId: null,
        proxyConnectionId: null
      }
    ],
    proxyResources: [
      {
        id: 'resource-1',
        domainId: 'domain-1',
        hostingTargetId: 'target-origin',
        subdomain: 'app',
        mode: 'http'
      }
    ],
    externalResources: [
      {
        id: 'ext-1',
        provider: 'beszel',
        externalType: 'system',
        title: 'web-1',
        connectionId: null
      }
    ],
    resourceLinks: [
      { externalResourceId: 'ext-1', resourceId: 'target-origin', resourceType: 'hosting_target' }
    ]
  });

  test('emits exactly one edge of every kind the fixture exercises, each with a sentence', () => {
    const dto = buildInfrastructureTopology(fixture);
    const kindsPresent = new Set(dto.edges.map((e) => e.kind));
    expect([...kindsPresent].sort()).toEqual([...TOPOLOGY_EDGE_KINDS].sort());
    for (const edge of dto.edges) {
      expect(edge.sentence.length).toBeGreaterThan(0);
    }
  });

  test('fronted_by connects the fronted target to its fronting node', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'fronted_by')!;
    expect(edge.sourceNodeId).toBe('hosting_target:target-origin');
    expect(edge.targetNodeId).toBe('hosting_target:target-edge');
    expect(edge.sentence).toBe('Traffic for origin-1 arrives through edge-1 first.');
  });

  test('apex_points_at connects the domain to its apex target', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'apex_points_at')!;
    expect(edge.sourceNodeId).toBe('domain:domain-1');
    expect(edge.targetNodeId).toBe('hosting_target:target-origin');
    expect(edge.sentence).toBe("example.com's apex record points at origin-1.");
  });

  test('routes_to connects the proxy resource to its hosting target, sentence uses the full domain', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'routes_to')!;
    expect(edge.sourceNodeId).toBe('proxy_resource:resource-1');
    expect(edge.targetNodeId).toBe('hosting_target:target-origin');
    expect(edge.sentence).toBe('app.example.com is proxied through Pangolin to origin-1.');
  });

  test('zone_hosted_at connects the domain to its DNS connection', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'zone_hosted_at')!;
    expect(edge.sourceNodeId).toBe('domain:domain-1');
    expect(edge.targetNodeId).toBe('connection:conn-cf');
    expect(edge.sentence).toBe("example.com's DNS zone lives at this Cloudflare connection.");
  });

  test('proxied_via connects the hosting target to its proxy connection', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'proxied_via')!;
    expect(edge.sourceNodeId).toBe('hosting_target:target-origin');
    expect(edge.targetNodeId).toBe('connection:conn-pangolin');
    expect(edge.sentence).toBe(
      'origin-1 publishes its resources through this Pangolin connection.'
    );
  });

  test('watched_by connects the companion tool to the hosting target it watches', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'watched_by')!;
    expect(edge.sourceNodeId).toBe('tool:ext-1');
    expect(edge.targetNodeId).toBe('hosting_target:target-origin');
    expect(edge.sentence).toBe(
      'web-1 is linked to origin-1 — Loxep records it as a companion, and probes its health.'
    );
  });

  test('a duplicate resource_links row for the same (tool, target) pair does not double the watched_by edge', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        hostingTargets: [
          {
            id: 'target-1',
            name: 'origin-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ],
        externalResources: [
          {
            id: 'ext-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-1',
            connectionId: null
          }
        ],
        resourceLinks: [
          { externalResourceId: 'ext-1', resourceId: 'target-1', resourceType: 'hosting_target' },
          { externalResourceId: 'ext-1', resourceId: 'target-1', resourceType: 'hosting_target' }
        ]
      })
    );
    expect(dto.edges.filter((e) => e.kind === 'watched_by')).toHaveLength(1);
  });

  test('a dangling reference (edge target not present as a node) is silently skipped, never a broken edge', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        managedDomains: [
          // apex_target_id points at a hosting target that does not exist
          // in this fetch (e.g. decommissioned since) — must not crash or
          // emit an edge to a nonexistent node.
          {
            id: 'domain-1',
            name: 'example.com',
            dnsConnectionId: 'conn-missing',
            apexTargetId: 'target-missing'
          }
        ]
      })
    );
    expect(dto.edges).toEqual([]);
    expect(dto.nodes.map((n) => n.id)).toEqual(['domain:domain-1']);
  });

  test('an isolated node with no edges still renders as a node', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        hostingTargets: [
          {
            id: 'target-lonely',
            name: 'lonely-1',
            provider: null,
            region: null,
            frontedByTargetId: null,
            proxyConnectionId: null
          }
        ]
      })
    );
    expect(dto.nodes.map((n) => n.id)).toEqual(['hosting_target:target-lonely']);
    expect(dto.edges).toEqual([]);
  });
});
