/**
 * Dev/test helper: load a local Beszel credential env file (default
 * `~/.config/loxep/beszel.env`). This is NOT a runtime configuration path —
 * production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). The file lives outside the repo on
 * purpose and its values must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored, optional
 * single/double quotes around values):
 *
 * ```text
 *   BESZEL_BASE_URL=https://beszel.example.com   (required — self-hosted)
 *   BESZEL_EMAIL=loxep-readonly@example.com      (required)
 *   BESZEL_PASSWORD=...                          (required)
 * ```
 *
 * ## The account this file should point at is a READONLY user
 *
 * Purelymail's equivalent file records that the provider has no token scoping
 * at all, so safety had to come from the test. Beszel is the happier case:
 * upstream documents a role beneath `user` and `admin` — *"Read-only users
 * cannot create systems but can view any system shared with them by an admin
 * and create alerts"* (https://beszel.dev/guide/user-accounts) — so a
 * least-privilege credential genuinely exists and this file should hold one.
 *
 * Two things follow, and both are properties of the ACCOUNT rather than of the
 * test:
 *
 * 1. a readonly user sees only the systems an admin deliberately shared with
 *    it, so a live run against a fresh readonly account legitimately returns an
 *    empty list. `live-beszel.test.ts` treats zero systems as a pass and says
 *    so, because failing there would push the next person toward sharing more
 *    than they meant to;
 * 2. this must be a `users` row, never a PocketBase superuser. Upstream is
 *    explicit that *"regular user accounts and PocketBase superuser accounts
 *    are entirely separate"* and that *"changing a user's role to admin does
 *    not create a superuser account"*. The adapter only ever posts to the
 *    `users` collection's auth route, and a boundary test asserts the
 *    `_superusers` collection never appears in a request URL.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BeszelAdapterError } from "./errors.ts";

export interface BeszelCredentials {
  baseUrl: string;
  email: string;
  password: string;
}

export function defaultBeszelEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "beszel.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed content
 * throws `invalid_request` without echoing any file content.
 */
export function loadBeszelCredentialsFromEnvFile(
  path: string = defaultBeszelEnvFilePath(),
): BeszelCredentials | null {
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
      throw new BeszelAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Beszel env file`,
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
      throw new BeszelAdapterError(
        "invalid_request",
        `Beszel env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  return {
    baseUrl: require("BESZEL_BASE_URL", "BESZEL_BASE_URL", "BESZEL_URL"),
    email: require("BESZEL_EMAIL", "BESZEL_EMAIL", "BESZEL_IDENTITY"),
    password: require("BESZEL_PASSWORD", "BESZEL_PASSWORD"),
  };
}
