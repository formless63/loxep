/**
 * Dev/test helper: load a local Gatus credential env file (default
 * `~/.config/loxep/gatus.env`). NOT a runtime configuration path — production
 * credentials live application-encrypted in PostgreSQL on the provider
 * connection (ADR-0016/ADR-0019). The file lives outside the repo on purpose
 * and its values must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 * ```text
 *   GATUS_BASE_URL=https://gatus.example.com   (required — self-hosted)
 *   GATUS_USERNAME=loxep                        (optional — see below)
 *   GATUS_PASSWORD=...                          (optional — see below)
 * ```
 *
 * ## Username/password are an OPTIONAL pair, unlike every sibling's login
 *
 * Beszel and Termix always require a credential because their read paths are
 * always behind a login. Gatus is different: the fleet-observability design's
 * verdict table states plainly that *"the API is fully open when no
 * `security` block is configured"*, and even when `security.oidc` is
 * configured there is no bearer credential a server-to-server reader could
 * hold at all (`security/oidc.go` — session cookie only). A live run against
 * either of those Gatus instances legitimately has no Basic credential to
 * supply, so this file — and the `gatus_credentials` bundle it mirrors —
 * accepts `GATUS_USERNAME`/`GATUS_PASSWORD` being both absent. Supplying
 * exactly one of the two is rejected: a half-configured Basic auth header is
 * not a legitimate state, so the pair stays atomic when it is present at all.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatusAdapterError } from "./errors.ts";

export interface GatusCredentials {
  baseUrl: string;
  /** Present together or not at all — see the module doc. */
  username?: string;
  password?: string;
}

export function defaultGatusEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "gatus.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadGatusCredentialsFromEnvFile(
  path: string = defaultGatusEnvFilePath(),
): GatusCredentials | null {
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
      throw new GatusAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Gatus env file`,
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

  const require = (label: string, key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") {
      throw new GatusAdapterError(
        "invalid_request",
        `Gatus env file is missing ${label}`,
        { path, expectedKey: key },
      );
    }
    return value;
  };

  const baseUrl = require("GATUS_BASE_URL", "GATUS_BASE_URL");
  const username = values.get("GATUS_USERNAME");
  const password = values.get("GATUS_PASSWORD");
  const hasUsername = username !== undefined && username !== "";
  const hasPassword = password !== undefined && password !== "";
  if (hasUsername !== hasPassword) {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus env file must set GATUS_USERNAME and GATUS_PASSWORD together, or neither",
      { path },
    );
  }

  return {
    baseUrl,
    ...(hasUsername && hasPassword ? { username, password } : {}),
  };
}
