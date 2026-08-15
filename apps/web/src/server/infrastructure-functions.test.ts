/**
 * Unit tests for the pure `computeHostDiagnosisInput` helper in
 * `infrastructure-functions.ts` (loxep-y64 slice 3). Run with Bun's built-in
 * test runner, matching the sibling `admin-functions.test.ts`/
 * `finance-billing.test.ts` precedent: `bun test
 * apps/web/src/server/infrastructure-functions.test.ts`.
 *
 * This is the "witness-sentence upgrade" proof the slice 3 scope calls for:
 * before this slice, no Beszel `external_resource` health row could exist at
 * all (discovery did not run), so `diagnoseHostWitnesses` could never see a
 * real Beszel witness — every fixture anyone could write was necessarily
 * `undefined`/absent. Now that `@loxep/app`'s `projectBeszelSystems` writes a
 * real per-system, `source: 'adapter'` row, `computeHostDiagnosisInput`
 * (unchanged code, per its own doc comment) starts reading it, and the
 * ladder in `@loxep/domain`'s `diagnoseHostWitnesses` can reason over an
 * ACTUAL Beszel reading for the first time. These tests build the exact
 * `CompanionLinkDto` shape `fetchHostingTarget` would produce for an
 * attached, adapter-sourced Beszel link and feed it through both functions
 * end to end — no database, no server function invocation.
 */
import { describe, expect, test } from 'bun:test';
import { diagnoseHostWitnesses } from '@loxep/domain';
import type { CompanionLink } from '@loxep/domain';
import { computeHostDiagnosisInput, computePrivateNetworkRow } from './infrastructure-functions.ts';
import type { CompanionLinkDto } from './infrastructure-functions.ts';

function beszelLink(overrides: Partial<CompanionLinkDto['health']> = {}): CompanionLinkDto {
  return {
    id: 'beszel-resource-1',
    provider: 'beszel',
    externalType: 'system',
    url: 'https://beszel.example.test/system/beszel-resource-1',
    title: 'web-1',
    resourceId: 'target-1',
    purpose: 'host_metrics',
    createdAt: '2026-08-14T00:00:00.000Z',
    knownTool: { label: 'Beszel', embeddable: false },
    metadata: {},
    health: {
      status: 'ok',
      source: 'adapter',
      checkedAt: '2026-08-15T00:00:00.000Z',
      detail: { status: 'up', observedAt: '2026-08-14T23:59:00.000Z' },
      ...overrides
    }
  };
}

function gatusLink(status: 'ok' | 'failing'): CompanionLinkDto {
  return {
    id: `gatus-resource-${status}`,
    provider: 'gatus',
    externalType: 'endpoint',
    url: 'https://gatus.example.test/endpoints/web-1',
    title: null,
    resourceId: 'target-1',
    purpose: 'uptime_check',
    createdAt: '2026-08-14T00:00:00.000Z',
    knownTool: { label: 'Gatus', embeddable: false },
    metadata: {},
    health: {
      status,
      source: 'probe',
      checkedAt: '2026-08-15T00:00:00.000Z',
      detail: {}
    }
  };
}

/** `diagnoseHostWitnesses`'s ladder gates most rungs on `tailscaleStatus === 'ok'` — a fixture, not itself part of what slice 3 upgraded. */
function tailscaleLink(): CompanionLinkDto {
  return {
    id: 'tailscale-resource-1',
    provider: 'tailscale',
    externalType: 'device',
    url: 'https://api.tailscale.com/device/xyz',
    title: null,
    resourceId: 'target-1',
    purpose: 'private_network',
    createdAt: '2026-08-14T00:00:00.000Z',
    knownTool: { label: 'Tailscale', embeddable: false },
    metadata: {},
    health: {
      status: 'ok',
      source: 'adapter',
      checkedAt: '2026-08-15T00:00:00.000Z',
      detail: {}
    }
  };
}

describe('computeHostDiagnosisInput (loxep-y64 slice 3 witness upgrade)', () => {
  test('an adapter-sourced, ok Beszel link becomes input.beszel = { status: "ok" }', () => {
    const input = computeHostDiagnosisInput([beszelLink()]);
    expect(input.beszel).toEqual({ status: 'ok' });
  });

  test("a failing Beszel system (Beszel's own 'down') carries through as failing, not the verbatim string", () => {
    const link = beszelLink({
      status: 'failing',
      detail: { status: 'down', observedAt: '2026-08-14T23:00:00.000Z' }
    });
    const input = computeHostDiagnosisInput([link]);
    expect(input.beszel).toEqual({ status: 'failing' });
  });

  test('no Beszel link at all means no beszel key on the input — absent, not "unknown"', () => {
    const input = computeHostDiagnosisInput([gatusLink('ok'), gatusLink('failing')]);
    expect(input.beszel).toBeUndefined();
  });

  test('end to end: real adapter-sourced Beszel + Tailscale witnesses plus a failing Gatus endpoint produce a service_problem diagnosis naming its subjects', () => {
    const links = [tailscaleLink(), beszelLink(), gatusLink('failing')];
    const diagnosis = diagnoseHostWitnesses(computeHostDiagnosisInput(links));

    expect(diagnosis.diagnosed).toBe(true);
    expect(diagnosis.reason).toBe('service_problem');
    expect(diagnosis.sentence).toContain('one service is failing');
    // witness-not-verdict: no aggregate status anywhere on the result, only
    // named, unmerged per-witness readings, ladder-ordered.
    expect(diagnosis.witnesses).toEqual([
      { witness: 'tailscale', status: 'ok' },
      { witness: 'beszel', status: 'ok' },
      { witness: 'gatus', failing: 1, total: 1 }
    ]);
  });

  test('end to end: Beszel silent (never swept / no read yet) alongside a healthy Tailscale and an informative Gatus reads as an agent problem, not a host outage', () => {
    const links = [
      tailscaleLink(),
      { ...beszelLink({ status: 'unknown', detail: {} }) },
      gatusLink('ok')
    ];
    const diagnosis = diagnoseHostWitnesses(computeHostDiagnosisInput(links));
    expect(diagnosis.diagnosed).toBe(true);
    expect(diagnosis.reason).toBe('agent_silent');
    expect(diagnosis.sentence).toContain('metrics agent is silent');
  });

  test('end to end: an unattached/never-swept Beszel system contributes nothing — a single witness still refuses to diagnose', () => {
    // Only ONE linked witness (Gatus) — the mandatory two-signal floor
    // (loxep-50t §3.1) refuses a confident sentence regardless of how rich
    // that one witness's own data is.
    const diagnosis = diagnoseHostWitnesses(computeHostDiagnosisInput([gatusLink('failing')]));
    expect(diagnosis.diagnosed).toBe(false);
    expect(diagnosis.reason).toBe('insufficient_signals');
    expect(diagnosis.sentence).toBe('Not enough linked tools to say.');
  });

  test('multiple beszel systems attached to one target: the WORST status wins, never averaged', () => {
    const okSystem = beszelLink();
    const failingSystem: CompanionLinkDto = {
      ...beszelLink({ status: 'failing', detail: { status: 'down' } }),
      id: 'beszel-resource-2'
    };
    const input = computeHostDiagnosisInput([okSystem, failingSystem, gatusLink('ok')]);
    expect(input.beszel).toEqual({ status: 'failing' });
  });
});

/**
 * `computePrivateNetworkRow` (loxep-50t §1.2) — the fleet-detail "Private
 * network" row and, most load-bearingly, its conditional, evidence-withdrawn
 * reachability caveat. No database: every input is a hand-built `CompanionLink`
 * plus plain connection/health lookups, matching this file's own
 * `computeHostDiagnosisInput` test precedent.
 */
function tsCompanionLink(overrides: Partial<CompanionLink> = {}): CompanionLink {
  return {
    externalResourceId: 'ts-resource-1',
    resourceType: 'hosting_target',
    resourceId: 'target-1',
    purpose: 'private_network',
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    provider: 'tailscale',
    externalType: 'device',
    externalId: 'node-1',
    url: 'https://login.tailscale.com/admin/machines/node-1',
    title: 'hollow.tailnet.ts.net',
    connectionId: 'ts-connection-1',
    metadata: {
      observedAt: '2026-08-15T00:00:00.000Z',
      online: true,
      lastSeen: null,
      addresses: ['100.64.1.2'],
      magicDnsName: 'hollow.tailnet.ts.net',
      os: 'linux',
      authorized: true
    },
    ...overrides
  };
}

function beszelCompanionLink(overrides: Partial<CompanionLink> = {}): CompanionLink {
  return {
    externalResourceId: 'beszel-resource-1',
    resourceType: 'hosting_target',
    resourceId: 'target-1',
    purpose: 'host_metrics',
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    provider: 'beszel',
    externalType: 'system',
    externalId: 'sys-1',
    url: 'https://beszel.example.test/system/sys-1',
    title: 'hollow',
    connectionId: 'beszel-connection-1',
    metadata: {},
    ...overrides
  };
}

describe('computePrivateNetworkRow (loxep-50t §1.2)', () => {
  test('null when the target carries no tailscale/private_network link', () => {
    expect(
      computePrivateNetworkRow({
        companionLinks: [beszelCompanionLink()],
        healthByLinkId: new Map(),
        connectionsById: new Map(),
        providerLabel: (provider) => provider
      })
    ).toBeNull();
  });

  test('renders the device metadata verbatim, with no caveat when nothing else is linked', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [tsCompanionLink()],
      healthByLinkId: new Map(),
      connectionsById: new Map(),
      providerLabel: (provider) => provider
    });
    expect(row).not.toBeNull();
    expect(row?.addresses).toEqual(['100.64.1.2']);
    expect(row?.magicDnsName).toBe('hollow.tailnet.ts.net');
    expect(row?.online).toBe(true);
    expect(row?.lastSeen).toBeNull();
    expect(row?.reachabilityCaveat).toBeNull();
  });

  test('lastSeen is surfaced only while offline, even if Tailscale reported a stale value', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [
        tsCompanionLink({
          metadata: {
            online: true,
            lastSeen: '2020-01-01T00:00:00.000Z',
            addresses: [],
            magicDnsName: null,
            os: null,
            authorized: null
          }
        })
      ],
      healthByLinkId: new Map(),
      connectionsById: new Map(),
      providerLabel: (provider) => provider
    });
    expect(row?.online).toBe(true);
    expect(row?.lastSeen).toBeNull();
  });

  test('renders the caveat: a host-matched sibling reading unknown, whose connection never succeeded', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [tsCompanionLink(), beszelCompanionLink()],
      healthByLinkId: new Map([
        [
          'beszel-resource-1',
          {
            status: 'unknown',
            checkedAt: new Date('2026-08-15T00:05:00.000Z'),
            detail: { kind: 'unreachable' }
          }
        ]
      ]),
      connectionsById: new Map([
        [
          'beszel-connection-1',
          { config: { beszel: { baseUrl: 'https://100.64.1.2:8090' } }, lastSuccessAt: null }
        ]
      ]),
      providerLabel: (provider) => (provider === 'beszel' ? 'Beszel' : provider)
    });
    expect(row?.reachabilityCaveat).not.toBeNull();
    expect(row?.reachabilityCaveat).toContain('Beszel');
    expect(row?.reachabilityCaveat).toContain('not this host');
  });

  test('WITHDRAWN on evidence: the same host-matched sibling, but its connection has succeeded before', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [tsCompanionLink(), beszelCompanionLink()],
      healthByLinkId: new Map([
        [
          'beszel-resource-1',
          {
            status: 'unknown',
            checkedAt: new Date('2026-08-15T00:05:00.000Z'),
            detail: { kind: 'unreachable' }
          }
        ]
      ]),
      connectionsById: new Map([
        [
          'beszel-connection-1',
          {
            config: { beszel: { baseUrl: 'https://100.64.1.2:8090' } },
            lastSuccessAt: new Date('2026-08-01T00:00:00.000Z')
          }
        ]
      ]),
      providerLabel: (provider) => provider
    });
    expect(row?.reachabilityCaveat).toBeNull();
  });

  test('never triggers when the sibling connection host does NOT match the device (cheap string comparison, not a guess)', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [tsCompanionLink(), beszelCompanionLink()],
      healthByLinkId: new Map([
        [
          'beszel-resource-1',
          {
            status: 'unknown',
            checkedAt: new Date('2026-08-15T00:05:00.000Z'),
            detail: { kind: 'unreachable' }
          }
        ]
      ]),
      connectionsById: new Map([
        [
          'beszel-connection-1',
          {
            config: { beszel: { baseUrl: 'https://unrelated-host.example.test' } },
            lastSuccessAt: null
          }
        ]
      ]),
      providerLabel: (provider) => provider
    });
    expect(row?.reachabilityCaveat).toBeNull();
  });

  test('a Beszel witness reading unknown because an OPERATOR paused it is never mistaken for a network fact', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [tsCompanionLink(), beszelCompanionLink()],
      healthByLinkId: new Map([
        [
          'beszel-resource-1',
          {
            status: 'unknown',
            checkedAt: new Date('2026-08-15T00:05:00.000Z'),
            detail: { status: 'paused', observedAt: '2026-08-14T23:00:00.000Z' }
          }
        ]
      ]),
      connectionsById: new Map([
        [
          'beszel-connection-1',
          { config: { beszel: { baseUrl: 'https://100.64.1.2:8090' } }, lastSuccessAt: null }
        ]
      ]),
      providerLabel: (provider) => provider
    });
    expect(row?.reachabilityCaveat).toBeNull();
  });

  test('matches on MagicDNS name too, not just a raw address', () => {
    const row = computePrivateNetworkRow({
      companionLinks: [
        tsCompanionLink({
          metadata: {
            online: true,
            lastSeen: null,
            addresses: [],
            magicDnsName: 'hollow.tailnet.ts.net',
            os: null,
            authorized: null
          }
        }),
        beszelCompanionLink()
      ],
      healthByLinkId: new Map([
        [
          'beszel-resource-1',
          {
            status: 'unknown',
            checkedAt: new Date('2026-08-15T00:05:00.000Z'),
            detail: { kind: 'unreachable' }
          }
        ]
      ]),
      connectionsById: new Map([
        [
          'beszel-connection-1',
          {
            config: { beszel: { baseUrl: 'https://hollow.tailnet.ts.net:8090' } },
            lastSuccessAt: null
          }
        ]
      ]),
      providerLabel: (provider) => provider
    });
    expect(row?.reachabilityCaveat).not.toBeNull();
  });
});
