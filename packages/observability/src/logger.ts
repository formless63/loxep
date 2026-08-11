import { pino, stdSerializers } from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";
import { getLogContext } from "./context.ts";
import { REDACT_CENSOR, REDACT_PATHS } from "./redaction.ts";

export interface CreateLoggerOptions {
  /** Minimum level ("fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"). Default "info". */
  level?: string;
  /**
   * Development only: pipe output through pino-pretty via a worker-thread
   * transport. Never enable in production. Ignored when an explicit
   * `destination` is passed (pino cannot combine transport and destination).
   */
  pretty?: boolean;
  /** Static fields added to every line (pino `base`); pino's default adds pid + hostname. */
  base?: object;
}

/**
 * Create the Loxep application logger.
 *
 * - Redacts all {@link REDACT_PATHS} with censor {@link REDACT_CENSOR} so
 *   secret material can never serialize.
 * - Merges the active {@link getLogContext} fields (correlationId, requestId,
 *   jobId, ...) into every line via pino `mixin`. Fields passed explicitly to
 *   a log call win over context fields of the same name.
 * - Serializes `Error` values logged under the `err` key with pino's standard
 *   error serializer.
 *
 * @param destination Optional pino destination stream (tests, custom sinks).
 */
export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const { level = "info", pretty = false, base } = options;

  const loggerOptions: LoggerOptions = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    serializers: { err: stdSerializers.err },
    mixin() {
      const ctx = getLogContext();
      return ctx === undefined ? {} : { ...ctx };
    },
  };
  if (base !== undefined) {
    loggerOptions.base = base;
  }

  if (destination !== undefined) {
    return pino(loggerOptions, destination);
  }
  if (pretty) {
    loggerOptions.transport = { target: "pino-pretty" };
  }
  return pino(loggerOptions);
}
