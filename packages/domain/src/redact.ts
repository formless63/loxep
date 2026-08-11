/**
 * Recursive secret redaction for audit serialization (ADR-0016: plaintext
 * secrets are never written into audit snapshots).
 *
 * Redaction is key-based: any object key matching the sensitive-key rules is
 * replaced with `[REDACTED]` regardless of value shape, recursively through
 * nested objects and arrays.
 */

export const REDACTED = "[REDACTED]";

/**
 * Exact sensitive key names, compared after normalization (lowercased,
 * separators stripped): `secret_access_key`, `secretAccessKey`, and
 * `SECRET-ACCESS-KEY` all normalize to `secretaccesskey`.
 */
const EXACT_SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "ciphertext",
  "nonce",
  "authtag",
  "secretaccesskey",
  "accesskeyid",
  "apikey",
  "privatekey",
  "passphrase",
  "credentials",
  "authorization",
  "cookie",
  "sessiontoken",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string, redactPayloadKey: boolean): boolean {
  const normalized = normalizeKey(key);
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  if (redactPayloadKey && normalized === "payload") return true;
  return (
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey")
  );
}

export interface RedactOptions {
  /**
   * Also redact keys named `payload` — used for secret-resource audit events
   * where a payload, if it ever appeared, would be secret material.
   */
  redactPayloadKey?: boolean;
}

/**
 * Returns a deep copy of `value` with every sensitive key's value replaced
 * by {@link REDACTED}. Non-object values pass through unchanged.
 */
export function redactJson(value: unknown, options?: RedactOptions): unknown {
  const redactPayloadKey = options?.redactPayloadKey ?? false;

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        out[key] = isSensitiveKey(key, redactPayloadKey)
          ? REDACTED
          : walk(entry);
      }
      return out;
    }
    return node;
  }

  return walk(value);
}
