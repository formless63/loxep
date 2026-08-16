/**
 * Grouping metadata for `/settings/application`'s class (a) settings
 * (loxep-8ja.3, settings-ux-design.md §3 "Grouping/navigation redesign").
 * Plain data, not components — so the grouping itself (every class (a)
 * setting placed in exactly one heading, matching the design's own
 * inventory table) is unit-testable without mounting the page.
 *
 * Keys are plain string literals, never `@loxep/domain` value imports: that
 * package's setting objects stay server-side only (settings-ux-design.md
 * §2.1) — a key here is the same bare string every `RegisteredSettingDto.key`
 * already is, matching the precedent the loxep-8ja.2 proof-of-concept set
 * (`documents.parser_id` as a literal, not an import).
 *
 * `Auth & provisioning` and `Infrastructure` list only the ONE class (a) key
 * each group owns — `index.tsx` renders each heading's class (b) neighbor
 * (the linked `auth.provisioning`/`ProvisioningCard`, the inline
 * `infrastructure.gatus_push`/`GatusPushCard`) alongside it by hand, per
 * this bead's own instruction that a class (b) form keeps or links to where
 * it already lives rather than being duplicated onto this page.
 */
export interface ApplicationSettingsGroup {
  heading: string;
  keys: string[];
}

export const APPLICATION_SETTINGS_GROUPS: ApplicationSettingsGroup[] = [
  {
    heading: 'Marketplace polling',
    keys: ['monitors.defaults', 'monitors.observation_caps']
  },
  {
    heading: 'Provider rate budgets',
    keys: [
      'integration.ebay.rate_budget',
      'integration.woo.rate_budget',
      'integration.cloudflare.rate_budget',
      'integration.gatus.rate_budget'
    ]
  },
  {
    heading: 'Uploads',
    keys: ['documents.media_limits', 'inventory.media_limits']
  },
  {
    heading: 'Documents & inventory',
    keys: ['documents.parser_id', 'inventory.default_sale_mode']
  },
  {
    heading: 'Commerce',
    keys: ['commerce.order_payload_retention']
  },
  {
    heading: 'Auth & provisioning',
    keys: ['auth.onboarding_oidc_prompt_dismissed']
  },
  {
    heading: 'Infrastructure',
    keys: ['infrastructure.caa_policy']
  }
];

/** Every class (a) key across every group, flattened, in group-then-declaration order. */
export const APPLICATION_SETTINGS_GROUPED_KEYS: string[] = APPLICATION_SETTINGS_GROUPS.flatMap(
  (group) => group.keys
);

/**
 * The two record-shaped settings whose keys come from a foreign list this
 * page has no access to (settings-ux-design.md §1 rows 16-17) — rendered as
 * plain link rows under the "Managed elsewhere" heading, never a form.
 */
export const MANAGED_ELSEWHERE_SETTINGS: {
  key: string;
  to: string;
  label: string;
}[] = [
  {
    key: 'infrastructure.provider_write_policy',
    to: '/settings/connections',
    label: 'Edit per-connection on Connections'
  },
  {
    key: 'integrations.enabled',
    to: '/settings/integrations',
    label: 'Edit per-provider on Integrations'
  }
];

/**
 * `auth.provisioning`'s reference form (`ProvisioningCard`) already lives on
 * `/settings/users` — this page links to it rather than duplicating the
 * whole composite a second time (this bead's own instruction: "link, don't
 * duplicate").
 */
export const PROVISIONING_LINK = {
  key: 'auth.provisioning',
  to: '/settings/users',
  label: 'Edit on Users'
};

/**
 * Registered settings with no dedicated UI of their own yet, kept reachable
 * through the collapsed "Advanced" raw-JSON fallback (settings-ux-design.md
 * §3's last paragraph) rather than disappearing from the page entirely:
 * `integration.tailscale.ignored_devices` permanently (class c — the real
 * editing affordance is the fleet page's "Ignore" action, not a form here),
 * `infrastructure.ip_aliases` until its dedicated CRUD surface ships
 * (loxep-8ja.5, independent of this bead).
 */
export const ADVANCED_REGISTERED_KEYS: string[] = [
  'integration.tailscale.ignored_devices',
  'infrastructure.ip_aliases'
];
