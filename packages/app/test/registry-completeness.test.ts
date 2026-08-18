/**
 * **The guard for loxep-vdt's whole class of bug: a task name that is
 * enqueued but never registered.**
 *
 * Graphile Worker resolves a job by its identifier string. When a package
 * declares a task NAME, product code enqueues it, and nothing ever passes a
 * matching `defineTask` to `createTaskRegistry`, the failure is completely
 * silent from the outside: the enqueue succeeds, the transaction commits,
 * the UI shows a success toast, and the job quietly burns its whole retry
 * budget against a handler that does not exist. That is exactly what
 * happened to `infrastructure.materialize-records`,
 * `infrastructure.sync-records`, and `storage.migrate-object` — for months,
 * across three separate milestones, without a single test noticing.
 *
 * ## What this file asserts
 *
 * Every workspace package declares its task names as an exported constant
 * whose identifier ends in `_TASK` or `_TASK_NAME` — the convention holds
 * across `@loxep/app`, `@loxep/commerce`, `@loxep/domain`,
 * `@loxep/infrastructure`, `@loxep/market`, `@loxep/notifications`, and
 * `@loxep/storage`, without exception. So:
 *
 * ```text
 * {every *_TASK / *_TASK_NAME constant declared under packages/-/src}
 *   MINUS {every key in the composed worker registry}   ===   {}
 * ```
 *
 * ## Why the source is scanned rather than the package entry points
 *
 * Importing each package's index and reading its exports would be prettier,
 * and it would have MISSED this bug's worst case. `@loxep/infrastructure`
 * enqueues `MATERIALIZE_RECORDS_TASK` from inside its own `domains.ts` and
 * `mail-sync.ts`; a constant that never reaches a package's public entry
 * point is still perfectly capable of putting an unroutable job in the
 * queue. `@loxep/storage`'s task name lives behind a subpath export, and
 * `@loxep/domain`'s `NOTIFICATION_DELIVER_TASK` is re-exported under a
 * different identifier by `@loxep/notifications`. Scanning declarations is
 * the only view that sees all three shapes.
 *
 * The scan resolves the three declaration forms that occur in this
 * workspace: a single-line string literal, a wrapped string literal (the
 * formatter breaks long ones onto the next line), and an alias to another
 * constant (`DELIVER_TASK_NAME = NOTIFICATION_DELIVER_TASK`).
 *
 * ## There is no allow-list, deliberately
 *
 * A "known not registered yet" escape hatch is how this bug would come back:
 * the first entry always looks reasonable and nobody ever removes one. If a
 * task genuinely must not run yet, the honest move is the one loxep-vdt
 * applied — do not declare a name and enqueue it behind a success toast;
 * either wire the handler or delete the enqueue.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWorkerRegistry } from "../src/index.ts";
import type { WorkerComposition } from "../src/index.ts";
import { baseDatabaseUrl, silentJobsLogger, testConfig } from "./helpers.ts";

/** `packages/`, from this file. */
const packagesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** `export const NAME = "value";` and `export const NAME = OTHER;`, wrapped or not. */
const TASK_CONSTANT = /^export const ([A-Z0-9_]*TASK(?:_NAME)?)\s*=\s*$|^export const ([A-Z0-9_]*TASK(?:_NAME)?)\s*=\s*(.+?);?\s*$/;

interface TaskConstant {
  identifier: string;
  /** Repo-relative, for a failure message somebody can act on. */
  file: string;
  /** The string literal, or `null` while an alias is still unresolved. */
  value: string | null;
  /** The identifier this one aliases, when it is not a literal. */
  aliasOf: string | null;
}

function stringLiteral(raw: string): string | null {
  const match = /^["'`](.*)["'`]$/.exec(raw.trim().replace(/;$/, ""));
  return match?.[1] ?? null;
}

function sourceFiles(): string[] {
  const entries = readdirSync(packagesRoot, {
    recursive: true,
    encoding: "utf8",
  });
  return entries
    .filter(
      (entry) =>
        entry.endsWith(".ts") &&
        !entry.includes("node_modules") &&
        // Declarations live in `src`; a test fixture must never widen the
        // set this file checks.
        entry.split(path.sep).includes("src"),
    )
    .map((entry) => path.join(packagesRoot, entry));
}

/**
 * Every `*_TASK` / `*_TASK_NAME` constant declared under `packages/-/src`,
 * with aliases resolved to the literal they ultimately point at.
 */
export function declaredTaskConstants(): TaskConstant[] {
  const found: TaskConstant[] = [];

  for (const file of sourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    const relative = path.relative(path.join(packagesRoot, ".."), file);
    for (let index = 0; index < lines.length; index += 1) {
      const match = TASK_CONSTANT.exec(lines[index] ?? "");
      if (match === null) continue;
      // Group 1 matches the wrapped form (value is on the NEXT line);
      // group 2/3 match the single-line form.
      const identifier = match[1] ?? match[2];
      if (identifier === undefined) continue;
      const raw = match[1] !== undefined ? (lines[index + 1] ?? "") : (match[3] ?? "");
      const literal = stringLiteral(raw);
      found.push({
        identifier,
        file: relative,
        value: literal,
        aliasOf: literal === null ? raw.trim().replace(/;$/, "") : null,
      });
    }
  }

  const literalsByIdentifier = new Map(
    found
      .filter((entry): entry is TaskConstant & { value: string } => entry.value !== null)
      .map((entry) => [entry.identifier, entry.value]),
  );
  for (const entry of found) {
    if (entry.value !== null || entry.aliasOf === null) continue;
    entry.value = literalsByIdentifier.get(entry.aliasOf) ?? null;
  }
  return found;
}

let composition: WorkerComposition | undefined;

afterAll(async () => {
  await composition?.close();
});

describe("worker registry completeness", () => {
  it("finds the task-name constants across the workspace", () => {
    const constants = declaredTaskConstants();
    // A guard on the guard: if the scan silently stopped matching (a
    // formatter change, a moved directory), an empty or tiny result would
    // make every assertion below vacuously true.
    expect(constants.length).toBeGreaterThanOrEqual(25);
    expect(constants.map((entry) => entry.identifier)).toContain(
      "MATERIALIZE_RECORDS_TASK",
    );
    expect(constants.map((entry) => entry.identifier)).toContain(
      "STORAGE_MIGRATE_OBJECT_TASK_NAME",
    );
    // Every constant resolved to a real identifier string; an unresolved
    // alias would otherwise drop silently out of the set difference below.
    expect(
      constants.filter((entry) => entry.value === null).map((entry) => entry.identifier),
    ).toEqual([]);
    for (const entry of constants) {
      // `area.verb`, `@loxep/jobs`' own naming convention.
      expect(entry.value).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
    }
  });

  it("registers a handler for EVERY declared task name", () => {
    // No database work happens here: `buildWorkerRegistry` is a pure value
    // build (its own module doc — "nothing starts, connects, or polls until
    // `startWorkerRuntime` receives it"), so a pool is constructed and never
    // queried. That is what lets this guard stay a fast, unconditional check
    // rather than something gated on a scratch database.
    composition = buildWorkerRegistry({
      config: testConfig(baseDatabaseUrl),
      logger: silentJobsLogger,
    });
    const registered = new Set(composition.registry.keys());

    const unregistered = declaredTaskConstants()
      .filter((entry) => entry.value !== null && !registered.has(entry.value))
      .map((entry) => `${entry.value} (${entry.identifier}, ${entry.file})`)
      .sort();

    expect(
      unregistered,
      "every exported task-name constant must have a handler in " +
        "buildWorkerRegistry's createTaskRegistry call — an unregistered name " +
        "that product code enqueues burns its whole retry budget behind a " +
        "success toast (loxep-vdt). Wire the handler, or delete the enqueue " +
        "site and the constant.",
    ).toEqual([]);
  });

  it("keeps the three names loxep-vdt found registered, by value", () => {
    // Named explicitly as well as covered by the set difference above: these
    // are the regressions this bead closed, and a future refactor that
    // renamed a constant would otherwise pass the general check while
    // quietly dropping one of them.
    const registered = new Set(composition?.registry.keys() ?? []);
    expect(registered).toContain("infrastructure.materialize-records");
    expect(registered).toContain("infrastructure.sync-records");
    expect(registered).toContain("storage.migrate-object");
  });
});
