import { Writable } from "node:stream";
import type { Logger } from "pino";
import { createLogger } from "../src/index.ts";
import type { CreateLoggerOptions } from "../src/index.ts";

export interface CapturedLogger {
  logger: Logger;
  /** Parsed JSON log lines written so far. */
  lines: () => Record<string, unknown>[];
  /** The single line at `index` (default: only line), asserting it exists. */
  line: (index?: number) => Record<string, unknown>;
}

/** Create a logger writing to an in-memory sink of parsed JSON lines. */
export function captureLogger(options: CreateLoggerOptions = {}): CapturedLogger {
  const raw: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      raw.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createLogger(options, sink);
  const lines = (): Record<string, unknown>[] =>
    raw
      .join("")
      .split("\n")
      .filter((entry) => entry.length > 0)
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  return {
    logger,
    lines,
    line: (index = 0) => {
      const parsed = lines();
      const entry = parsed[index];
      if (entry === undefined) {
        throw new Error(`expected a log line at index ${index}, got ${parsed.length} lines`);
      }
      return entry;
    },
  };
}
