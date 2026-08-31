#!/usr/bin/env node
/**
 * Loxep runtime entrypoint (ADR-0018).
 *
 *   loxep migrate               apply pending database migrations (advisory-locked)
 *   loxep start [--mode=MODE]   start the application; MODE overrides LOXEP_MODE
 *   loxep admin promote --email=EMAIL   grant the admin role to an existing user
 *   loxep admin list                    print id/email/role for every user
 *
 * `loxep admin` is the shell-level first-admin recovery path
 * (configuration-and-secrets.md "First administrator and recovery"): a
 * deployment owner with server access can promote or inspect users directly
 * against the database, with no web backdoor. It loads worker-level
 * configuration only, so recovery never requires web-serving env facts.
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

/**
 * Fail fast if another process already holds the web port (loxep-ysb).
 * The Nitro entry's server layer (srvx) swallows its own listen
 * error — `this.serve().catch(() => {})` — so without this probe a second
 * `loxep start` on a bound port logs "web runtime started", holds NO
 * listener, and (in mode=all) keeps running its worker against its own
 * database while every HTTP request lands on the other process. The bound
 * socket itself is exclusive (srvx passes `exclusive: true`, i.e. no
 * SO_REUSEPORT), so a probe bind here is a faithful preflight of the bind
 * Nitro is about to make.
 */
async function assertPortFree(port: number, host: string): Promise<void> {
  const net = await import('node:net');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const probe = net.createServer();
    probe.once('error', (error) => rejectPromise(error));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolvePromise());
    });
  });
}

async function startWebRuntime(config: BootstrapConfig, logger: Logger): Promise<void> {
  // The built Nitro node-server entry reads PORT/HOST at import time and
  // starts listening; importing it inside this process keeps ADR-0018's
  // one-process contract.
  process.env['PORT'] = String(config.port);
  process.env['NITRO_PORT'] = String(config.port);
  process.env['HOST'] = '0.0.0.0';
  try {
    await assertPortFree(config.port, '0.0.0.0');
  } catch (error) {
    logger.error(
      { err: error, port: config.port },
      'web port is not bindable; refusing to start (another loxep process is likely already listening)',
    );
    process.exit(1);
  }
  const entry =
    process.env['LOXEP_SERVER_ENTRY'] ?? resolve(import.meta.dirname, '../apps/web/.output/server/index.mjs');
  await import(pathToFileURL(entry).href);
  setComponentStatus('web', { ok: true });
  logger.info({ port: config.port }, 'web runtime started');
}

/**
 * Shell-level admin recovery (`loxep admin promote|list`). Returns the
 * process exit code: 0 success, 1 user not found, 2 usage/config error.
 * Role updates write the Better Auth `user.role` column directly via
 * `@loxep/db`; the running application observes the change on the user's
 * next session read.
 */
async function commandAdmin(args: string[]): Promise<number> {
  const usage = 'usage: loxep admin <promote --email=EMAIL | list>';
  const [subcommand, ...rest] = args;
  if (subcommand !== 'promote' && subcommand !== 'list') {
    console.error(usage);
    return 2;
  }
  let email: string | undefined;
  for (const arg of rest) {
    if (subcommand === 'promote' && arg.startsWith('--email=')) {
      email = arg.slice('--email='.length);
    } else {
      console.error(`unknown argument "${arg}"\n${usage}`);
      return 2;
    }
  }
  if (subcommand === 'promote' && (email === undefined || email === '')) {
    console.error(`loxep admin promote requires --email=EMAIL\n${usage}`);
    return 2;
  }

  // Worker-level config: recovery needs database facts only, never
  // web-serving configuration.
  const config = loadConfigOrExit('worker');
  const { createDb, closeDb } = await import('@loxep/db');
  const handle = createDb(config.databaseUrl);
  try {
    if (subcommand === 'list') {
      const result = await handle.pool.query<{ id: string; email: string; role: string | null }>(
        'select id, email, role from "user" order by created_at asc',
      );
      if (result.rows.length === 0) {
        console.log('loxep admin: no users exist yet');
      }
      for (const row of result.rows) {
        console.log(`${row.id}\t${row.email}\t${row.role ?? 'member'}`);
      }
      return 0;
    }
    const updated = await handle.pool.query<{ id: string; email: string }>(
      `update "user" set role = 'admin' where lower(email) = lower($1) returning id, email`,
      [email],
    );
    const row = updated.rows[0];
    if (!row) {
      console.error(
        `loxep admin promote: no user found with email "${email}" — users must sign in once before they can be promoted`,
      );
      return 1;
    }
    console.log(`loxep admin promote: granted role 'admin' to ${row.email} (user ${row.id})`);
    return 0;
  } finally {
    await closeDb(handle);
  }
}

async function commandStart(modeOverride?: LoxepMode): Promise<void> {
  const config = loadConfigOrExit(modeOverride);
  const logger = createLogger({ level: config.logLevel });
  initRuntimeState(config.mode);
  logger.info(describeConfigForLog(config), 'starting loxep');

  await registerDatabaseChecks(config, logger);

  let worker: EmbeddedWorker | undefined;
  if (config.mode === 'all' || config.mode === 'worker') {
    worker = await startEmbeddedWorker({
      logger,
      databaseUrl: config.databaseUrl,
      // The composition root is loaded ONLY by worker-capable modes; the
      // import lives inside the callback so `LOXEP_MODE=web` never pulls in
      // graphile-worker or the provider integrations.
      //
      // The composition package is a direct repo-root workspace dependency,
      // so the runtime can load it by package name without depending on Bun's
      // incidental workspace hoisting layout.
      buildRegistry: async () => {
        const { buildWorkerRegistry } = await import('@loxep/app');
        return buildWorkerRegistry({ config, logger });
      },
    });
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

const argv = process.argv.slice(2);
if (argv[0] === 'admin') {
  process.exit(await commandAdmin(argv.slice(1)));
}
const { command, mode } = parseArgs(argv);
switch (command) {
  case 'migrate':
    await commandMigrate();
    process.exit(0);
    break;
  case 'start':
    await commandStart(mode);
    break;
  default:
    console.error(
      'usage: loxep <migrate | start [--mode=all|web|worker] | admin <promote --email=EMAIL | list>>',
    );
    process.exit(command === 'help' ? 0 : 2);
}
