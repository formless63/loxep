/**
 * Unit tests for the pure normalization helper in `admin-functions.ts`
 * (loxep-hb7 §1.7 / loxep-rf4 scope (b)). Run with Bun's built-in test
 * runner, matching the sibling `finance-billing.test.ts` precedent:
 * `bun test apps/web/src/server/admin-functions.test.ts`.
 *
 * `normalizeFleetBaseUrl` backs the Beszel and Dockhand `createStoreConnection`
 * branches. Dockhand is the case that matters: its adapter appends its own
 * `/api/...` path onto `connections.config.dockhand.baseUrl`, so an operator
 * who pastes the instance's API root (`.../api`) rather than its site root
 * must not end up with that path doubled.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeFleetBaseUrl } from './admin-functions.ts';

describe('normalizeFleetBaseUrl', () => {
  test('strips a trailing /api segment down to the origin', () => {
    expect(normalizeFleetBaseUrl('https://dockhand.example.com/api')).toBe(
      'https://dockhand.example.com'
    );
  });

  test('strips a trailing /api/ segment (with slash) down to the origin', () => {
    expect(normalizeFleetBaseUrl('https://dockhand.example.com/api/')).toBe(
      'https://dockhand.example.com'
    );
  });

  test('never doubles /api when the pasted URL already ends in it', () => {
    const normalized = normalizeFleetBaseUrl('https://dockhand.example.com/api');
    expect(normalized).not.toContain('/api/api');
    expect(normalized.endsWith('/api')).toBe(false);
  });

  test('leaves a bare origin unchanged', () => {
    expect(normalizeFleetBaseUrl('https://dockhand.example.com')).toBe(
      'https://dockhand.example.com'
    );
  });

  test('preserves a non-standard port', () => {
    expect(normalizeFleetBaseUrl('https://dockhand.example.com:8443/api')).toBe(
      'https://dockhand.example.com:8443'
    );
  });

  test('drops any other path, not only /api, since the origin is the whole config value', () => {
    expect(normalizeFleetBaseUrl('https://beszel.example.com/some/deep/path')).toBe(
      'https://beszel.example.com'
    );
  });

  test('is idempotent — normalizing an already-normalized origin is a no-op', () => {
    const once = normalizeFleetBaseUrl('https://dockhand.example.com/api');
    const twice = normalizeFleetBaseUrl(once);
    expect(twice).toBe(once);
  });
});
