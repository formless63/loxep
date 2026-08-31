/**
 * Dev/test helper: load a local Invoice Ninja instance credential env file
 * (default ~/.config/loxep/invoiceninja.env). This is NOT a runtime
 * configuration path — production credentials live application-encrypted in
 * PostgreSQL on the provider connection (ADR-0016/ADR-0019). The file lives
 * outside the repo on purpose and its value must never be printed, logged,
 * or embedded in fixtures/errors; every error thrown here reports positions,
 * not content.
 *
 * This loader returns `null` when the file is absent, and the explicitly
 * opted-in live suite skips cleanly in that case. A live unauthenticated
 * probe confirmed only the provider's auth-failure shape; authenticated
 * behavior remains source- and fixture-verified.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   INVOICENINJA_URL=https://billing.example.com    (required, https)
 *   INVOICENINJA_RO_API_TOKEN=...                    (required; INVOICENINJA_API_TOKEN accepted)
 *
 * The `_RO_` spelling is the convention for a READ-ONLY-INTENDED key,
 * matching `WOO_RO_CONSUMER_KEY`'s / `MEDUSA_RO_API_TOKEN`'s convention —
 * Invoice Ninja's company API tokens are not scoped read/write at creation
 * time (they carry whatever permissions the issuing user has), so
 * "read-only" here is an operational discipline (only ever call safe
 * endpoints through this adapter's read paths in a live test), not a
 * provider-enforced guarantee.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvoiceNinjaAdapterError } from "./errors.ts";

export interface InvoiceNinjaInstanceCredentials {
  /** Instance root URL (normalization/https enforcement happens in config.ts). */
  baseUrl: string;
  apiToken: string;
}

export function defaultInvoiceNinjaEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "invoiceninja.env");
}

/**
 * Returns the parsed instance credentials, or `null` when the file does not
 * exist (callers — tests, dev scripts — skip cleanly in that case).
 * Malformed content throws `invalid_request` without echoing any file
 * content.
 */
export function loadInvoiceNinjaCredentialsFromEnvFile(
  path: string = defaultInvoiceNinjaEnvFilePath(),
): InvoiceNinjaInstanceCredentials | null {
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
      throw new InvoiceNinjaAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Invoice Ninja env file`,
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
      throw new InvoiceNinjaAdapterError(
        "invalid_request",
        `Invoice Ninja env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  return {
    baseUrl: required("INVOICENINJA_URL", "INVOICENINJA_URL", "INVOICENINJA_BASE_URL"),
    apiToken: required(
      "INVOICENINJA_RO_API_TOKEN",
      "INVOICENINJA_RO_API_TOKEN",
      "INVOICENINJA_API_TOKEN",
    ),
  };
}
