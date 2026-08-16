import { describe, expect, test } from 'bun:test';
import {
  cloudflareEstateHasMore,
  cloudflareRecordCrossReference
} from './cloudflare-estate-functions.ts';

describe('cloudflareRecordCrossReference (loxep-47o.2)', () => {
  test('unexpected when no dns_records row matches type+name', () => {
    const result = cloudflareRecordCrossReference({ type: 'A', name: '@' }, new Map(), new Set());
    expect(result).toBe('unexpected');
  });

  test('declared when a dns_records row matches and no open drift finding references it', () => {
    const declaredByKey = new Map([['A:@', { id: 'record-1' }]]);
    const result = cloudflareRecordCrossReference(
      { type: 'A', name: '@' },
      declaredByKey,
      new Set()
    );
    expect(result).toBe('declared');
  });

  test('drift_open when the matched dns_records row has an unresolved drift finding', () => {
    const declaredByKey = new Map([['A:@', { id: 'record-1' }]]);
    const openFindingRecordIds = new Set(['record-1']);
    const result = cloudflareRecordCrossReference(
      { type: 'A', name: '@' },
      declaredByKey,
      openFindingRecordIds
    );
    expect(result).toBe('drift_open');
  });

  test('matches on the exact (type, name) pair — a same-name different-type record is unexpected', () => {
    const declaredByKey = new Map([['A:@', { id: 'record-1' }]]);
    const result = cloudflareRecordCrossReference(
      { type: 'AAAA', name: '@' },
      declaredByKey,
      new Set()
    );
    expect(result).toBe('unexpected');
  });
});

describe('cloudflareEstateHasMore (Rule P8)', () => {
  test('false when fewer rows returned than the page could hold', () => {
    expect(cloudflareEstateHasMore(9, 1, 50)).toBe(false);
  });

  test('true when the row count exactly fills the fetched pages — conservative by design', () => {
    expect(cloudflareEstateHasMore(50, 1, 50)).toBe(true);
  });

  test('true when the row count exceeds the fetched pages (should not happen, but never hides rows)', () => {
    expect(cloudflareEstateHasMore(51, 1, 50)).toBe(true);
  });

  test('scales with maxPages — two loaded pages needs 100 rows to still say "more"', () => {
    expect(cloudflareEstateHasMore(99, 2, 50)).toBe(false);
    expect(cloudflareEstateHasMore(100, 2, 50)).toBe(true);
  });

  test('empty read never claims more', () => {
    expect(cloudflareEstateHasMore(0, 1, 50)).toBe(false);
  });
});
