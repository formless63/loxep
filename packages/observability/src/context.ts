import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Correlation context attached to every log line emitted inside
 * {@link runWithLogContext}. Web request handling sets `requestId`,
 * job handlers set `jobId`; `correlationId` ties a causal chain together
 * across both (e.g. a request that enqueues a job).
 */
export interface LogContext {
  correlationId?: string;
  jobId?: string;
  requestId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Generate a fresh correlation ID (UUID v4). */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Run `fn` with `ctx` as the active log context for the duration of the call
 * (including async continuations started inside it).
 *
 * `correlationId` resolution: the explicit value in `ctx` wins; otherwise the
 * enclosing context's `correlationId` is inherited so nested scopes stay on
 * the same causal chain; otherwise a fresh one is generated. Other fields are
 * not inherited from the enclosing context — `ctx` is authoritative.
 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  const next: LogContext = {
    ...ctx,
    correlationId: ctx.correlationId ?? parent?.correlationId ?? newCorrelationId(),
  };
  return storage.run(next, fn);
}

/** The active log context, or undefined outside {@link runWithLogContext}. */
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}
