/**
 * Dev/test helper: load a local Termix credential env file (default
 * `~/.config/loxep/termix.env`). This is NOT a runtime configuration path —
 * production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). Nothing here is printed, logged,
 * or embedded in fixtures/errors.
 *
 * Termix's OpenAPI document (`Termix-SSH/Docs`, `static/openapi.json`,
 * verified 2026-08-13) documents `POST /users/login` with a request body of
 * `{ username: string, password: string }` — an ordinary username/password
 * login, not a scoped API token. There is no per-integration read-only
 * account concept published anywhere in the spec (unlike Beszel's `readonly`
 * role), so this should be a Termix user account the operator is
 * comfortable having Loxep authenticate as; Loxep's own restraint against
 * Termix's much larger write surface is enforced entirely in this package's
 * exported surface (`operations.ts`), not by anything Termix's login grants
 * or withholds.
 *
 * File format:
 * ```text
 *   TERMIX_BASE_URL=https://termix.example.com   (required — self-hosted)
 *   TERMIX_USERNAME=loxep
 *   TERMIX_PASSWORD=...
 * ```
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TermixAdapterError } from "./errors.ts";

export interface TermixCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

export function defaultTermixEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "termix.env");
}

export function loadTermixCredentialsFromEnvFile(
  path: string = defaultTermixEnvFilePath(),
): TermixCredentials | null {
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
      throw new TermixAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Termix env file`,
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
      throw new TermixAdapterError(
        "invalid_request",
        `Termix env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  return {
    baseUrl: require("TERMIX_BASE_URL", "TERMIX_BASE_URL", "TERMIX_URL"),
    username: require("TERMIX_USERNAME", "TERMIX_USERNAME", "TERMIX_USER"),
    password: require("TERMIX_PASSWORD", "TERMIX_PASSWORD"),
  };
}
