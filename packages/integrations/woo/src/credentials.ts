/**
 * Dev/test helper: load a local WooCommerce store credential env file
 * (default ~/.config/loxep/woo.env). This is NOT a runtime
 * configuration path — production credentials live application-encrypted in
 * PostgreSQL on the provider connection (ADR-0016/ADR-0019). The file lives
 * outside the repo on purpose and its values must never be printed, logged,
 * or embedded in fixtures/errors; every error thrown here reports positions,
 * not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   WOO_URL=https://shop.example.com    (required, https)
 *   WOO_RO_CONSUMER_KEY=ck_...          (required; WOO_CONSUMER_KEY accepted)
 *   WOO_RO_CONSUMER_SECRET=cs_...       (required; WOO_CONSUMER_SECRET accepted)
 *
 * The `_RO_` spelling is the convention for a READ-ONLY key pair, which is the
 * only kind that should ever point at a real store from a development
 * machine. Loxep's Phase 3 ingestion is read-only against providers, so a
 * read/write key buys nothing and risks everything.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WooAdapterError } from "./errors.ts";

export interface WooStoreCredentials {
  /** Store root URL (normalization/https enforcement happens in config.ts). */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export function defaultWooEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "woo.env");
}

/**
 * Returns the parsed store credentials, or `null` when the file does not
 * exist (callers — tests, dev scripts — skip cleanly in that case).
 * Malformed content throws `invalid_request` without echoing any file
 * content.
 */
export function loadWooCredentialsFromEnvFile(
  path: string = defaultWooEnvFilePath(),
): WooStoreCredentials | null {
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
      throw new WooAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in WooCommerce env file`,
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

  const required = (label: string, ...keys: string[]): string => {
    const value = firstOf(...keys);
    if (value === undefined) {
      throw new WooAdapterError(
        "invalid_request",
        `WooCommerce env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  return {
    baseUrl: required("WOO_URL", "WOO_URL", "WOO_BASE_URL"),
    consumerKey: required(
      "WOO_RO_CONSUMER_KEY",
      "WOO_RO_CONSUMER_KEY",
      "WOO_CONSUMER_KEY",
    ),
    consumerSecret: required(
      "WOO_RO_CONSUMER_SECRET",
      "WOO_RO_CONSUMER_SECRET",
      "WOO_CONSUMER_SECRET",
    ),
  };
}
