/**
 * Unit test for `monitorTargetWatchSummary`, the pure helper behind
 * `/market/monitors`' "Watching" column (loxep-759). Before it, the monitors
 * list said WHAT each monitor watches nowhere — `monitor_targets.config` was
 * carried all the way to the DTO and dropped at render.
 *
 * `config` is untyped `Record<string, JsonValue>` at that boundary, so the
 * cases below pin the two things that actually matter: each target type
 * reads the keys `createMonitorConfig` (`@/server/market-functions.ts`)
 * writes for it, and a malformed/absent config degrades to `—` rather than
 * rendering `undefined` or throwing. This repo's suite tests pure helpers,
 * matching `stacked-status-bar.test.ts` and `market-functions.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  marketEventTypeBarColor,
  marketItemStateBarColor,
  monitorTargetWatchSummary
} from './constants';

describe('monitorTargetWatchSummary', () => {
  test('ebay_item names the item it polls', () => {
    expect(monitorTargetWatchSummary('ebay_item', { externalItemId: '123456789' })).toBe(
      'Item 123456789'
    );
  });

  test('ebay_watchlist is identified by its connection, not a config field', () => {
    expect(monitorTargetWatchSummary('ebay_watchlist', {})).toBe('Connection watchlist');
  });

  test('ebay_search shows query and category, joined', () => {
    expect(monitorTargetWatchSummary('ebay_search', { query: 'leica m6' })).toBe('"leica m6"');
    expect(monitorTargetWatchSummary('ebay_search', { query: 'leica m6', categoryId: '625' })).toBe(
      '"leica m6" · category 625'
    );
    expect(monitorTargetWatchSummary('ebay_search', { categoryId: '625' })).toBe('category 625');
  });

  test('ebay_seller leads with the seller, then any narrowing', () => {
    expect(monitorTargetWatchSummary('ebay_seller', { sellerUsername: 'camerastore' })).toBe(
      'seller camerastore'
    );
    expect(
      monitorTargetWatchSummary('ebay_seller', { sellerUsername: 'camerastore', query: 'leica' })
    ).toBe('seller camerastore · "leica"');
  });

  test('order-sync and purchase-sync types have no operator-authored config to show', () => {
    expect(monitorTargetWatchSummary('woo_orders', {})).toBe('Order sync');
    expect(monitorTargetWatchSummary('ebay_orders', {})).toBe('Order sync');
    expect(monitorTargetWatchSummary('medusa_orders', {})).toBe('Order sync');
    expect(monitorTargetWatchSummary('ebay_purchases', {})).toBe('Purchase sync');
  });

  test('an empty, malformed, or non-string config degrades to an em dash', () => {
    expect(monitorTargetWatchSummary('ebay_item', {})).toBe('—');
    expect(monitorTargetWatchSummary('ebay_search', {})).toBe('—');
    expect(monitorTargetWatchSummary('ebay_seller', {})).toBe('—');
    // A non-string value must not reach the string template as `[object Object]`.
    expect(monitorTargetWatchSummary('ebay_item', { externalItemId: { nested: true } })).toBe('—');
    expect(monitorTargetWatchSummary('ebay_search', { query: 42 })).toBe('—');
  });

  test('an unrecognized target type degrades rather than throwing', () => {
    expect(monitorTargetWatchSummary('etsy_search', { query: 'x' })).toBe('—');
  });
});

describe('bar-segment colors are theme tokens, never literals', () => {
  test('every known item state and event type maps to a var() token', () => {
    for (const state of ['active', 'ended']) {
      expect(marketItemStateBarColor(state)).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
    for (const eventType of [
      'price_changed',
      'price_dropped',
      'restocked',
      'sold_out',
      'quantity_changed',
      'listing_ended',
      'new_listing'
    ]) {
      expect(marketEventTypeBarColor(eventType)).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  test('an unrecognized value falls back to a token too, never a hex', () => {
    expect(marketItemStateBarColor('future_state')).toBe('var(--muted-foreground)');
    expect(marketEventTypeBarColor('future_event')).toBe('var(--muted-foreground)');
  });
});
