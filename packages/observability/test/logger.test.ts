import { describe, expect, it } from "vitest";
import { serializeError } from "../src/index.ts";
import { captureLogger } from "./helpers.ts";

describe("createLogger", () => {
  it("emits structured JSON with level, time, and msg", () => {
    const cap = captureLogger();
    cap.logger.info("hello");
    const entry = cap.line();
    expect(entry.level).toBe(30);
    expect(typeof entry.time).toBe("number");
    expect(entry.msg).toBe("hello");
  });

  it("respects the level option", () => {
    const cap = captureLogger({ level: "warn" });
    cap.logger.info("suppressed");
    cap.logger.warn("kept");
    expect(cap.lines()).toHaveLength(1);
    expect(cap.line().msg).toBe("kept");
  });

  it("applies base fields to every line", () => {
    const cap = captureLogger({ base: { service: "loxep", mode: "worker" } });
    cap.logger.info("with base");
    const entry = cap.line();
    expect(entry.service).toBe("loxep");
    expect(entry.mode).toBe("worker");
  });

  it("serializes Error instances under the err key with type, message, and stack", () => {
    const cap = captureLogger();
    const boom = new Error("boom");
    cap.logger.error({ err: boom }, "failed");
    const err = cap.line().err as Record<string, unknown>;
    expect(err.type).toBe("Error");
    expect(err.message).toBe("boom");
    expect(String(err.stack)).toContain("Error: boom");
  });

  it("redacts secret-named enumerable properties carried on logged errors", () => {
    const cap = captureLogger();
    const err = Object.assign(new Error("api failure"), { token: "leaked-token" });
    cap.logger.error({ err }, "provider call failed");
    const serialized = cap.line().err as Record<string, unknown>;
    expect(serialized.token).toBe("[REDACTED]");
    expect(JSON.stringify(cap.line())).not.toContain("leaked-token");
  });
});

describe("serializeError", () => {
  it("produces { message, name, stack } for a plain Error", () => {
    const out = serializeError(new Error("boom"));
    expect(out.message).toBe("boom");
    expect(out.name).toBe("Error");
    expect(out.stack).toContain("Error: boom");
    expect(out).not.toHaveProperty("code");
  });

  it("captures string and number code properties", () => {
    const withStringCode = Object.assign(new Error("no file"), { code: "ENOENT" });
    expect(serializeError(withStringCode).code).toBe("ENOENT");
    const withNumberCode = Object.assign(new Error("db"), { code: 23505 });
    expect(serializeError(withNumberCode).code).toBe(23505);
  });

  it("preserves subclass names", () => {
    const out = serializeError(new TypeError("bad type"));
    expect(out.name).toBe("TypeError");
  });

  it("handles non-Error values without throwing", () => {
    expect(serializeError("just a string")).toEqual({ message: "just a string", name: "NonError" });
    expect(serializeError(undefined)).toEqual({ message: "undefined", name: "NonError" });
    expect(serializeError({ weird: true }).name).toBe("NonError");
  });
});
