/**
 * Dev/test helper: load a local Cloudflare credential env file (default
 * `~/.config/loxep/cloudflare.env`). This is NOT a runtime configuration path
 * — production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). The file lives outside the repo on
 * purpose and its values must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored, optional
 * single/double quotes around values):
 *
 * ```text
 *   CLOUDFLARE_API_TOKEN=...        (required — an API TOKEN, never the
 *                                    legacy global API key)
 *   CLOUDFLARE_ACCOUNT_ID=...       (optional; non-secret account identity)
 *   CLOUDFLARE_TEST_ZONE=example.com (optional; the live test's read subject)
 * ```
 *
 * **The token this file holds should be read-only.** Loxep's milestone-1 live
 * leg only reads (list zones, list records), so a `Zone:Read` + `DNS:Read`
 * token is sufficient and a write-capable token buys nothing and risks a
 * production zone. That mirrors `@loxep/integration-woo`'s `_RO_` convention
 * for the same reason.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CloudflareAdapterError } from "./errors.ts";

export interface CloudflareCredentials {
  apiToken: string;
  accountId?: string;
  /** Zone name the live leg reads. Not a credential. */
  testZone?: string;
}

export function defaultCloudflareEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "cloudflare.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadCloudflareCredentialsFromEnvFile(
  path: string = defaultCloudflareEnvFilePath(),
): CloudflareCredentials | null {
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
      throw new CloudflareAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Cloudflare env file`,
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

  const apiToken = firstOf("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN");
  if (apiToken === undefined) {
    throw new CloudflareAdapterError(
      "invalid_request",
      "Cloudflare env file is missing CLOUDFLARE_API_TOKEN",
      { path, expectedKeys: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"] },
    );
  }
  const accountId = firstOf("CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID");
  const testZone = firstOf("CLOUDFLARE_TEST_ZONE", "CF_TEST_ZONE");

  return {
    apiToken,
    ...(accountId === undefined ? {} : { accountId }),
    ...(testZone === undefined ? {} : { testZone }),
  };
}
