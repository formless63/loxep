import { describe, expect, test } from 'bun:test';
import { combinePagedEstateResults } from './combine-paged-estate-section.ts';

interface FakePage {
  hasNextPage: boolean;
  values: string[];
}

const extract = (page: FakePage) => page.values;

describe('combinePagedEstateResults (loxep-47o.8, Rule P8 rework)', () => {
  test('undefined when no page has settled yet', () => {
    expect(combinePagedEstateResults<FakePage, string>([undefined], extract)).toBeUndefined();
    expect(combinePagedEstateResults<FakePage, string>([], extract)).toBeUndefined();
  });

  test('page 1 blocked wins outright — nothing accumulated to show alongside it', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [{ status: 'blocked', readAt: 't1', reason: 'no base URL configured' }],
      extract
    );
    expect(result).toEqual({ status: 'blocked', readAt: 't1', reason: 'no base URL configured' });
  });

  test('page 1 error wins outright', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [
        {
          status: 'error',
          readAt: 't1',
          kind: 'provider_unavailable',
          message: 'boom',
          localRateBudget: false
        }
      ],
      extract
    );
    expect(result).toMatchObject({ status: 'error', kind: 'provider_unavailable' });
  });

  test('one ok page: items pass through, hasNextPage/readAt from that page', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [{ status: 'ok', readAt: 't1', data: { hasNextPage: true, values: ['a', 'b'] } }],
      extract
    );
    expect(result).toEqual({
      status: 'ok',
      readAt: 't1',
      data: { items: ['a', 'b'], hasNextPage: true }
    });
  });

  test('multiple ok pages concatenate in order; readAt/hasNextPage come from the LATEST page', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [
        { status: 'ok', readAt: 't1', data: { hasNextPage: true, values: ['a', 'b'] } },
        { status: 'ok', readAt: 't2', data: { hasNextPage: false, values: ['c'] } }
      ],
      extract
    );
    expect(result).toEqual({
      status: 'ok',
      readAt: 't2',
      data: { items: ['a', 'b', 'c'], hasNextPage: false }
    });
  });

  test("a failed LATEST page reverts the whole section to that page's own honesty state, even though page 1 succeeded — the accumulated rows are not silently dropped from a call-cost standpoint (retrying costs exactly one more call, the caller's job), but they are not shown alongside a failure", () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [
        { status: 'ok', readAt: 't1', data: { hasNextPage: true, values: ['a'] } },
        {
          status: 'error',
          readAt: 't2',
          kind: 'rate_limited',
          message: 'slow down',
          localRateBudget: true
        }
      ],
      extract
    );
    expect(result).toEqual({
      status: 'error',
      readAt: 't2',
      kind: 'rate_limited',
      message: 'slow down',
      localRateBudget: true
    });
  });

  test('a blocked LATEST page after successful earlier pages also reverts to that blocked state', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [
        { status: 'ok', readAt: 't1', data: { hasNextPage: true, values: ['a'] } },
        { status: 'blocked', readAt: 't2', reason: 'no credential' }
      ],
      extract
    );
    expect(result).toEqual({ status: 'blocked', readAt: 't2', reason: 'no credential' });
  });

  test('undefined entries (pages still pending at the query layer) are skipped, not treated as failures', () => {
    const result = combinePagedEstateResults<FakePage, string>(
      [{ status: 'ok', readAt: 't1', data: { hasNextPage: true, values: ['a'] } }, undefined],
      extract
    );
    expect(result).toEqual({
      status: 'ok',
      readAt: 't1',
      data: { items: ['a'], hasNextPage: true }
    });
  });
});
