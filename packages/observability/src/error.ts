/** Plain-object error shape safe for logging and JSON transport. */
export interface SerializedError {
  message: string;
  name: string;
  stack?: string;
  code?: string | number;
}

/**
 * Convert an unknown thrown value into a small, JSON-safe object.
 *
 * For `Error` instances this captures message, name, stack, and a
 * string/number `code` property when present (Node system errors,
 * PostgreSQL errors). Non-Error values are stringified with name
 * `"NonError"` so `catch (err: unknown)` sites can log unconditionally.
 *
 * Note: loggers from `createLogger` already serialize `Error` instances
 * passed under the `err` key via pino's standard error serializer; use this
 * helper where a plain object is needed outside pino (job payloads, API
 * responses, audit detail).
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { message: err.message, name: err.name };
    if (typeof err.stack === "string") {
      out.stack = err.stack;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      out.code = code;
    }
    return out;
  }
  return { message: String(err), name: "NonError" };
}
