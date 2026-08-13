/**
 * Dev/test helper: load a local Personal Access Token from an env file
 * (default `~/.config/loxep/reverb.env`). This is NOT a runtime
 * configuration path — production credentials live application-encrypted in
 * PostgreSQL on the provider connection (ADR-0016/ADR-0019). The file lives
 * outside the repo on purpose and its value must never be printed, logged,
 * or embedded in fixtures/errors; every error thrown here reports positions,
 * not content.
 *
 * UNLIKE eBay's/Etsy's dev-file pair (an application keyset, shared across
 * every connection), this file holds ONE connection's own PAT — the same
 * role `~/.config/loxep/reverb.env` plays is closer to a single manually
 * obtained credential than an application-wide secret, because Reverb has
 * no application-level credential at all (see `config.ts`'s module doc).
 *
 * File format (KEY=VALUE lines, `#` comments and blank lines ignored,
 * optional single/double quotes around values):
 *
 *   LOXEP_REVERB_PERSONAL_ACCESS_TOKEN=...   (required)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReverbAdapterError } from "./errors.ts";

export interface ReverbDevCredentials {
  personalAccessToken: string;
}

export function defaultDevEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "reverb.env");
}

/**
 * Returns the parsed dev credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadDevCredentialsFromEnvFile(
  path: string = defaultDevEnvFilePath(),
): ReverbDevCredentials | null {
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
      throw new ReverbAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Reverb dev env file`,
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

  const token = values.get("LOXEP_REVERB_PERSONAL_ACCESS_TOKEN");
  if (token === undefined || token === "") {
    throw new ReverbAdapterError(
      "invalid_request",
      "Reverb dev env file is missing LOXEP_REVERB_PERSONAL_ACCESS_TOKEN",
      { path },
    );
  }
  return { personalAccessToken: token };
}
