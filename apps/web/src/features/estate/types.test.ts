import { describe, expect, test } from 'bun:test';
import { estateBlocked, estateError, estateOk } from './types.ts';

describe('EstateSectionResult constructors (loxep-47o.1, Rule P13)', () => {
  test('estateOk carries the data and stamps readAt', () => {
    const result = estateOk({ rows: [1, 2, 3] }, '2026-01-01T00:00:00.000Z');
    expect(result.status).toBe('ok');
    expect(result.readAt).toBe('2026-01-01T00:00:00.000Z');
    if (result.status === 'ok') {
      expect(result.data.rows).toEqual([1, 2, 3]);
    }
  });

  test('estateBlocked carries the reason verbatim, never a guess', () => {
    const result = estateBlocked('no org id configured', '2026-01-01T00:00:00.000Z');
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('no org id configured');
    }
  });

  test('estateError carries kind, message, and localRateBudget through as one branch', () => {
    const result = estateError(
      { kind: 'rate_limited', message: 'throttled', localRateBudget: true },
      '2026-01-01T00:00:00.000Z'
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.kind).toBe('rate_limited');
      expect(result.message).toBe('throttled');
      expect(result.localRateBudget).toBe(true);
    }
  });

  test('the three constructors produce mutually exclusive status literals', () => {
    const statuses = [
      estateOk(null, 'x').status,
      estateBlocked('x', 'x').status,
      estateError({ kind: 'unknown', message: 'x', localRateBudget: false }, 'x').status
    ];
    expect(new Set(statuses).size).toBe(3);
  });
});
