import { getRuntimeState, type CheckResult } from './state.ts';

export interface HealthReport {
  status: 'ok' | 'unready';
  mode: string;
  uptimeSeconds: number | null;
  components: Record<string, CheckResult>;
  checks: Record<string, CheckResult>;
}

/**
 * Liveness: the process and event loop are functioning. Reaching this code at
 * all is the proof; no dependency checks belong here (ADR-0018).
 */
export function liveness(): { status: 'ok' } {
  return { status: 'ok' };
}

/**
 * Readiness: every initialized component reports ok and every registered
 * dependency check passes. Degraded-but-operational conditions belong in the
 * detail payload, not in the status code (ADR-0018).
 *
 * Outside an entrypoint-managed process (vite dev), there is no runtime state;
 * readiness degrades to "ok" so local development is not gated on bin/loxep.
 */
export async function readiness(): Promise<HealthReport> {
  const state = getRuntimeState();
  if (!state) {
    return {
      status: 'ok',
      mode: 'dev',
      uptimeSeconds: null,
      components: {},
      checks: {},
    };
  }

  const components = Object.fromEntries(state.components);
  const checks: Record<string, CheckResult> = {};
  for (const [name, check] of state.checks) {
    try {
      checks[name] = await check();
    } catch (error) {
      checks[name] = {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const allOk =
    Object.values(components).every((component) => component.ok) &&
    Object.values(checks).every((check) => check.ok);

  return {
    status: allOk ? 'ok' : 'unready',
    mode: state.mode,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    components,
    checks,
  };
}

export function readinessHttpStatus(report: HealthReport): number {
  return report.status === 'ok' ? 200 : 503;
}
