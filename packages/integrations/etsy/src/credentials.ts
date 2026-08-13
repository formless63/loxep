/**
 * Dev/test helper: load the local keyset env file (default
 * `~/.config/loxep/etsy-sandbox.env`). This is NOT a runtime configuration
 * path — production credentials live application-encrypted in PostgreSQL on
 * the provider connection (ADR-0016/ADR-0019). The file lives outside the
 * repo on purpose and its values must never be printed, logged, or embedded
 * in fixtures/errors; every error thrown here reports positions, not
 * content.
 *
 * NAMED FOR PARITY with eBay's `ebay-sandbox.env`, even though Etsy has NO
 * sandbox at all (per the binding design's "Owner-action prerequisites",
 * item 6 — Etsy removed its sandbox; every live-verification test in m1/m2
 * runs against a real shop). The filename keeps the convention so a
 * developer who already knows the eBay pattern recognizes this one, but the
 * "sandbox" in the name is a naming convenience, not a claim that an
 * isolated environment exists — it holds a dev keystring/secret pair (a real
 * approved Etsy Developer Portal app, used carefully) plus, optionally, a
 * manually-obtained user token for live-test convenience.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   LOXEP_ETSY_KEYSTRING=...       (required)
 *   LOXEP_ETSY_SHARED_SECRET=...   (required)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EtsyAdapterError } from "./errors.ts";
import { parseEtsyUserTokenBundle } from "./tokens.ts";
import type { EtsyUserTokenBundle } from "./tokens.ts";

export interface EtsyDevKeyset {
  keystring: string;
  sharedSecret: string;
}

export function defaultDevEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "etsy-sandbox.env");
}

/**
 * Returns the parsed dev keyset, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadDevKeysetFromEnvFile(
  path: string = defaultDevEnvFilePath(),
): EtsyDevKeyset | null {
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
      throw new EtsyAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Etsy dev env file`,
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

  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") {
      throw new EtsyAdapterError(
        "invalid_request",
        `Etsy dev env file is missing ${key}`,
        { path },
      );
    }
    return value;
  };

  return {
    keystring: required("LOXEP_ETSY_KEYSTRING"),
    sharedSecret: required("LOXEP_ETSY_SHARED_SECRET"),
  };
}

/**
 * DEV-ONLY user token artifact, mirroring eBay's
 * `ebay-sandbox-user-token.json` (loxep-62y.1.2/1.3 precedent).
 *
 * The real user token lives encrypted in `connection_credentials`; nothing
 * in production ever reads it from disk. This file exists so a live-test
 * leg can exercise private-auth calls against a real shop after a one-off
 * manual consent — Etsy has no sandbox to consent against instead, so this
 * is exercised carefully and read-only.
 *
 * Format (JSON, the exact {@link EtsyUserTokenBundle} shape):
 *
 * ```json
 * {
 *   "etsyUserId": "123456789",
 *   "accessToken": "...",
 *   "refreshToken": "...",
 *   "accessTokenExpiresAt": "2026-08-13T12:00:00.000Z",
 *   "refreshTokenExpiresAt": null,
 *   "scopes": ["shops_r", "listings_r"]
 * }
 * ```
 *
 * Treat it like a password: `chmod 600`, outside the repo, never committed.
 */
export function defaultDevUserTokenFilePath(): string {
  return join(homedir(), ".config", "loxep", "etsy-sandbox-user-token.json");
}

/**
 * Returns the parsed dev user-token bundle, or `null` when the file does not
 * exist (live tests skip cleanly in that case). Malformed content throws
 * `invalid_request` reporting paths and codes, never values.
 */
export function loadDevUserTokenFromFile(
  path: string = defaultDevUserTokenFilePath(),
): EtsyUserTokenBundle | null {
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
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy dev user token file is not valid JSON",
      { path },
    );
  }
  return parseEtsyUserTokenBundle(parsed);
}
