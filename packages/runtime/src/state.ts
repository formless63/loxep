/**
 * Process-global runtime state shared between the Loxep entrypoint (bin/loxep)
 * and the bundled web application.
 *
 * The web bundle carries its own copy of this module, so module-level state
 * would fork between the entrypoint and the server bundle. A globalThis
 * registry keyed by Symbol.for() is the one namespace both module instances
 * share within the single Loxep process (ADR-0018: one process per mode).
 */

export type LoxepMode = 'all' | 'web' | 'worker';

export interface CheckResult {
  ok: boolean;
  detail?: string;
}

export type HealthCheck = () => Promise<CheckResult>;

export interface RuntimeState {
  mode: LoxepMode;
  startedAt: number;
  /** Components flip ready as the entrypoint initializes them (db, worker, web). */
  components: Map<string, CheckResult>;
  /** Readiness checks run on demand when /health/ready is queried. */
  checks: Map<string, HealthCheck>;
}

const REGISTRY_KEY = Symbol.for('loxep.runtime.state');

type GlobalWithRuntime = typeof globalThis & { [REGISTRY_KEY]?: RuntimeState };

export function initRuntimeState(mode: LoxepMode): RuntimeState {
  const state: RuntimeState = {
    mode,
    startedAt: Date.now(),
    components: new Map(),
    checks: new Map(),
  };
  (globalThis as GlobalWithRuntime)[REGISTRY_KEY] = state;
  return state;
}

/** Returns the active runtime state, or undefined when no entrypoint initialized one (e.g. vite dev). */
export function getRuntimeState(): RuntimeState | undefined {
  return (globalThis as GlobalWithRuntime)[REGISTRY_KEY];
}

export function setComponentStatus(name: string, result: CheckResult): void {
  getRuntimeState()?.components.set(name, result);
}

export function registerHealthCheck(name: string, check: HealthCheck): void {
  getRuntimeState()?.checks.set(name, check);
}
