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
    observedResources: [],
    ignoredTailscaleExternalIds: new Set(),
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
    expect(dto.nodes.map((n) => n.id).toSorted()).toEqual(
      ['connection:conn-1', 'domain:domain-1', 'hosting_target:target-1'].toSorted()
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
          { hostingTargetId: 'target-1', kind: 'tailnet', value: 'fd7a:115c:a1e0::1' },
          { hostingTargetId: 'target-1', kind: 'wan', value: '203.0.113.1' },
          { hostingTargetId: 'target-1', kind: 'lan', value: '10.0.0.1' }
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
        // `loxep-h4v`: a connection, to exercise `observed_via`, and a
        // `host` address that matches `target-edge`'s (NOT `target-origin`,
        // the target it's already `watched_by`-linked to below) — the two
        // targets are deliberately different so this same fixture also
        // exercises `address_match` without tripping its own
        // already-linked-pair suppression.
        connectionId: 'conn-cf',
        metadata: { host: '10.0.0.9' }
      }
    ],
    resourceLinks: [
      { externalResourceId: 'ext-1', resourceId: 'target-origin', resourceType: 'hosting_target' }
    ],
    hostAddresses: [{ hostingTargetId: 'target-edge', kind: 'other', value: '10.0.0.9' }]
  });

  test('emits exactly one edge of every kind the fixture exercises, each with a sentence', () => {
    const dto = buildInfrastructureTopology(fixture);
    const kindsPresent = new Set(dto.edges.map((e) => e.kind));
    expect([...kindsPresent].toSorted()).toEqual(TOPOLOGY_EDGE_KINDS.toSorted());
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

  test('observed_via connects the discovering connection to the tool it discovered', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'observed_via')!;
    expect(edge.sourceNodeId).toBe('connection:conn-cf');
    expect(edge.targetNodeId).toBe('tool:ext-1');
    expect(edge.sentence).toBe("Loxep's Cloudflare sweeps read web-1 through this connection.");
  });

  test('address_match connects the resource to a target sharing its persisted address, distinct from its watched_by target', () => {
    const dto = buildInfrastructureTopology(fixture);
    const edge = dto.edges.find((e) => e.kind === 'address_match')!;
    expect(edge.sourceNodeId).toBe('tool:ext-1');
    expect(edge.targetNodeId).toBe('hosting_target:target-edge');
    expect(edge.matchedAddress).toBe('10.0.0.9');
    expect(edge.matchCount).toBe(1);
    expect(edge.sentence).toBe(
      'web-1 reports 10.0.0.9, which edge-1 also has — possibly the same machine. Link it to confirm.'
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

describe("buildInfrastructureTopology — rule G7's observed layer", () => {
  test('an unlinked external_resources row becomes an observed tool node with no edges', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        observedResources: [
          {
            id: 'obs-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-2',
            connectionId: 'conn-beszel',
            externalId: null,
            url: 'https://beszel.example/systems/web-2',
            metadata: { status: 'up', host: '10.0.0.5', port: '45876' }
          }
        ]
      })
    );
    const node = dto.nodes.find((n) => n.id === 'tool:obs-1');
    expect(node).toBeDefined();
    expect(node!.kind).toBe('tool');
    expect(node!.observed).toBe(true);
    expect(node!.name).toBe('web-2');
    expect(node!.meta['status']).toBe('up');
    expect(node!.meta['host']).toBe('10.0.0.5');
    expect(node!.meta['url']).toBe('https://beszel.example/systems/web-2');
    expect(dto.edges).toEqual([]);
  });

  test('a declared/linked tool node is never marked observed', () => {
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
          { externalResourceId: 'ext-1', resourceId: 'target-1', resourceType: 'hosting_target' }
        ]
      })
    );
    const node = dto.nodes.find((n) => n.id === 'tool:ext-1')!;
    expect(node.observed).toBe(false);
  });

  test('a tailscale observed row whose externalId is in the ignore set is dropped entirely', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        observedResources: [
          {
            id: 'obs-ignored',
            provider: 'tailscale',
            externalType: 'device',
            title: 'laptop',
            connectionId: null,
            externalId: 'node-ignored',
            url: 'https://login.tailscale.com/admin/machines/node-ignored',
            metadata: {}
          },
          {
            id: 'obs-visible',
            provider: 'tailscale',
            externalType: 'device',
            title: 'server',
            connectionId: null,
            externalId: 'node-visible',
            url: 'https://login.tailscale.com/admin/machines/node-visible',
            metadata: {}
          }
        ],
        ignoredTailscaleExternalIds: new Set(['node-ignored'])
      })
    );
    expect(dto.nodes.map((n) => n.id)).toEqual(['tool:obs-visible']);
  });

  test('a non-tailscale observed row is never affected by ignoredTailscaleExternalIds', () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        observedResources: [
          {
            id: 'obs-dockhand',
            provider: 'dockhand',
            externalType: 'environment',
            title: 'docker-host-1',
            connectionId: null,
            externalId: 'env-1',
            url: 'https://dockhand.example/environments/env-1',
            metadata: { host: '10.0.0.9' }
          }
        ],
        // Would only ever match a tailscale row's externalId — irrelevant here.
        ignoredTailscaleExternalIds: new Set(['env-1'])
      })
    );
    expect(dto.nodes.map((n) => n.id)).toEqual(['tool:obs-dockhand']);
  });

  test("an observed node deep-links to the connection's estate page when one is known", () => {
    const dto = buildInfrastructureTopology(
      baseInput({
        observedResources: [
          {
            id: 'obs-1',
            provider: 'gatus',
            externalType: 'endpoint',
            title: null,
            connectionId: 'conn-gatus',
            externalId: null,
            url: 'https://gatus.example/endpoints/1',
            metadata: {}
          }
        ]
      })
    );
    const node = dto.nodes.find((n) => n.id === 'tool:obs-1')!;
    expect(node.href).toEqual({
      to: '/infrastructure/estate/$connectionId',
      params: { connectionId: 'conn-gatus' }
    });
  });
});

describe('buildInfrastructureTopology — rule G7 extension: observed_via and address_match (loxep-h4v)', () => {
  const connections = [
    { id: 'conn-beszel', provider: 'beszel', name: 'Beszel account', status: 'active' }
  ];

  describe('observed_via', () => {
    test('emitted for a LINKED tool node whose external_resources row carries a connection_id', () => {
      const dto = buildInfrastructureTopology(
        baseInput({
          connections,
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
              connectionId: 'conn-beszel'
            }
          ],
          resourceLinks: [
            {
              externalResourceId: 'ext-1',
              resourceId: 'target-1',
              resourceType: 'hosting_target'
            }
          ]
        })
      );
      const edge = dto.edges.find((e) => e.kind === 'observed_via')!;
      expect(edge).toBeDefined();
      expect(edge.sourceNodeId).toBe('connection:conn-beszel');
      expect(edge.targetNodeId).toBe('tool:ext-1');
    });

    test('emitted for an OBSERVED (unlinked) tool node the same way', () => {
      const dto = buildInfrastructureTopology(
        baseInput({
          connections,
          observedResources: [
            {
              id: 'obs-1',
              provider: 'beszel',
              externalType: 'system',
              title: 'web-2',
              connectionId: 'conn-beszel',
              externalId: null,
              url: 'https://beszel.example/systems/web-2',
              metadata: {}
            }
          ]
        })
      );
      const edge = dto.edges.find((e) => e.kind === 'observed_via')!;
      expect(edge).toBeDefined();
      expect(edge.sourceNodeId).toBe('connection:conn-beszel');
      expect(edge.targetNodeId).toBe('tool:obs-1');
    });

    test('dropped, never a dangling edge, when connection_id is set but no matching connection is in the node set', () => {
      const dto = buildInfrastructureTopology(
        baseInput({
          // No `connections` at all — `conn-missing` resolves to nothing.
          observedResources: [
            {
              id: 'obs-1',
              provider: 'beszel',
              externalType: 'system',
              title: 'web-2',
              connectionId: 'conn-missing',
              externalId: null,
              url: 'https://beszel.example/systems/web-2',
              metadata: {}
            }
          ]
        })
      );
      expect(dto.edges.filter((e) => e.kind === 'observed_via')).toEqual([]);
    });

    test('not emitted at all when connection_id is null', () => {
      const dto = buildInfrastructureTopology(
        baseInput({
          observedResources: [
            {
              id: 'obs-1',
              provider: 'beszel',
              externalType: 'system',
              title: 'web-2',
              connectionId: null,
              externalId: null,
              url: 'https://beszel.example/systems/web-2',
              metadata: {}
            }
          ]
        })
      );
      expect(dto.edges.filter((e) => e.kind === 'observed_via')).toEqual([]);
    });
  });

  describe('address_match', () => {
    const targetFixture = baseInput({
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
      hostAddresses: [{ hostingTargetId: 'target-1', kind: 'wan', value: '203.0.113.9' }]
    });

    test('an exact address match between an OBSERVED resource and a target emits the edge', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        observedResources: [
          {
            id: 'obs-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-2',
            connectionId: null,
            externalId: null,
            url: 'https://beszel.example/systems/web-2',
            metadata: { host: '203.0.113.9' }
          }
        ]
      });
      const edge = dto.edges.find((e) => e.kind === 'address_match')!;
      expect(edge).toBeDefined();
      expect(edge.sourceNodeId).toBe('tool:obs-1');
      expect(edge.targetNodeId).toBe('hosting_target:target-1');
      expect(edge.matchedAddress).toBe('203.0.113.9');
      expect(edge.matchCount).toBe(1);
    });

    test('a partial-string match is never an edge — exact equality only', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        observedResources: [
          {
            id: 'obs-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-2',
            connectionId: null,
            externalId: null,
            url: 'https://beszel.example/systems/web-2',
            // Shares a prefix with the target's address, not the whole value.
            metadata: { host: '203.0.113.90' }
          }
        ]
      });
      expect(dto.edges.filter((e) => e.kind === 'address_match')).toEqual([]);
    });

    test('a different address is never an edge', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        observedResources: [
          {
            id: 'obs-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-2',
            connectionId: null,
            externalId: null,
            url: 'https://beszel.example/systems/web-2',
            metadata: { host: '198.51.100.4' }
          }
        ]
      });
      expect(dto.edges.filter((e) => e.kind === 'address_match')).toEqual([]);
    });

    test('a dockhand host that is not an IP literal (a hostname) is skipped — never becomes a match candidate', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        hostAddresses: [
          // A target that happens to have a `host_addresses` row whose
          // VALUE is a real IP is irrelevant here; the point is that the
          // resource's own `host` field never even becomes a candidate.
          { hostingTargetId: 'target-1', kind: 'wan', value: '203.0.113.9' }
        ],
        observedResources: [
          {
            id: 'obs-dockhand',
            provider: 'dockhand',
            externalType: 'environment',
            title: 'docker-host-1',
            connectionId: null,
            externalId: null,
            url: 'https://dockhand.example/environments/env-1',
            metadata: { host: 'docker.internal.example', publicIp: null }
          }
        ]
      });
      expect(dto.edges.filter((e) => e.kind === 'address_match')).toEqual([]);
    });

    test('a LINKED tool node also participates in address_match, against a target other than the one it watches', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        externalResources: [
          {
            id: 'ext-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-1',
            connectionId: null,
            metadata: { host: '203.0.113.9' }
          }
        ]
        // No resourceLinks — ext-1 is not linked to target-1, so the match
        // is not suppressed by the watched_by dedupe.
      });
      const edge = dto.edges.find((e) => e.kind === 'address_match')!;
      expect(edge).toBeDefined();
      expect(edge.sourceNodeId).toBe('tool:ext-1');
      expect(edge.targetNodeId).toBe('hosting_target:target-1');
    });

    test('a pair already connected by watched_by is suppressed — nothing left to "possibly" confirm', () => {
      const dto = buildInfrastructureTopology({
        ...targetFixture,
        externalResources: [
          {
            id: 'ext-1',
            provider: 'beszel',
            externalType: 'system',
            title: 'web-1',
            connectionId: null,
            metadata: { host: '203.0.113.9' }
          }
        ],
        resourceLinks: [
          { externalResourceId: 'ext-1', resourceId: 'target-1', resourceType: 'hosting_target' }
        ]
      });
      expect(dto.edges.filter((e) => e.kind === 'address_match')).toEqual([]);
      expect(dto.edges.filter((e) => e.kind === 'watched_by')).toHaveLength(1);
    });

    test('at most one edge per (resource, target) pair even when multiple addresses match; the first is named, the rest counted', () => {
      const dto = buildInfrastructureTopology({
        hostingTargets: targetFixture.hostingTargets,
        hostAddresses: [
          { hostingTargetId: 'target-1', kind: 'wan', value: '203.0.113.9' },
          { hostingTargetId: 'target-1', kind: 'tailnet', value: '100.64.1.2' }
        ],
        managedDomains: [],
        proxyResources: [],
        connections: [],
        externalResources: [],
        resourceLinks: [],
        observedResources: [
          {
            id: 'obs-1',
            provider: 'tailscale',
            externalType: 'device',
            title: 'device-1',
            connectionId: null,
            externalId: null,
            url: 'https://login.tailscale.com/admin/machines/device-1',
            metadata: { addresses: ['203.0.113.9', '100.64.1.2'] }
          }
        ],
        ignoredTailscaleExternalIds: new Set(),
        health: [],
        readAt: READ_AT
      });
      const matches = dto.edges.filter((e) => e.kind === 'address_match');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedAddress).toBe('203.0.113.9');
      expect(matches[0]!.matchCount).toBe(2);
      expect(matches[0]!.sentence).toContain('(and 1 more matching address),');
    });
  });
});
