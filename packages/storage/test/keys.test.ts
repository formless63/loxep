/**
 * Unit tests for storage-key validation/generation (no DB, no endpoint).
 */
import { describe, expect, it } from "vitest";
import {
  StorageKeyError,
  generateMediaStorageKey,
  validateStorageKey,
  validateStorageKeyPrefix,
} from "../src/index.ts";

describe("validateStorageKey", () => {
  it("accepts ordinary generated keys", () => {
    expect(
      validateStorageKey("media/ab/12/ab12cd34-0000-4000-8000-000000000000"),
    ).toBeTypeOf("string");
    expect(validateStorageKey("exports/2026/report.pdf")).toBeTypeOf("string");
    expect(validateStorageKey("ünïcode/文件-📦.bin")).toBeTypeOf("string");
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["dot-dot segment", "media/../../etc/passwd"],
    ["single dot segment", "media/./x"],
    ["trailing slash", "media/x/"],
    ["empty segment", "media//x"],
    ["backslash", "media\\x"],
    ["control character", "media/\u0007bell"],
    ["reserved tmp segment", ".loxep-tmp/x"],
    ["overlong", `media/${"a".repeat(1030)}`],
  ])("rejects %s keys", (_label, key) => {
    expect(() => validateStorageKey(key)).toThrow(StorageKeyError);
  });
});

describe("validateStorageKeyPrefix", () => {
  it("accepts empty, partial, and trailing-slash prefixes", () => {
    expect(validateStorageKeyPrefix("")).toBe("");
    expect(validateStorageKeyPrefix("media/ab")).toBe("media/ab");
    expect(validateStorageKeyPrefix("media/ab/")).toBe("media/ab/");
  });

  it("rejects traversal prefixes", () => {
    expect(() => validateStorageKeyPrefix("../x")).toThrow(StorageKeyError);
    expect(() => validateStorageKeyPrefix("/abs")).toThrow(StorageKeyError);
  });
});

describe("generateMediaStorageKey", () => {
  it("splits the UUID prefix into two directory levels", () => {
    const id = "AB12CD34-0000-4000-8000-000000000000";
    expect(generateMediaStorageKey(id)).toBe(
      "media/ab/12/ab12cd34-0000-4000-8000-000000000000",
    );
  });

  it("rejects non-UUID input", () => {
    expect(() => generateMediaStorageKey("../../etc")).toThrow(
      StorageKeyError,
    );
  });
});
