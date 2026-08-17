/**
 * Unit test for `visibleStatusBarSegments`, `StackedStatusBar`'s pure logic
 * (loxep-0g4 D4 mini-bars). Rendering itself is exercised visually per
 * Frontend Standards' two-themes-plus-dark-mode check, not here — this repo's
 * suite tests pure helpers, matching `market-functions.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { visibleStatusBarSegments } from './stacked-status-bar.tsx';

describe('visibleStatusBarSegments', () => {
  test('null for a zero total — never an empty/invisible bar', () => {
    expect(
      visibleStatusBarSegments([
        { key: 'a', label: 'A', count: 0, color: 'var(--success)' },
        { key: 'b', label: 'B', count: 0, color: 'var(--warning)' }
      ])
    ).toBeNull();
    expect(visibleStatusBarSegments([])).toBeNull();
  });

  test('drops zero-count segments but keeps the rest in order', () => {
    const result = visibleStatusBarSegments([
      { key: 'a', label: 'A', count: 0, color: 'var(--success)' },
      { key: 'b', label: 'B', count: 3, color: 'var(--warning)' },
      { key: 'c', label: 'C', count: 5, color: 'var(--destructive)' }
    ]);
    expect(result).toEqual([
      { key: 'b', label: 'B', count: 3, color: 'var(--warning)' },
      { key: 'c', label: 'C', count: 5, color: 'var(--destructive)' }
    ]);
  });

  test('keeps every segment when all are non-zero', () => {
    const segments = [
      { key: 'a', label: 'A', count: 1, color: 'var(--success)' },
      { key: 'b', label: 'B', count: 1, color: 'var(--warning)' }
    ];
    expect(visibleStatusBarSegments(segments)).toEqual(segments);
  });
});
