/**
 * THE acceptance-critical test for section 2's boundary, written per the
 * design's own instruction ("write the never-auto-commit test for party
 * creation first, in the shape `packages/documents/test/never-auto-
 * commit.test.ts` already established: prove that no code path reachable
 * from an integration package or a worker task inserts a `counterparties`
 * row").
 *
 * The falsifiable form, quoted from `expense-entry-design.md` section 2:
 * *"if `grep` finds an `insert into counterparties` reachable from
 * `packages/integrations/*` or from a Graphile Worker task, this rule has
 * been broken."*
 *
 * Unlike `@loxep/documents`' sibling test — which drives a real service
 * through real PostgreSQL and counts rows — this rule is a claim about a
 * CALL GRAPH across many packages, not about `@loxep/counterparties`'s own
 * behavior in isolation: this package cannot see whether some other
 * package's code happens to call `createCounterpartiesService(...).create`.
 * The only way to make the claim provable is structural, and it is provable
 * two independent ways that must BOTH hold:
 *
 * 1. **Declared-dependency check.** No `packages/integrations/*`,
 *    `packages/app` (the worker task/executor registry — Graphile Worker
 *    task handlers live here, e.g. `commerce-ebay.ts`, `refresh-tokens.ts`),
 *    or `packages/jobs` (the scheduler/dispatcher) `package.json` declares a
 *    dependency on `@loxep/counterparties`. In this Bun workspace, an
 *    undeclared package cannot be `import`ed at all — the module simply does
 *    not resolve — so this one check is load-bearing on its own.
 * 2. **Source-text check**, kept as a second, independent line of defense in
 *    case a future change threads a database handle through some other path
 *    (a shared `db` argument, a re-exported service) that bypasses package
 *    boundaries: no `.ts` source file under those same directories contains
 *    `insert(counterparties` / `insert(counterpartyContacts` /
 *    `insert(contactChannels` / `insert(counterpartyEntityRoles` (the
 *    Drizzle call shapes an insert into any of this domain's four tables
 *    would use) or a raw-SQL `insert into counterparties`.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// packages/counterparties/test/ -> repo root.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const FORBIDDEN_DIRS = [
  "packages/integrations",
  "packages/app",
  "packages/jobs",
] as const;

const INSERT_PATTERNS: RegExp[] = [
  /insert\s*\(\s*counterparties\b/i,
  /insert\s*\(\s*counterpartyContacts\b/i,
  /insert\s*\(\s*contactChannels\b/i,
  /insert\s*\(\s*counterpartyEntityRoles\b/i,
  /insert\s+into\s+counterparties\b/i,
  /insert\s+into\s+counterparty_contacts\b/i,
  /insert\s+into\s+contact_channels\b/i,
  /insert\s+into\s+counterparty_entity_roles\b/i,
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("never-auto-commit: no ingestion path may create a counterparty", () => {
  it("no packages/integrations/* package declares @loxep/counterparties as a dependency", async () => {
    const integrationsRoot = join(REPO_ROOT, "packages/integrations");
    const providers = await readdir(integrationsRoot, { withFileTypes: true });
    const offenders: string[] = [];
    for (const provider of providers) {
      if (!provider.isDirectory()) continue;
      const manifestPath = join(integrationsRoot, provider.name, "package.json");
      const manifest = await readJson(manifestPath);
      const deps = {
        ...(manifest["dependencies"] as Record<string, string> | undefined),
        ...(manifest["devDependencies"] as Record<string, string> | undefined),
      };
      if ("@loxep/counterparties" in deps) offenders.push(provider.name);
    }
    expect(offenders).toEqual([]);
  });

  it("@loxep/app (worker task/executor registry) and @loxep/jobs (dispatcher) declare no dependency on @loxep/counterparties", async () => {
    for (const pkg of ["packages/app", "packages/jobs"]) {
      const manifest = await readJson(join(REPO_ROOT, pkg, "package.json"));
      const deps = {
        ...(manifest["dependencies"] as Record<string, string> | undefined),
        ...(manifest["devDependencies"] as Record<string, string> | undefined),
      };
      expect(deps).not.toHaveProperty("@loxep/counterparties");
    }
  });

  it("no source file under packages/integrations/*, packages/app, or packages/jobs inserts into a counterparties-domain table", async () => {
    const offenders: { file: string; match: string }[] = [];
    for (const dir of FORBIDDEN_DIRS) {
      const files = await walk(join(REPO_ROOT, dir));
      for (const file of files) {
        const contents = await readFile(file, "utf8");
        for (const pattern of INSERT_PATTERNS) {
          const match = contents.match(pattern);
          if (match !== null) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              match: match[0],
            });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scanned at least one file per forbidden directory — a silently-empty walk would make every assertion above vacuous", async () => {
    for (const dir of FORBIDDEN_DIRS) {
      const files = await walk(join(REPO_ROOT, dir));
      expect(files.length).toBeGreaterThan(0);
    }
  });
});
