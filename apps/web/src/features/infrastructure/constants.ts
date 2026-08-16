import type { Tone } from '@/features/settings/components/status-tone';

/** `managed_domains.state` — the provisioning chain, which only ever advances. */
export const MANAGED_DOMAIN_STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  zone_created: 'Zone created',
  awaiting_delegation: 'Awaiting delegation',
  zone_active: 'Zone active',
  records_synced: 'Records synced',
  mail_pending: 'Mail pending',
  ready: 'Ready'
};

export const MANAGED_DOMAIN_STATE_TONE: Record<string, Tone> = {
  draft: 'secondary',
  zone_created: 'secondary',
  awaiting_delegation: 'warning',
  zone_active: 'secondary',
  records_synced: 'secondary',
  mail_pending: 'secondary',
  ready: 'success'
};

export const MANAGED_DOMAIN_STATE_OPTIONS = Object.entries(MANAGED_DOMAIN_STATE_LABELS).map(
  ([value, label]) => ({ value, label })
);

/** `hosting_targets.control_surface` — a Loxep-owned taxonomy of how (or whether) a name can be reached. */
export const CONTROL_SURFACE_LABELS: Record<string, string> = {
  proxy_node: 'Proxy node',
  tunnel_client: 'Tunnel client',
  direct_reverse_proxy: 'Direct / reverse proxy',
  none: 'DNS only'
};

export const CONTROL_SURFACE_OPTIONS = Object.entries(CONTROL_SURFACE_LABELS).map(
  ([value, label]) => ({ value, label })
);

/** `dns_drift_findings.kind`. */
export const DRIFT_KIND_LABELS: Record<string, string> = {
  missing: 'Missing at provider',
  modified: 'Modified at provider',
  unexpected: 'Unexpected at provider'
};

export const DRIFT_KIND_TONE: Record<string, Tone> = {
  missing: 'warning',
  modified: 'warning',
  unexpected: 'destructive'
};

/** `reconcile_runs.status`. */
export const RUN_STATUS_TONE: Record<string, Tone> = {
  running: 'secondary',
  succeeded: 'success',
  failed: 'destructive',
  partial: 'warning'
};

/** `reconcile_runs.mode` — the drift/apply switch, stored. */
export const RUN_MODE_LABELS: Record<string, string> = {
  apply: 'Apply',
  check: 'Check (drift only)'
};

/** `dns_provider_tokens.permission_scope` — one value today. */
export const DNS_PROVIDER_TOKEN_SCOPE_OPTIONS = [{ value: 'dns_edit', label: 'DNS edit' }];

/** `infrastructure.ip_aliases[name].source` (Pangolin chain design M5, loxep-acj.5) — ranked by how much Loxep has to trust the detector. */
export const IP_ALIAS_SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual',
  dns: 'DNS lookup',
  pangolin_site: 'Pangolin site'
};

export const IP_ALIAS_SOURCE_OPTIONS = Object.entries(IP_ALIAS_SOURCE_LABELS).map(
  ([value, label]) => ({ value, label })
);

/** `provisioning_template_steps.step_kind` / `template_run_steps.step_kind` — the closed seven (Pangolin chain design M6, loxep-acj.6). */
export const PROVISIONING_STEP_KIND_LABELS: Record<string, string> = {
  'domain.declare': 'Declare domain',
  'dns.point-at-target': 'Point DNS at target',
  'dns.manual-record': 'Add manual DNS record',
  'proxy.ensure-resource': 'Ensure Pangolin resource',
  'proxy.ensure-rules': 'Ensure Pangolin rules',
  'mail.enable': 'Enable mail',
  'mail.ensure-mailbox': 'Ensure mailbox'
};

/** `template_run_steps.status` — `'blocked'` is first-class, never a silent skip and never conflated with `'failed'`. */
export const TEMPLATE_RUN_STEP_STATUS_TONE: Record<string, Tone> = {
  pending: 'secondary',
  running: 'secondary',
  succeeded: 'success',
  blocked: 'warning',
  failed: 'destructive',
  skipped: 'secondary'
};

export const TEMPLATE_RUN_STEP_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  blocked: 'Blocked',
  failed: 'Failed',
  skipped: 'Skipped'
};

/**
 * `template_run_steps.blocked_reason` — an OPEN taxonomy (see
 * `provisioning.ts`'s own doc), so this map is a best-effort label set, never
 * exhaustive; an unknown reason falls back to the raw code.
 */
export const TEMPLATE_BLOCKED_REASON_LABELS: Record<string, string> = {
  credential_scope: 'Write policy',
  zone_not_found: 'No Cloudflare zone',
  org_domain_not_found: 'No Pangolin org domain',
  no_proxy_connection: 'No proxy connection linked',
  awaiting_delegation: 'Awaiting DNS delegation',
  ownership_not_yet_provable: 'Ownership not yet provable',
  mail_disabled: 'Mail not enabled'
};
