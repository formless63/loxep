import { describe, expect, test } from 'bun:test';
import { dockhandEnvironmentCrossReference } from './dockhand-estate-functions.ts';

describe('dockhandEnvironmentCrossReference (loxep-47o.4)', () => {
  test('unknown when no external_resources row exists for this environment', () => {
    const result = dockhandEnvironmentCrossReference(undefined, new Map(), new Map());
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('unmatched when a resource row exists but no resource_links row attaches it', () => {
    const result = dockhandEnvironmentCrossReference({ id: 'resource-1' }, new Map(), new Map());
    expect(result).toEqual({ kind: 'unmatched', externalResourceId: 'resource-1' });
  });

  test('unmatched when the link points at a hosting target that no longer resolves (decommissioned/gone)', () => {
    const hostingTargetIdByResourceId = new Map([['resource-1', 'target-1']]);
    const result = dockhandEnvironmentCrossReference(
      { id: 'resource-1' },
      hostingTargetIdByResourceId,
      new Map()
    );
    expect(result).toEqual({ kind: 'unmatched', externalResourceId: 'resource-1' });
  });

  test('linked when the resource is attached to a hosting target that resolves to a name', () => {
    const hostingTargetIdByResourceId = new Map([['resource-1', 'target-1']]);
    const targetNameById = new Map([['target-1', 'prod-vps']]);
    const result = dockhandEnvironmentCrossReference(
      { id: 'resource-1' },
      hostingTargetIdByResourceId,
      targetNameById
    );
    expect(result).toEqual({
      kind: 'linked',
      hostingTargetId: 'target-1',
      hostingTargetName: 'prod-vps'
    });
  });
});
