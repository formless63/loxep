/**
 * Dev/test helper: load a local Medusa backend credential env file (default
 * ~/.config/loxep/medusa.env). This is NOT a runtime configuration path —
 * production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). The file lives outside the repo
 * on purpose and its value must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * Unlike `packages/integrations/woo/test/live-store.test.ts`, which points at
 * a real production WooCommerce store, this package's live leg
 * (`test/live-store.test.ts`) points at a THROWAWAY Medusa backend stood up
 * for verification (loxep-xh9.4.1) — so the credential here guards nothing
 * of value, and the discipline below is still observed as if it did.
 * `loadMedusaCredentialsFromEnvFile` returns `null` when the file is absent
 * (CI, a fresh clone), and the live tests skip cleanly.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   MEDUSA_URL=https://commerce.example.com   (required, https)
 *   MEDUSA_RO_API_TOKEN=sk_...                (required; MEDUSA_API_TOKEN accepted)
 *
 * A local harness may add one more line, which this loader ignores and the
 * live test reads for itself:
 *
 *   MEDUSA_CA_CERT_FILE=/path/to/cert.pem     (optional; trust anchor for a
 *                                              self-signed TLS terminator in
 *                                              front of a dev backend)
 *
 * The `_RO_` spelling is the convention for a READ-ONLY-INTENDED key,
 * matching `WOO_RO_CONSUMER_KEY`'s convention — Medusa's secret API keys are
 * not scoped read/write at creation time the way a WooCommerce key pair can
 * be, so "read-only" here is an operational discipline (only ever call GET
 * endpoints through this adapter), not a provider-enforced guarantee.
 * Loxep's Phase 3 ingestion is read-only against providers regardless.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MedusaAdapterError } from "./errors.ts";

export interface MedusaBackendCredentials {
  /** Backend root URL (normalization/https enforcement happens in config.ts). */
  baseUrl: string;
  apiToken: string;
}

export function defaultMedusaEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "medusa.env");
}

/**
 * Returns the parsed backend credentials, or `null` when the file does not
 * exist (callers — tests, dev scripts — skip cleanly in that case).
 * Malformed content throws `invalid_request` without echoing any file
 * content.
 */
export function loadMedusaCredentialsFromEnvFile(
  path: string = defaultMedusaEnvFilePath(),
): MedusaBackendCredentials | null {
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
      throw new MedusaAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Medusa env file`,
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
      throw new MedusaAdapterError(
        "invalid_request",
        `Medusa env file is missing ${label}`,
        { path, expectedKeys: keys },
      );
    }
    return value;
  };

  return {
    baseUrl: required("MEDUSA_URL", "MEDUSA_URL", "MEDUSA_BASE_URL"),
    apiToken: required(
      "MEDUSA_RO_API_TOKEN",
      "MEDUSA_RO_API_TOKEN",
      "MEDUSA_API_TOKEN",
    ),
  };
}
