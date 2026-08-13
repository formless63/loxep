import { describe, expect, it } from "vitest";
import {
  parseReverbAdapterConfig,
  REVERB_API_BASE_URL,
  reverbSourceAccountKey,
  ReverbAdapterError,
} from "../src/index.ts";

describe("parseReverbAdapterConfig", () => {
  it("accepts a minimal valid config with defaults applied", () => {
    const config = parseReverbAdapterConfig({ personalAccessToken: "pat_abc123" });
    expect(config.personalAccessToken).toBe("pat_abc123");
    expect(config.timeoutMs).toBe(30_000);
  });

  it("rejects an empty personalAccessToken", () => {
    expect(() => parseReverbAdapterConfig({ personalAccessToken: "" })).toThrowError(
      ReverbAdapterError,
    );
  });

  it("rejects an unknown field (strict object)", () => {
    expect(() =>
      parseReverbAdapterConfig({
        personalAccessToken: "pat_abc123",
        // @ts-expect-error deliberately invalid
        baseUrl: "https://example.com",
      }),
    ).toThrowError(ReverbAdapterError);
  });

  it("reports the issue path/code only, never the received token value", () => {
    const secretLookingValue = "pat_should_never_appear_in_detail";
    try {
      parseReverbAdapterConfig({ personalAccessToken: "" });
      throw new Error("expected to throw");
    } catch (error) {
      const detail = JSON.stringify((error as ReverbAdapterError).detail);
      expect(detail).not.toContain(secretLookingValue);
      expect((error as ReverbAdapterError).detail["issues"]).toEqual([
        { path: "personalAccessToken", code: "too_small" },
      ]);
    }
  });
});

describe("REVERB_API_BASE_URL", () => {
  it("is fixed and https", () => {
    expect(REVERB_API_BASE_URL).toBe("https://api.reverb.com/api");
  });
});

describe("reverbSourceAccountKey", () => {
  it("prefixes the connection id", () => {
    expect(reverbSourceAccountKey("conn-123")).toBe("reverb:conn-123");
  });

  it("rejects an empty connectionId", () => {
    expect(() => reverbSourceAccountKey("  ")).toThrowError(ReverbAdapterError);
  });
});
