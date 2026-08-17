import { describe, expect, test } from 'bun:test';
import { integrationServices } from '@/features/settings/integrations-catalog';
import { PROVIDER_BRAND_ICON_FALLBACKS, PROVIDER_BRAND_ICONS } from './provider-brand-icons';

describe('PROVIDER_BRAND_ICONS (loxep-2xk)', () => {
  test('every catalog provider resolves to a mark or an explicit null, never undefined', () => {
    for (const service of integrationServices) {
      expect(Object.prototype.hasOwnProperty.call(PROVIDER_BRAND_ICONS, service.id)).toBe(true);
      const mark = PROVIDER_BRAND_ICONS[service.id];
      expect(mark === null || typeof mark.path === 'string').toBe(true);
    }
  });

  test('a present mark carries a non-empty SVG path', () => {
    // Rule I2 (never a brand hex) is enforced at the type/render layer, not
    // here: `BrandMark` narrows every consumer to `{ path }` and `BrandIcon`
    // never reads `.hex`, even though the underlying `simple-icons` object
    // still carries one at runtime — structural typing does not strip it, so
    // asserting its absence here would be a false test, not a real guarantee.
    for (const service of integrationServices) {
      const mark = PROVIDER_BRAND_ICONS[service.id];
      if (mark === null) continue;
      expect(mark.path.length).toBeGreaterThan(0);
    }
  });

  test('every mark-less provider has a documented fallback icon component', () => {
    for (const service of integrationServices) {
      if (PROVIDER_BRAND_ICONS[service.id] !== null) continue;
      expect(PROVIDER_BRAND_ICON_FALLBACKS[service.id]).toBeDefined();
    }
  });

  test('the six providers predicted mark-less by the design doc are exactly the ones without a mark', () => {
    // `Array#toSorted` needs a newer lib target than this project's
    // `tsconfig` sets; a plain `.sort()` on these fresh, locally-built arrays
    // mutates nothing anyone else can observe.
    const markless = integrationServices
      .filter((service) => PROVIDER_BRAND_ICONS[service.id] === null)
      .map((service) => service.id)
      .sort();
    expect(markless).toEqual(
      ['beszel', 'dockhand', 'gatus', 'purelymail', 'reverb', 'termix'].sort()
    );
  });
});
