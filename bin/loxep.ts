#!/usr/bin/env node
/**
 * Loxep runtime entrypoint (ADR-0018).
 *
 *   loxep migrate               apply pending database migrations (advisory-locked)
 *   loxep start [--mode=MODE]   start the application; MODE overrides LOXEP_MODE
 *
 * Every mode is one Node.js process. `all` runs the web runtime with the
 * worker embedded in-process; `web` omits the worker; `worker` omits the web
 * listener and serves the health contract on LOXEP_PORT instead. Normal
 * startup never mutates schema: an unmigrated database fails readiness with a
 * clear diagnostic, and readiness recovers without restart once `loxep
 * migrate` completes.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadBootstrapConfig, describeConfigForLog, type BootstrapConfig, type LoxepMode } from '@loxep/config';
import { createLogger } from '@loxep/observability';
import {
  initRuntimeState,
  setComponentStatus,
  registerHealthCheck,
  startHealthServer,
  startEmbeddedWorker,
  type EmbeddedWorker,
} from '@loxep/runtime';

type Logger = ReturnType<typeof createLogger>;

function parseArgs(argv: string[]): { command: string; mode?: LoxepMode } {
  const [command, ...rest] = argv;
  let mode: LoxepMode | undefined;
  for (const arg of rest) {
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'all' && value !== 'web' && value !== 'worker') {
        throw new Error(`invalid --mode "${value}" (expected all | web | worker)`);
      }
      mode = value;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { command: command ?? 'help', mode };
}

function loadConfigOrExit(modeOverride?: LoxepMode): BootstrapConfig {
  const env: Record<string, string | undefined> = { ...process.env };
  if (modeOverride) env['LOXEP_MODE'] = modeOverride;
  try {
    return loadBootstrapConfig(env);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }
}

async function commandMigrate(): Promise<void> {
  // Migration needs database + keyring facts only; loading at worker-level
  // requirements keeps `loxep migrate` runnable without web-serving env.
  const config = loadConfigOrExit('worker');
  const logger = createLogger({ level: config.logLevel });
  const { runMigrations } = await import('@loxep/db/migrate');
  const result = await runMigrations({ databaseUrl: config.databaseUrl, logger });
  logger.info({ applied: result.applied }, 'migration run complete');
}

async function registerDatabaseChecks(config: BootstrapConfig, logger: Logger): Promise<void> {
  const { createDb, checkMigrationState } = await import('@loxep/db');
  const { pool } = createDb(config.databaseUrl);

  registerHealthCheck('database', async () => {
    try {
      await pool.query('select 1');
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  registerHealthCheck('migrations', async () => {
    try {
      const state = await checkMigrationState(config.databaseUrl);
      return state.upToDate
        ? { ok: true }
        : { ok: false, detail: `database is behind by ${state.pending} migration(s); run "loxep migrate"` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  const initial = await checkMigrationState(config.databaseUrl).catch((error: unknown) => {
    logger.error({ err: error }, 'could not verify migration state at startup');
    return null;
  });
  if (initial && !initial.upToDate) {
    logger.error(
      { pending: initial.pending },
      'database schema is behind; readiness will fail until "loxep migrate" is run (startup never migrates, ADR-0018)',
    );
  }
}

async function startWebRuntime(config: BootstrapConfig, logger: Logger): Promise<void> {
  // The built Nitro node-server entry reads PORT/HOST at import time and
  // starts listening; importing it inside this process keeps ADR-0018's
  // one-process contract.
  process.env['PORT'] = String(config.port);
  process.env['NITRO_PORT'] = String(config.port);
  process.env['HOST'] = '0.0.0.0';
  const entry =
    process.env['LOXEP_SERVER_ENTRY'] ?? resolve(import.meta.dirname, '../apps/web/.output/server/index.mjs');
  await import(pathToFileURL(entry).href);
  setComponentStatus('web', { ok: true });
  logger.info({ port: config.port }, 'web runtime started');
}

async function commandStart(modeOverride?: LoxepMode): Promise<void> {
  const config = loadConfigOrExit(modeOverride);
  const logger = createLogger({ level: config.logLevel });
  initRuntimeState(config.mode);
  logger.info(describeConfigForLog(config), 'starting loxep');

  await registerDatabaseChecks(config, logger);

  let worker: EmbeddedWorker | undefined;
  if (config.mode === 'all' || config.mode === 'worker') {
    worker = startEmbeddedWorker({ logger });
  }
  if (config.mode === 'all' || config.mode === 'web') {
    await startWebRuntime(config, logger);
  } else {
    await startHealthServer({ port: config.port, logger });
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void (worker ? worker.stop() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const { command, mode } = parseArgs(process.argv.slice(2));
switch (command) {
  case 'migrate':
    await commandMigrate();
    process.exit(0);
    break;
  case 'start':
    await commandStart(mode);
    break;
  default:
    console.error('usage: loxep <migrate | start [--mode=all|web|worker]>');
    process.exit(command === 'help' ? 0 : 2);
}
