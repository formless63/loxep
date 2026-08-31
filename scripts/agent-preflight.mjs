import { spawnSync } from "node:child_process";

const full = process.argv.includes("--full");

function run(label, command, args) {
  console.log(`\n==> ${label}`);

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(result.status || 1);
  }
}

function runBeadsLint() {
  console.log("\n==> Beads issue templates");
  const result = spawnSync("bd", ["lint", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });

  // Some constrained runners report an EPERM on the spawn wrapper even when
  // bd itself completed successfully and returned a valid status-0 report.
  // Treat the machine-readable report as authoritative, while still failing
  // closed on a non-zero/null status, malformed output, or any findings.
  let failed = result.status !== 0;
  try {
    const report = JSON.parse(result.stdout ?? "");
    failed ||= typeof report !== "object" || report === null || report.total !== 0;
  } catch {
    failed = true;
  }

  if (failed) {
    console.error(
      "\nBeads issue templates failed. Run `bd lint` locally to inspect private issue details.",
    );
    process.exit(result.status || 1);
  }
}

runBeadsLint();
run("Beads hooks", "bd", ["hooks", "list"]);
run("Git whitespace", "git", ["diff", "--check"]);
run("Web lint", "bun", ["run", "lint"]);
run("Web formatting", "bun", ["run", "format:check"]);
run("Workspace typecheck", "bun", ["run", "typecheck"]);

if (full) {
  run("Web unit tests", "bun", ["--cwd", "apps/web", "test"]);
  run("Package tests", "bun", ["run", "test:packages"]);
  run("Documentation build", "bun", ["run", "docs:build"]);
}

console.log(`\nAgent preflight passed${full ? " (full)" : ""}.`);
