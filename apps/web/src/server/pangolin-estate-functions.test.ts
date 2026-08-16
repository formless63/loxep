import { describe, expect, test } from 'bun:test';
import { matchDeclaredResource } from './pangolin-estate-functions.ts';
import type { ProxyResourceChainDto } from './infrastructure-functions.ts';

function declared(overrides: Partial<ProxyResourceChainDto> = {}): ProxyResourceChainDto {
  return {
    id: 'row-1',
    domainId: 'domain-1',
    domainName: 'example.test',
    hostingTargetId: 'target-1',
    hostingTargetName: 'target',
    subdomain: 'app',
    fullDomain: 'app.example.test',
    mode: 'http',
    ssl: true,
    enabled: true,
    externalResourceId: null,
    rules: [],
    lastRun: null,
    unmatchedObservedCount: null,
    connectionId: null,
    writePolicyTier: null,
    lastRuleLifecycleChange: null,
    ...overrides
  };
}

describe('matchDeclaredResource (loxep-pq2)', () => {
  test('matches by externalResourceId first', () => {
    const rows = [declared({ externalResourceId: '42', fullDomain: 'other.example.test' })];
    const match = matchDeclaredResource({ resourceId: 42, fullDomain: 'app.example.test' }, rows);
    expect(match).toBe(rows[0]);
  });

  test('falls back to fullDomain when no externalResourceId matches', () => {
    const rows = [declared({ externalResourceId: null, fullDomain: 'app.example.test' })];
    const match = matchDeclaredResource({ resourceId: 999, fullDomain: 'app.example.test' }, rows);
    expect(match).toBe(rows[0]);
  });

  test('returns null when nothing matches either key', () => {
    const rows = [declared({ externalResourceId: '1', fullDomain: 'a.example.test' })];
    const match = matchDeclaredResource({ resourceId: 2, fullDomain: 'b.example.test' }, rows);
    expect(match).toBeNull();
  });

  test('returns null for a resource with no resourceId and no matching fullDomain', () => {
    const match = matchDeclaredResource({ resourceId: null, fullDomain: null }, [declared()]);
    expect(match).toBeNull();
  });
});
