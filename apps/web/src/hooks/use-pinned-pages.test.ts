import { describe, expect, test } from 'bun:test';
import {
  parsePinnedPages,
  removePinnedPage,
  togglePinnedPage,
  type PinnedPage
} from './use-pinned-pages';

const marketOverview: PinnedPage = {
  title: 'Overview',
  url: '/market/overview',
  icon: 'dashboard',
  workspaceId: 'market'
};

const financeExpenses: PinnedPage = {
  title: 'Expenses',
  url: '/finance/expenses',
  icon: 'fees',
  workspaceId: 'finance'
};

describe('parsePinnedPages (loxep-koj)', () => {
  test('null/empty input parses to an empty list', () => {
    expect(parsePinnedPages(null)).toEqual([]);
    expect(parsePinnedPages('')).toEqual([]);
  });

  test('malformed JSON degrades to empty rather than throwing', () => {
    expect(parsePinnedPages('{not json')).toEqual([]);
  });

  test('a non-array JSON value degrades to empty', () => {
    expect(parsePinnedPages(JSON.stringify({ title: 'x' }))).toEqual([]);
  });

  test('entries missing required fields are dropped, valid ones kept', () => {
    const raw = JSON.stringify([marketOverview, { title: 'Bad' }, 42, null]);
    expect(parsePinnedPages(raw)).toEqual([marketOverview]);
  });

  test('a well-formed list round-trips exactly', () => {
    const raw = JSON.stringify([marketOverview, financeExpenses]);
    expect(parsePinnedPages(raw)).toEqual([marketOverview, financeExpenses]);
  });
});

describe('togglePinnedPage (loxep-koj)', () => {
  test('pins a page not already present', () => {
    expect(togglePinnedPage([], marketOverview)).toEqual([marketOverview]);
  });

  test('unpins a page already present, matched by url', () => {
    expect(togglePinnedPage([marketOverview, financeExpenses], marketOverview)).toEqual([
      financeExpenses
    ]);
  });

  test('is a no-op on the rest of the list', () => {
    const result = togglePinnedPage([marketOverview], financeExpenses);
    expect(result).toEqual([marketOverview, financeExpenses]);
  });
});

describe('removePinnedPage (loxep-koj)', () => {
  test('removes the matching entry by url', () => {
    expect(removePinnedPage([marketOverview, financeExpenses], marketOverview.url)).toEqual([
      financeExpenses
    ]);
  });

  test('is a no-op when the url is not pinned', () => {
    expect(removePinnedPage([marketOverview], '/settings/overview')).toEqual([marketOverview]);
  });
});
