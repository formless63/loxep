/**
 * Unit tests for the `integrations.enabled` catalog-visibility filtering
 * logic (loxep-dgg). Run with Bun's built-in test runner, matching the
 * sibling `admin-functions.test.ts` precedent:
 * `bun test apps/web/src/features/settings/integrations-catalog.test.ts`.
 *
 * These are the pure client-side helpers every provider-enumerating surface
 * (the catalog grid, connection-add options on the connections page) shares
 * to decide what to show/offer — the schema itself is tested against the
 * real registered setting in `packages/domain/test/settings.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  filterIntegrationServices,
  isIntegrationEnabled,
  integrationServices,
  type IntegrationEnabledMap
} from './integrations-catalog.ts';

describe('isIntegrationEnabled', () => {
  test('an id absent from the map is enabled (absence means visible)', () => {
    expect(isIntegrationEnabled({}, 'ebay')).toBe(true);
    expect(isIntegrationEnabled({ etsy: false }, 'ebay')).toBe(true);
  });

  test('an id explicitly mapped true is enabled', () => {
    expect(isIntegrationEnabled({ ebay: true }, 'ebay')).toBe(true);
  });

  test('only an explicit false disables an id', () => {
    expect(isIntegrationEnabled({ ebay: false }, 'ebay')).toBe(false);
  });
});

describe('filterIntegrationServices', () => {
  test('hides only the explicitly-disabled entries by default', () => {
    const enabledMap: IntegrationEnabledMap = { etsy: false, termix: false };
    const visible = filterIntegrationServices(integrationServices, enabledMap);
    const visibleIds = visible.map((service) => service.id);

    expect(visibleIds).not.toContain('etsy');
    expect(visibleIds).not.toContain('termix');
    // Every other catalog entry (an absent key) stays visible.
    expect(visibleIds).toContain('ebay');
    expect(visibleIds).toContain('woocommerce');
    expect(visibleIds.length).toBe(integrationServices.length - 2);
  });

  test('an empty map (the PROVISIONAL all-on default) hides nothing', () => {
    const visible = filterIntegrationServices(integrationServices, {});
    expect(visible.length).toBe(integrationServices.length);
  });

  test('includeDisabled reveals every entry regardless of the map, preserving order', () => {
    const enabledMap: IntegrationEnabledMap = { ebay: false, etsy: false, reverb: false };
    const revealed = filterIntegrationServices(integrationServices, enabledMap, {
      includeDisabled: true
    });
    expect(revealed).toEqual(integrationServices);
  });

  test('preserves catalog order among the entries that remain visible', () => {
    const enabledMap: IntegrationEnabledMap = { etsy: false };
    const visible = filterIntegrationServices(integrationServices, enabledMap);
    const expectedOrder = integrationServices
      .filter((service) => service.id !== 'etsy')
      .map((service) => service.id);
    expect(visible.map((service) => service.id)).toEqual(expectedOrder);
  });
});
