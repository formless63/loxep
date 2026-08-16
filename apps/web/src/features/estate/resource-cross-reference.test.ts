import { describe, expect, test } from 'bun:test';
import { estateResourceCrossReference } from './resource-cross-reference';

describe('estateResourceCrossReference (loxep-47o.6/loxep-47o.7)', () => {
  test('externalResourceId null and linked null when the sweep has never discovered this object', () => {
    const result = estateResourceCrossReference('node-1', new Map(), new Map(), new Map());
    expect(result).toEqual({ externalResourceId: null, linked: null });
  });

  test('externalResourceId set, linked null when discovered but not attached to a hosting target', () => {
    const resourceByExternalId = new Map([['node-1', { id: 'resource-1' }]]);
    const result = estateResourceCrossReference(
      'node-1',
      resourceByExternalId,
      new Map(),
      new Map()
    );
    expect(result).toEqual({ externalResourceId: 'resource-1', linked: null });
  });

  test('linked with the hosting target name when a resource_links row exists', () => {
    const resourceByExternalId = new Map([['node-1', { id: 'resource-1' }]]);
    const linkedHostingTargetIdByExternalResourceId = new Map([['resource-1', 'target-1']]);
    const hostingTargetNameById = new Map([['target-1', 'db-primary']]);
    const result = estateResourceCrossReference(
      'node-1',
      resourceByExternalId,
      linkedHostingTargetIdByExternalResourceId,
      hostingTargetNameById
    );
    expect(result).toEqual({
      externalResourceId: 'resource-1',
      linked: { hostingTargetId: 'target-1', hostingTargetName: 'db-primary' }
    });
  });

  test('falls back to the raw id when a linked hosting target has no name in the map (defensive, should not occur)', () => {
    const resourceByExternalId = new Map([['node-1', { id: 'resource-1' }]]);
    const linkedHostingTargetIdByExternalResourceId = new Map([['resource-1', 'target-1']]);
    const result = estateResourceCrossReference(
      'node-1',
      resourceByExternalId,
      linkedHostingTargetIdByExternalResourceId,
      new Map()
    );
    expect(result.linked).toEqual({ hostingTargetId: 'target-1', hostingTargetName: 'target-1' });
  });

  test('two devices sharing no state stay independent — keying is per externalId, never a shared default', () => {
    const resourceByExternalId = new Map([
      ['node-1', { id: 'resource-1' }],
      ['node-2', { id: 'resource-2' }]
    ]);
    const linkedHostingTargetIdByExternalResourceId = new Map([['resource-1', 'target-1']]);
    const hostingTargetNameById = new Map([['target-1', 'db-primary']]);
    const linkedResult = estateResourceCrossReference(
      'node-1',
      resourceByExternalId,
      linkedHostingTargetIdByExternalResourceId,
      hostingTargetNameById
    );
    const unlinkedResult = estateResourceCrossReference(
      'node-2',
      resourceByExternalId,
      linkedHostingTargetIdByExternalResourceId,
      hostingTargetNameById
    );
    expect(linkedResult.linked).not.toBeNull();
    expect(unlinkedResult.linked).toBeNull();
    expect(unlinkedResult.externalResourceId).toBe('resource-2');
  });
});
