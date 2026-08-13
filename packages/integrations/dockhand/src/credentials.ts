/**
 * Dev/test helper: load a local Dockhand credential env file (default
 * `~/.config/loxep/dockhand.env`). This is NOT a runtime configuration path —
 * production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). The file lives outside the repo on
 * purpose and its values must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored, optional
 * single/double quotes around values):
 *
 * ```text
 *   DOCKHAND_BASE_URL=https://dockhand.example.com  (required — self-hosted)
 *   DOCKHAND_USERNAME=loxep                         (required)
 *   DOCKHAND_PASSWORD=...                           (required)
 *   DOCKHAND_TEST_ENVIRONMENT_ID=1                  (optional; live read subject)
 * ```
 *
 * ## The account this file points at, and the two risks it carries
 *
 * Dockhand publishes no scoped API token — its API reference documents
 * *"HTTP-only session cookies"* and nothing else — so this is a real login, and
 * the session it mints can reach every endpoint the account's permissions
 * allow. That produces two risks the sibling adapters do not have:
 *
 * 1. **The session is more powerful than the adapter.** A Dockhand session that
 *    can list containers can also start and stop them. Loxep's restraint lives
 *    in its own exported surface (`test/forbidden-verbs.test.ts`), not in
 *    Dockhand's session. Point this file at a purpose-made account holding
 *    `environments:view`, `environments:edit`, `containers:view`, and
 *    `stacks:view` — never the operator's own admin account.
 * 2. **Failed logins lock the account out.** Upstream documents *"5 failed
 *    attempts per IP/username combination"* with an *"exponential backoff
 *    (5-60 seconds)"*. A typo in this file does not fail one test — it locks
 *    out the username for up to a minute, for every process using it. That is
 *    why the adapter charges the login exchange
 *    {@link DOCKHAND_LOGIN_COST} rate tokens and never retries more than once.
 *
 * `DOCKHAND_TEST_ENVIRONMENT_ID` is not a credential. It names which managed
 * host the live read should list containers and stacks for, because both of
 * those endpoints require an `env` query parameter.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DockhandAdapterError } from "./errors.ts";

export interface DockhandCredentials {
  baseUrl: string;
  username: string;
  password: string;
  /** Which environment the live leg reads. Not a credential. */
  testEnvironmentId?: string;
}

export function defaultDockhandEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "dockhand.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed content
 * throws `invalid_request` without echoing any file content.
 */
export function loadDockhandCredentialsFromEnvFile(
  path: string = defaultDockhandEnvFilePath(),
): DockhandCredentials | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }

  const values = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match === null) {
      throw new DockhandAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Dockhand env file`,
        { path, line: i + 1 },
      );
    }
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1] as string, value);
  }

  const firstOf = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = values.get(key);
      if (value !== undefined && value !== "") return value;
    }
    return undefined;
  };

  const require = (label: string, ...keys: string[]): string => {
    const value = firstOf(...keys);
    if (value === undefined) {
      throw new DockhandAdapterError(
        "invalid_request",
        `Dockhand env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  const testEnvironmentId = firstOf(
    "DOCKHAND_TEST_ENVIRONMENT_ID",
    "DOCKHAND_TEST_ENV",
  );

  return {
    baseUrl: require("DOCKHAND_BASE_URL", "DOCKHAND_BASE_URL", "DOCKHAND_URL"),
    username: require("DOCKHAND_USERNAME", "DOCKHAND_USERNAME", "DOCKHAND_USER"),
    password: require("DOCKHAND_PASSWORD", "DOCKHAND_PASSWORD"),
    ...(testEnvironmentId === undefined ? {} : { testEnvironmentId }),
  };
}
