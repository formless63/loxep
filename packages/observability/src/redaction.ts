/**
 * Redaction conventions shared by web and worker runtimes.
 *
 * Pino's `redact` option (fast-redact) matches explicit paths, not arbitrary
 * depth: a `*` wildcard matches exactly one path segment (an object key or an
 * array index). To cover secrets at realistic nesting depths we emit one path
 * per secret key per depth, up to {@link WILDCARD_DEPTH} wildcard segments —
 * i.e. `token`, `*.token`, `*.*.token`, `*.*.*.token`. Verified against pino
 * 10.3.1: multiple wildcards per path are supported and wildcards traverse
 * array indices (`*.*.token` redacts `creds[0].token`).
 *
 * Wildcard redaction is not free (~50 microseconds per log line with this
 * path set versus ~3 with a single literal path, measured locally). That cost
 * is accepted: never serializing secret material is load-bearing, log volume
 * is modest, and per the implementation contract plaintext credentials must
 * never reach logs.
 *
 * Structures nested deeper than four levels are not covered by these paths.
 * Do not log provider payloads or credential envelopes wholesale; pass domain
 * objects with known shapes.
 */

/** Object keys whose values are always secret material, at any depth. */
export const SECRET_KEYS = [
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "authorization",
  "cookie",
  "ciphertext",
  "nonce",
  "authTag",
  "apiKey",
  "apiSecret",
  "privateKey",
] as const;

/** Number of `*.` wildcard prefixes generated per secret key. */
const WILDCARD_DEPTH = 3;

/** Replacement value pino writes in place of redacted values. */
export const REDACT_CENSOR = "[REDACTED]";

function pathsForKey(key: string): string[] {
  const paths = [key];
  let prefix = "";
  for (let depth = 0; depth < WILDCARD_DEPTH; depth += 1) {
    prefix += "*.";
    paths.push(`${prefix}${key}`);
  }
  return paths;
}

/**
 * The full pino `redact.paths` list. Wildcard-depth variants of every
 * {@link SECRET_KEYS} entry, plus explicit HTTP header paths (redundant with
 * the wildcard forms for `authorization`/`cookie`, kept as documentation of
 * intent) and bracket-notation paths for the hyphenated `set-cookie` header,
 * which no bare-key wildcard form can express.
 */
export const REDACT_PATHS: readonly string[] = [
  ...SECRET_KEYS.flatMap(pathsForKey),
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  'headers["set-cookie"]',
  '*.headers["set-cookie"]',
  '*.*.headers["set-cookie"]',
];
