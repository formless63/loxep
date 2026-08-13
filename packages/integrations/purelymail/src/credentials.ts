/**
 * Dev/test helper: load a local Purelymail credential env file (default
 * `~/.config/loxep/purelymail.env`). This is NOT a runtime configuration path —
 * production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019). The file lives outside the repo on
 * purpose and its values must never be printed, logged, or embedded in
 * fixtures/errors; every error thrown here reports positions, not content.
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored, optional
 * single/double quotes around values):
 *
 * ```text
 *   PURELYMAIL_API_TOKEN=...            (required)
 *   PURELYMAIL_BASE_URL=...             (optional; defaults to production)
 *   PURELYMAIL_TEST_DOMAIN=example.com  (optional; the live test's read subject)
 * ```
 *
 * ## There is no read-only token, and the live leg is written around that
 *
 * `@loxep/integration-cloudflare`'s equivalent file says its token *should* be
 * read-only, because Cloudflare tokens are scoped. **Purelymail has no token
 * scoping at all** — one account token carries every operation, including
 * `deleteDomain` and `deleteUser`. There is no safe-by-construction credential
 * to ask for, so safety has to come from the test instead:
 * `live-purelymail.test.ts` calls only `checkAccountCredit`, `listDomains`,
 * `listUser`, and `listRoutingRules`, never a create or a delete, and the
 * account it points at should be one whose loss would not matter.
 *
 * That is a real difference in risk posture from milestone 1 and it is recorded
 * here rather than in a commit message.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PurelymailAdapterError } from "./errors.ts";

export interface PurelymailCredentials {
  apiToken: string;
  baseUrl?: string;
  /** Domain name the live leg reads. Not a credential. */
  testDomain?: string;
}

export function defaultPurelymailEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "purelymail.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed content
 * throws `invalid_request` without echoing any file content.
 */
export function loadPurelymailCredentialsFromEnvFile(
  path: string = defaultPurelymailEnvFilePath(),
): PurelymailCredentials | null {
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
      throw new PurelymailAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Purelymail env file`,
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

  const apiToken = firstOf("PURELYMAIL_API_TOKEN", "PM_API_TOKEN");
  if (apiToken === undefined) {
    throw new PurelymailAdapterError(
      "invalid_request",
      "Purelymail env file is missing PURELYMAIL_API_TOKEN",
      { path, expectedKeys: ["PURELYMAIL_API_TOKEN", "PM_API_TOKEN"] },
    );
  }
  const baseUrl = firstOf("PURELYMAIL_BASE_URL", "PM_BASE_URL");
  const testDomain = firstOf("PURELYMAIL_TEST_DOMAIN", "PM_TEST_DOMAIN");

  return {
    apiToken,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(testDomain === undefined ? {} : { testDomain }),
  };
}
