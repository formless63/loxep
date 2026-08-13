import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDevCredentialsFromEnvFile, ReverbAdapterError } from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loxep-reverb-credentials-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadDevCredentialsFromEnvFile", () => {
  it("returns null when the file does not exist", () => {
    expect(loadDevCredentialsFromEnvFile(join(dir, "missing.env"))).toBeNull();
  });

  it("parses the token, ignoring comments and blank lines", () => {
    const path = join(dir, "reverb.env");
    writeFileSync(
      path,
      ["# a comment", "", "LOXEP_REVERB_PERSONAL_ACCESS_TOKEN='fake-token'", ""].join("\n"),
    );
    expect(loadDevCredentialsFromEnvFile(path)).toEqual({
      personalAccessToken: "fake-token",
    });
  });

  it("throws invalid_request on a malformed line without echoing content", () => {
    const path = join(dir, "bad.env");
    writeFileSync(path, "not a key value line\n");
    try {
      loadDevCredentialsFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ReverbAdapterError);
      expect(JSON.stringify((error as ReverbAdapterError).detail)).not.toContain(
        "not a key value line",
      );
    }
  });

  it("throws when the required key is missing", () => {
    const path = join(dir, "partial.env");
    writeFileSync(path, "SOME_OTHER_KEY=value\n");
    expect(() => loadDevCredentialsFromEnvFile(path)).toThrowError(ReverbAdapterError);
  });

  it("throws when the required key is present but empty", () => {
    const path = join(dir, "empty.env");
    writeFileSync(path, "LOXEP_REVERB_PERSONAL_ACCESS_TOKEN=\n");
    expect(() => loadDevCredentialsFromEnvFile(path)).toThrowError(ReverbAdapterError);
  });
});
