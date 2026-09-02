/**
 * Server-side Better Auth singleton for the web app.
 *
 * Built lazily on first use from bootstrap configuration (ADR-0016) +
 * `createDb` + `createAuth` (ADR-0007, ADR-0020). The instance is stored in a
 * process-global registry keyed by `Symbol.for()` — the same pattern as
 * `@loxep/runtime`'s state module — because the vite dev server and the
 * production Nitro bundle can each carry their own copy of this module inside
 * one Node process; `globalThis` is the one namespace both copies share.
 *
 * This module is server-only. Route/server-function code must reach it via
 * dynamic import inside handlers so nothing here leaks into the client bundle.
 */
import '@tanstack/react-start/server-only';

import { loadBootstrapConfig, BootstrapConfigError, type BootstrapConfig } from '@loxep/config';
import { createAuth, type LoxepAuth } from '@loxep/auth';
import { createDb, type DbHandle } from '@loxep/db';

interface AuthRegistry {
  config: BootstrapConfig;
  auth: LoxepAuth;
  db: DbHandle;
}

const REGISTRY_KEY = Symbol.for('loxep.web.auth');

type GlobalWithAuthRegistry = typeof globalThis & { [REGISTRY_KEY]?: AuthRegistry };

function buildRegistry(): AuthRegistry {
  let config: BootstrapConfig;
  try {
    config = loadBootstrapConfig(process.env);
  } catch (error) {
    if (error instanceof BootstrapConfigError) {
      throw new Error(
        'Loxep bootstrap configuration is missing or invalid — authentication cannot start. ' +
          'For local development copy the repo-root .env.example to a .env with real values ' +
          '(see apps/web/env.example.txt for the required LOXEP_* variables).\n' +
          error.message,
        { cause: error }
      );
    }
    throw error;
  }
  const db = createDb(config.databaseUrl);
  return { config, db, auth: createAuth({ config, db }) };
}

function getRegistry(): AuthRegistry {
  const globalWithRegistry = globalThis as GlobalWithAuthRegistry;
  return (globalWithRegistry[REGISTRY_KEY] ??= buildRegistry());
}

/** Lazy process-global Better Auth instance. Throws with a clear message when LOXEP_* env is absent. */
export function getAuth(): LoxepAuth {
  return getRegistry().auth;
}

/**
 * The database handle the auth instance itself runs on. Exposed so the
 * unauthenticated sign-in surface can read the account provisioning policy
 * (ADR-0024) without constructing a second pool or pulling in the whole
 * `/settings` service registry.
 */
export function getAuthDb(): DbHandle {
  return getRegistry().db;
}

/**
 * Which bootstrap login paths are configured — booleans only, no secrets.
 * The sign-in page uses this to decide which controls to render.
 */
export function getLoginPaths(): { magicLink: boolean; oidc: boolean } {
  const { config } = getRegistry();
  return { magicLink: config.smtp !== undefined, oidc: config.oidc !== undefined };
}
