/**
 * Proof that the compose BETTER_AUTH_SECRET/BETTER_AUTH_URL mirror is
 * unnecessary: a subprocess with NODE_ENV=production and only LOXEP_*
 * configuration constructs and initializes the auth instance successfully.
 * (Importing @loxep/db in production is also exercised transitively — the
 * lazy CLI instance must not construct betterAuth() at import time.)
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { testKeyringJson } from "./helpers.ts";

const execFileAsync = promisify(execFile);

const FIXTURE = fileURLToPath(
  new URL("./fixtures/construct-production.ts", import.meta.url),
);

describe("production construction without BETTER_AUTH_* env", () => {
  it("constructs createAuth from LOXEP_* config alone under NODE_ENV=production", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", FIXTURE],
      {
        env: {
          // Minimal clean environment: no BETTER_AUTH_* mirror at all.
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production",
          LOXEP_MODE: "all",
          // The pool never connects (no queries are issued), so the database
          // does not need to exist.
          LOXEP_DATABASE_URL:
            "postgres://postgres:unused@localhost:5433/loxep_never_connected",
          LOXEP_PUBLIC_ORIGIN: "https://loxep.example.com",
          LOXEP_AUTH_SECRET:
            "production-secret-0123456789abcdef0123456789abcdef",
          LOXEP_KEYRING: testKeyringJson(),
          LOXEP_SMTP_URL: "smtps://mailer.example.com:465",
          LOXEP_SMTP_FROM: "loxep@example.com",
        },
        timeout: 30_000,
      },
    );
    expect(stdout).toContain("PRODUCTION_CONSTRUCTION_OK");
  }, 40_000);
});
