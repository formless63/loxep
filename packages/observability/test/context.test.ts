import { describe, expect, it } from "vitest";
import { getLogContext, newCorrelationId, runWithLogContext } from "../src/index.ts";
import { captureLogger } from "./helpers.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("log context", () => {
  it("includes context fields on every line inside runWithLogContext", () => {
    const cap = captureLogger();
    runWithLogContext({ correlationId: "corr-1", requestId: "req-1", userId: "u1" }, () => {
      cap.logger.info("first");
      cap.logger.warn({ extra: true }, "second");
    });
    for (const entry of cap.lines()) {
      expect(entry.correlationId).toBe("corr-1");
      expect(entry.requestId).toBe("req-1");
      expect(entry.userId).toBe("u1");
    }
    expect(cap.lines()).toHaveLength(2);
  });

  it("does not include context fields outside runWithLogContext", () => {
    const cap = captureLogger();
    cap.logger.info("outside");
    const entry = cap.line();
    expect(entry).not.toHaveProperty("correlationId");
    expect(entry).not.toHaveProperty("requestId");
    expect(entry).not.toHaveProperty("jobId");
  });

  it("auto-generates a UUID correlationId when absent", () => {
    const cap = captureLogger();
    runWithLogContext({ jobId: "job-1" }, () => {
      cap.logger.info("in job");
    });
    const entry = cap.line();
    expect(entry.correlationId).toMatch(UUID_RE);
    expect(entry.jobId).toBe("job-1");
  });

  it("preserves an explicitly provided correlationId", () => {
    runWithLogContext({ correlationId: "explicit" }, () => {
      expect(getLogContext()?.correlationId).toBe("explicit");
    });
  });

  it("nested scopes inherit the enclosing correlationId but not other fields", () => {
    runWithLogContext({ requestId: "req-1" }, () => {
      const outer = getLogContext();
      runWithLogContext({ jobId: "job-1" }, () => {
        const inner = getLogContext();
        expect(inner?.correlationId).toBe(outer?.correlationId);
        expect(inner?.jobId).toBe("job-1");
        expect(inner).not.toHaveProperty("requestId");
      });
      expect(getLogContext()?.requestId).toBe("req-1");
      expect(getLogContext()).not.toHaveProperty("jobId");
    });
  });

  it("getLogContext returns undefined outside any scope and the context inside", () => {
    expect(getLogContext()).toBeUndefined();
    runWithLogContext({ requestId: "req-9" }, () => {
      expect(getLogContext()?.requestId).toBe("req-9");
    });
    expect(getLogContext()).toBeUndefined();
  });

  it("propagates the callback return value and follows async continuations", async () => {
    const cap = captureLogger();
    const result = await runWithLogContext({ correlationId: "corr-async" }, async () => {
      await Promise.resolve();
      cap.logger.info("after await");
      return 42;
    });
    expect(result).toBe(42);
    expect(cap.line().correlationId).toBe("corr-async");
  });

  it("explicit log call fields win over context fields of the same name", () => {
    const cap = captureLogger();
    runWithLogContext({ correlationId: "from-context", stage: "ctx" }, () => {
      cap.logger.info({ stage: "call" }, "override");
    });
    const entry = cap.line();
    expect(entry.stage).toBe("call");
    expect(entry.correlationId).toBe("from-context");
  });

  it("redacts secret-named context fields too", () => {
    const cap = captureLogger();
    runWithLogContext({ token: "ctx-secret" }, () => {
      cap.logger.info("context with secret");
    });
    expect(cap.line().token).toBe("[REDACTED]");
  });

  it("newCorrelationId returns unique UUIDs", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});
