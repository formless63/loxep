import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EtsyAdapterError,
  loadDevKeysetFromEnvFile,
  loadDevUserTokenFromFile,
} from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loxep-etsy-credentials-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadDevKeysetFromEnvFile", () => {
  it("returns null when the file does not exist", () => {
    expect(loadDevKeysetFromEnvFile(join(dir, "missing.env"))).toBeNull();
  });

  it("parses keystring/sharedSecret, ignoring comments and blank lines", () => {
    const path = join(dir, "etsy-sandbox.env");
    writeFileSync(
      path,
      [
        "# a comment",
        "",
        "LOXEP_ETSY_KEYSTRING=fake-keystring",
        "LOXEP_ETSY_SHARED_SECRET='fake-shared-secret'",
        "",
      ].join("\n"),
    );
    expect(loadDevKeysetFromEnvFile(path)).toEqual({
      keystring: "fake-keystring",
      sharedSecret: "fake-shared-secret",
    });
  });

  it("throws invalid_request on a malformed line without echoing content", () => {
    const path = join(dir, "bad.env");
    writeFileSync(path, "not a key value line\n");
    try {
      loadDevKeysetFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EtsyAdapterError);
      expect(JSON.stringify((error as EtsyAdapterError).detail)).not.toContain(
        "not a key value line",
      );
    }
  });

  it("throws when a required key is missing", () => {
    const path = join(dir, "partial.env");
    writeFileSync(path, "LOXEP_ETSY_KEYSTRING=only-one\n");
    expect(() => loadDevKeysetFromEnvFile(path)).toThrowError(EtsyAdapterError);
  });
});

describe("loadDevUserTokenFromFile", () => {
  it("returns null when the file does not exist", () => {
    expect(loadDevUserTokenFromFile(join(dir, "missing.json"))).toBeNull();
  });

  it("parses a valid bundle", () => {
    const path = join(dir, "token.json");
    const bundle = {
      etsyUserId: "111222333",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      accessTokenExpiresAt: "2026-08-13T12:00:00.000Z",
      refreshTokenExpiresAt: null,
      scopes: ["shops_r", "listings_r"],
    };
    writeFileSync(path, JSON.stringify(bundle));
    expect(loadDevUserTokenFromFile(path)).toEqual(bundle);
  });

  it("throws invalid_request on malformed JSON", () => {
    const path = join(dir, "invalid.json");
    writeFileSync(path, "{not json");
    expect(() => loadDevUserTokenFromFile(path)).toThrowError(EtsyAdapterError);
  });
});
