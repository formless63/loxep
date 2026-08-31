/**
 * Dev/test helper: load a local Pangolin credential env file (default
 * `~/.config/loxep/pangolin.env`). This is NOT a runtime configuration path
 * — production credentials live application-encrypted in PostgreSQL on the
 * provider connection (ADR-0016/ADR-0019), as `{apiKeyId, apiKeySecret}` in
 * the `pangolin_credentials` bundle. Nothing here is printed, logged, or
 * embedded in fixtures/errors; every error thrown here reports positions,
 * not content.
 *
 * ## File format
 *
 * The file carries the key as ONE combined value, matching the wire format
 * exactly (`Authorization: Bearer <apiKeyId>.<apiKeySecret>`):
 *
 * ```text
 *   PANGOLIN_API_KEY=<apiKeyId>.<apiKeySecret>
 *   PANGOLIN_KEY_NAME=...                       (optional — a label, not a credential)
 *   PANGOLIN_URL=https://pangolin.example.com   (required — see the reachability
 *                                                 warning in adapter.ts before assuming
 *                                                 this is the Integration API's base URL)
 *   PANGOLIN_ORG_ID=example-org                 (optional — which org the live leg reads)
 * ```
 *
 * `apiKeyId`/`apiKeySecret` are split on the FIRST `.` — matching
 * `fosrl/pangolin@main`'s own `server/middlewares/integration/
 * verifyApiKey.ts`, which does `authHeader.split(" ")[1].split(".")` and
 * reads only the first two array positions, so a secret that happens to
 * contain a `.` is preserved intact by taking everything after the first
 * separator rather than an exhaustive split.
 *
 * Provider keys may be broadly scoped. Safety therefore comes from the
 * adapter's closed operation surface and Loxep's per-connection write policy,
 * not from assumptions about one deployment's credential scope.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PangolinAdapterError } from "./errors.ts";

export interface PangolinCredentials {
  baseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  /** Optional org for the explicitly opted-in live read. */
  orgId?: string;
  /** A human label for the key, not a credential. */
  keyName?: string;
}

export function defaultPangolinEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "pangolin.env");
}

/**
 * Returns the parsed credentials, or `null` when the file does not exist
 * (callers — tests, dev scripts — skip cleanly in that case). Malformed
 * content throws `invalid_request` without echoing any file content.
 */
export function loadPangolinCredentialsFromEnvFile(
  path: string = defaultPangolinEnvFilePath(),
): PangolinCredentials | null {
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
      throw new PangolinAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Pangolin env file`,
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

  const nonEmpty = (key: string): string | undefined => {
    const value = values.get(key);
    return value !== undefined && value !== "" ? value : undefined;
  };

  const baseUrl = nonEmpty("PANGOLIN_URL") ?? nonEmpty("PANGOLIN_BASE_URL");
  if (baseUrl === undefined) {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin env file is missing PANGOLIN_URL",
      { path, expectedKeys: ["PANGOLIN_URL"] },
    );
  }

  const rawKey = nonEmpty("PANGOLIN_API_KEY");
  if (rawKey === undefined) {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin env file is missing PANGOLIN_API_KEY",
      { path, expectedKeys: ["PANGOLIN_API_KEY"] },
    );
  }
  const dotIndex = rawKey.indexOf(".");
  if (dotIndex <= 0 || dotIndex === rawKey.length - 1) {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin env file's PANGOLIN_API_KEY is not shaped like <apiKeyId>.<apiKeySecret>",
      { path },
    );
  }
  const apiKeyId = rawKey.slice(0, dotIndex);
  const apiKeySecret = rawKey.slice(dotIndex + 1);

  const orgId = nonEmpty("PANGOLIN_ORG_ID");
  const keyName = nonEmpty("PANGOLIN_KEY_NAME");

  return {
    baseUrl,
    apiKeyId,
    apiKeySecret,
    ...(orgId === undefined ? {} : { orgId }),
    ...(keyName === undefined ? {} : { keyName }),
  };
}
