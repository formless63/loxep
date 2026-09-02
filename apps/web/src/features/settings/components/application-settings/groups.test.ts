/**
 * Unit tests for `/settings/application`'s grouping metadata (loxep-8ja.3,
 * settings-ux-design.md §3 "Grouping/navigation redesign"). Run with Bun's
 * built-in test runner, matching `setting-schema-form.test.ts`'s precedent:
 * `bun test apps/web/src/features/settings/components/application-settings/groups.test.ts`.
 *
 * Cross-checks the grouping against the REAL registry (`@loxep/domain`'s
 * `registeredApplicationSettings`, 19 settings as of this writing) rather
 * than only against this module's own literals, so a drift between the
 * domain's registry and this page's grouping — a new setting the page never
 * places anywhere, a key renamed on one side but not the other — fails here
 * instead of only being caught by eye on the rendered page.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { registeredApplicationSettings } from '@loxep/domain';
import { mapSettingJsonSchema } from '../../lib/setting-schema-form.ts';
import {
  ADVANCED_REGISTERED_KEYS,
  APPLICATION_SETTINGS_GROUPED_KEYS,
  APPLICATION_SETTINGS_GROUPS,
  MANAGED_ELSEWHERE_SETTINGS,
  PROVISIONING_LINK
} from './groups.ts';

/** The 13 class (a) keys, settings-ux-design.md §1 rows 1-13. */
const EXPECTED_CLASS_A_KEYS = [
  'monitors.defaults',
  'monitors.observation_caps',
  'integration.ebay.rate_budget',
  'integration.woo.rate_budget',
  'integration.cloudflare.rate_budget',
  'integration.gatus.rate_budget',
  'commerce.order_payload_retention',
  'infrastructure.caa_policy',
  'documents.media_limits',
  'inventory.media_limits',
  'inventory.default_sale_mode',
  'documents.parser_id',
  'auth.onboarding_oidc_prompt_dismissed'
].toSorted();

describe('APPLICATION_SETTINGS_GROUPS', () => {
  test('covers exactly the 13 class (a) settings, no duplicates', () => {
    expect(APPLICATION_SETTINGS_GROUPED_KEYS.toSorted()).toEqual(EXPECTED_CLASS_A_KEYS);
    expect(new Set(APPLICATION_SETTINGS_GROUPED_KEYS).size).toBe(
      APPLICATION_SETTINGS_GROUPED_KEYS.length
    );
  });

  test('every grouped key is a registered setting whose REAL schema maps generically — proves it is actually class (a), not merely labeled so', () => {
    const byKey = new Map(registeredApplicationSettings.map((setting) => [setting.key, setting]));
    for (const key of APPLICATION_SETTINGS_GROUPED_KEYS) {
      const setting = byKey.get(key);
      expect(setting).toBeDefined();
      const shape = mapSettingJsonSchema(z.toJSONSchema(setting!.schema));
      expect(shape.kind).not.toBe('unmappable');
    }
  });

  test('no group is empty, and every heading is unique', () => {
    expect(APPLICATION_SETTINGS_GROUPS.length).toBeGreaterThan(0);
    for (const group of APPLICATION_SETTINGS_GROUPS) {
      expect(group.keys.length).toBeGreaterThan(0);
    }
    const headings = APPLICATION_SETTINGS_GROUPS.map((group) => group.heading);
    expect(new Set(headings).size).toBe(headings.length);
  });

  test('"Provider rate budgets" holds all four identically-shaped rate budgets — the design\'s own clearest proof case', () => {
    const group = APPLICATION_SETTINGS_GROUPS.find(
      (entry) => entry.heading === 'Provider rate budgets'
    );
    expect(group?.keys).toEqual([
      'integration.ebay.rate_budget',
      'integration.woo.rate_budget',
      'integration.cloudflare.rate_budget',
      'integration.gatus.rate_budget'
    ]);
  });
});

describe('class (b)/(c) settings never leak onto the generic-form grouping', () => {
  test('record-shaped, hand-built-composite, and opaque-map settings are excluded from the grouped keys', () => {
    const excluded = [
      'infrastructure.gatus_push',
      'auth.provisioning',
      'infrastructure.provider_write_policy',
      'integrations.enabled',
      'infrastructure.ip_aliases',
      'integration.tailscale.ignored_devices'
    ];
    for (const key of excluded) {
      expect(APPLICATION_SETTINGS_GROUPED_KEYS).not.toContain(key);
    }
  });
});

describe('every registered setting is reachable somewhere on the rebuilt page', () => {
  test('grouped + managed-elsewhere + the provisioning link + advanced + the inline gatus-push card account for all 19 registered settings', () => {
    const accountedFor = new Set([
      ...APPLICATION_SETTINGS_GROUPED_KEYS,
      ...MANAGED_ELSEWHERE_SETTINGS.map((entry) => entry.key),
      PROVISIONING_LINK.key,
      ...ADVANCED_REGISTERED_KEYS,
      // Rendered inline, unchanged, via <GatusPushCard /> — not data-driven
      // through any exported key list, so it is named explicitly here.
      'infrastructure.gatus_push'
    ]);

    const registeredKeys = registeredApplicationSettings.map((setting) => setting.key);
    expect(registeredKeys.length).toBe(19);
    for (const key of registeredKeys) {
      expect(accountedFor.has(key)).toBe(true);
    }
    expect(accountedFor.size).toBe(19);
  });
});

describe('MANAGED_ELSEWHERE_SETTINGS', () => {
  test('points each record-shaped setting at its real editing surface, never a form', () => {
    expect(MANAGED_ELSEWHERE_SETTINGS).toEqual([
      {
        key: 'infrastructure.provider_write_policy',
        to: '/settings/connections',
        label: 'Edit per-connection on Connections'
      },
      {
        key: 'integrations.enabled',
        to: '/settings/integrations',
        label: 'Edit per-provider on Integrations'
      },
      {
        key: 'infrastructure.ip_aliases',
        to: '/infrastructure/aliases',
        label: 'Edit on IP aliases'
      }
    ]);
  });
});

describe('PROVISIONING_LINK', () => {
  test('links to /settings/users rather than duplicating ProvisioningCard onto this page', () => {
    expect(PROVISIONING_LINK).toEqual({
      key: 'auth.provisioning',
      to: '/settings/users',
      label: 'Edit on Users'
    });
  });
});
