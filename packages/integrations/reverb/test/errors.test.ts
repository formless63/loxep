import { describe, expect, it } from "vitest";
import {
  normalizeReverbError,
  readReverbErrorBody,
  ReverbAdapterError,
  reverbErrorFromResponse,
  reverbKindFromStatus,
} from "../src/index.ts";

describe("readReverbErrorBody", () => {
  it("extracts message and field errors", () => {
    const body = { message: "Parameters are missing or invalid", errors: { name: ["is required"] } };
    expect(readReverbErrorBody(body)).toEqual({
      message: "Parameters are missing or invalid",
      errors: { name: ["is required"] },
    });
  });

  it("returns nulls for a body with no message/errors", () => {
    expect(readReverbErrorBody({ foo: "bar" })).toEqual({ message: null, errors: null });
  });

  it("returns nulls for a non-object body", () => {
    expect(readReverbErrorBody("oops")).toEqual({ message: null, errors: null });
    expect(readReverbErrorBody(null)).toEqual({ message: null, errors: null });
  });

  it("ignores an errors field whose values are not string arrays", () => {
    expect(readReverbErrorBody({ message: "m", errors: { name: "not an array" } })).toEqual({
      message: "m",
      errors: null,
    });
  });
});

describe("reverbKindFromStatus", () => {
  it.each([
    [400, "invalid_request"],
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [412, "invalid_request"],
    [422, "invalid_request"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [502, "provider_unavailable"],
    [undefined, "provider_unavailable"],
  ] as const)("maps status %s to kind %s", (status, kind) => {
    expect(reverbKindFromStatus(status)).toBe(kind);
  });
});

describe("reverbErrorFromResponse", () => {
  it("builds a rate_limited error with no retryAfterSeconds (Reverb documents no header)", () => {
    const error = reverbErrorFromResponse(
      429,
      { message: "wait and try again" },
      { operation: "listings.get", path: "/listings/1" },
    );
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["retryAfterSeconds"]).toBeUndefined();
    expect(error.detail["providerMessage"]).toBe("wait and try again");
  });

  it("carries field-level errors in detail", () => {
    const error = reverbErrorFromResponse(
      400,
      { message: "invalid", errors: { title: ["can't be blank"] } },
      { operation: "listings.get", path: "/listings/1" },
    );
    expect(error.detail["providerFieldErrors"]).toEqual({ title: ["can't be blank"] });
  });

  it("flags an unrecognized body shape without inventing a message", () => {
    const error = reverbErrorFromResponse(500, { unexpected: true }, {
      operation: "listings.get",
      path: "/listings/1",
    });
    expect(error.detail["providerBodyShape"]).toBe("not-a-reverb-error");
    expect(error.detail["providerMessage"]).toBeUndefined();
  });
});

describe("normalizeReverbError", () => {
  it("passes an existing ReverbAdapterError through unchanged", () => {
    const original = new ReverbAdapterError("auth", "nope");
    expect(normalizeReverbError(original, { operation: "x", path: "/x" })).toBe(original);
  });

  it("maps AbortError to provider_unavailable", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const normalized = normalizeReverbError(err, { operation: "x", path: "/x" });
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorName"]).toBe("AbortError");
  });

  it("reduces an unknown Error to name/message/code without leaking extra properties", () => {
    const err = Object.assign(new Error("ECONNRESET"), {
      code: "ECONNRESET",
      request: { headers: { authorization: "Bearer secret" } },
    });
    const normalized = normalizeReverbError(err, { operation: "x", path: "/x" });
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorCode"]).toBe("ECONNRESET");
    expect(JSON.stringify(normalized.detail)).not.toContain("secret");
  });

  it("handles a non-Error thrown value", () => {
    const normalized = normalizeReverbError("boom", { operation: "x", path: "/x" });
    expect(normalized.kind).toBe("provider_unavailable");
  });
});
