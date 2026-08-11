/**
 * Dev/test helper: load the local SANDBOX keyset env file
 * (default ~/.config/loxep/ebay-sandbox.env). This is NOT a runtime
 * configuration path — production credentials live application-encrypted in
 * PostgreSQL on the provider connection (ADR-0016/ADR-0019). The file lives
 * outside the repo on purpose and its values must never be printed, logged,
 * or embedded in fixtures/errors; every error thrown here reports positions,
 * not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   LOXEP_EBAY_ENV=sandbox        (required, literally "sandbox")
 *   LOXEP_EBAY_APP_ID=...         (required)
 *   LOXEP_EBAY_CERT_ID=...        (required)
 *   LOXEP_EBAY_DEV_ID=...         (required)
 *   LOXEP_EBAY_RU_NAME=...        (optional)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EbayAdapterError } from "./errors.ts";
import { parseEbayUserTokenBundle } from "./tokens.ts";
import type { EbayUserTokenBundle } from "./tokens.ts";

export interface EbaySandboxCredentials {
  appId: string;
  certId: string;
  devId: string;
  ruName?: string;
  environment: "sandbox";
}

export function defaultSandboxEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "ebay-sandbox.env");
}

/**
 * Returns the parsed sandbox keyset, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadSandboxCredentialsFromEnvFile(
  path: string = defaultSandboxEnvFilePath(),
): EbaySandboxCredentials | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const values = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match === null) {
      throw new EbayAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in eBay sandbox env file`,
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

  if (values.get("LOXEP_EBAY_ENV") !== "sandbox") {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay sandbox env file must set LOXEP_EBAY_ENV=sandbox",
      { path },
    );
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") {
      throw new EbayAdapterError(
        "invalid_request",
        `eBay sandbox env file is missing ${key}`,
        { path },
      );
    }
    return value;
  };

  const ruName = values.get("LOXEP_EBAY_RU_NAME");
  return {
    appId: required("LOXEP_EBAY_APP_ID"),
    certId: required("LOXEP_EBAY_CERT_ID"),
    devId: required("LOXEP_EBAY_DEV_ID"),
    ...(ruName !== undefined && ruName !== "" ? { ruName } : {}),
    environment: "sandbox",
  };
}

/**
 * DEV-ONLY user token artifact (loxep-62y.1.2/1.3 live legs).
 *
 * The real user token lives encrypted in `connection_credentials`; nothing in
 * production ever reads it from disk. This file exists so the sandbox live
 * tests can exercise Trading calls after a one-off manual consent, and it is
 * created deliberately by a developer — Loxep never writes it.
 *
 * Format (JSON, the exact {@link EbayUserTokenBundle} shape):
 *
 * ```json
 * {
 *   "accessToken": "v^1.1#...",
 *   "refreshToken": "v^1.1#...",
 *   "accessTokenExpiresAt": "2026-08-11T12:00:00.000Z",
 *   "refreshTokenExpiresAt": "2028-02-09T22:00:00.000Z",
 *   "scopes": ["https://api.ebay.com/oauth/api_scope"]
 * }
 * ```
 *
 * Treat it like a password: `chmod 600`, outside the repo, never committed.
 */
export function defaultSandboxUserTokenFilePath(): string {
  return join(homedir(), ".config", "loxep", "ebay-sandbox-user-token.json");
}

/**
 * Returns the parsed dev user-token bundle, or `null` when the file does not
 * exist (live tests skip cleanly in that case). Malformed content throws
 * `invalid_request` reporting paths and codes, never values.
 */
export function loadSandboxUserTokenFromFile(
  path: string = defaultSandboxUserTokenFilePath(),
): EbayUserTokenBundle | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay sandbox user token file is not valid JSON",
      { path },
    );
  }
  return parseEbayUserTokenBundle(parsed);
}
