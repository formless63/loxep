/**
 * Rule MAP1: region resolution never guesses. Run with `bun test
 * apps/web/src/features/infrastructure/topology/region-registry.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { HOME_MARKER, REGION_GEO_REGISTRY, resolveRegionGeo } from './region-registry';

describe('resolveRegionGeo', () => {
  test('resolves a known provider/region to its registered entry', () => {
    const entry = resolveRegionGeo('hetzner', 'fsn1');
    expect(entry).not.toBeNull();
    expect(entry).toEqual(REGION_GEO_REGISTRY.hetzner!.fsn1!);
  });

  test('is case- and whitespace-insensitive on both provider and region', () => {
    const entry = resolveRegionGeo('  Hetzner  ', ' FSN1 ');
    expect(entry).toEqual(REGION_GEO_REGISTRY.hetzner!.fsn1!);
  });

  test('an unrecognized provider resolves to null, never a guess', () => {
    expect(resolveRegionGeo('some-unlisted-provider', 'anywhere')).toBeNull();
  });

  test('a recognized provider with an unrecognized region resolves to null', () => {
    expect(resolveRegionGeo('hetzner', 'not-a-real-region')).toBeNull();
  });

  test('a null provider resolves to null', () => {
    expect(resolveRegionGeo(null, 'fsn1')).toBeNull();
  });

  test('a null region on a real provider resolves to null (never guesses a default region)', () => {
    expect(resolveRegionGeo('hetzner', null)).toBeNull();
  });

  test("the home/lan convention resolves to HOME_MARKER's current value, by provider", () => {
    expect(resolveRegionGeo('home', null)).toBe(HOME_MARKER);
    expect(resolveRegionGeo('HOME', null)).toBe(HOME_MARKER);
  });

  test('the home/lan convention resolves by region too, on any provider string', () => {
    expect(resolveRegionGeo('my-nas', 'lan')).toBe(HOME_MARKER);
  });

  test('HOME_MARKER defaults to null — an unset home network is honestly Unplaced, never a guessed coordinate', () => {
    expect(HOME_MARKER).toBeNull();
  });

  test('every seeded registry entry has finite, in-range coordinates and a non-empty label', () => {
    for (const [provider, regions] of Object.entries(REGION_GEO_REGISTRY)) {
      for (const [region, entry] of Object.entries(regions)) {
        expect(Number.isFinite(entry.lat)).toBe(true);
        expect(entry.lat).toBeGreaterThanOrEqual(-90);
        expect(entry.lat).toBeLessThanOrEqual(90);
        expect(Number.isFinite(entry.lon)).toBe(true);
        expect(entry.lon).toBeGreaterThanOrEqual(-180);
        expect(entry.lon).toBeLessThanOrEqual(180);
        expect(entry.label.length).toBeGreaterThan(0);
        // Sanity: the region key is reachable through the public resolver too.
        expect(resolveRegionGeo(provider, region)).toEqual(entry);
      }
    }
  });
});
