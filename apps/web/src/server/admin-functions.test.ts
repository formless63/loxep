/**
 * Unit tests for pure helpers in `admin-functions.ts` (loxep-hb7 §1.7 /
 * loxep-rf4 scope (b); loxep-8ja.1). Run with Bun's built-in test runner,
 * matching the sibling `finance-billing.test.ts` precedent:
 * `bun test apps/web/src/server/admin-functions.test.ts`.
 *
 * `normalizeFleetBaseUrl` backs the Beszel and Dockhand `createStoreConnection`
 * branches. Dockhand is the case that matters: its adapter appends its own
 * `/api/...` path onto `connections.config.dockhand.baseUrl`, so an operator
 * who pastes the instance's API root (`.../api`) rather than its site root
 * must not end up with that path doubled.
 *
 * `settingJsonSchema` backs `RegisteredSettingDto.jsonSchema`
 * (settings-ux-design.md §2.1) — both `fetchApplicationSettings` and
 * `updateApplicationSetting` themselves need a real DB/session (they call
 * `requireSession`/`requireAdmin` via `@/server/admin`), so this exercises
 * the pure conversion they both delegate to instead.
 */
import { describe, expect, test } from 'bun:test';
import { registeredApplicationSettings } from '@loxep/domain';
import { normalizeFleetBaseUrl } from './admin-functions.ts';
import { settingJsonSchema } from './setting-json-schema.server.ts';

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

describe('settingJsonSchema', () => {
  test('converts every registered setting key without throwing', () => {
    for (const definition of registeredApplicationSettings) {
      expect(() => settingJsonSchema(definition.key)).not.toThrow();
    }
  });

  test('returns plain, JSON-serializable data', () => {
    for (const definition of registeredApplicationSettings) {
      const jsonSchema = settingJsonSchema(definition.key);
      expect(() => JSON.stringify(jsonSchema)).not.toThrow();
      expect(typeof jsonSchema).toBe('object');
    }
  });

  test('throws loudly for a key nothing registered, rather than shipping a fake schema', () => {
    expect(() => settingJsonSchema('not.a.registered.setting')).toThrow();
  });

  test('an object-shaped setting converts to a JSON Schema object with properties', () => {
    const jsonSchema = settingJsonSchema('monitors.observation_caps') as {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
    };
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties?.watchlistItemsPerPoll?.type).toBe('integer');
    expect(jsonSchema.properties?.watchlistItemsPerPoll?.description).toBeTruthy();
  });

  test('a bare (non-object) setting converts to a bare JSON Schema, not an object wrapper', () => {
    const jsonSchema = settingJsonSchema('auth.onboarding_oidc_prompt_dismissed') as {
      type?: string;
    };
    expect(jsonSchema.type).toBe('boolean');
  });
});
