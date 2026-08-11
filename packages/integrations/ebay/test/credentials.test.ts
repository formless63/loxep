/**
 * Env-file parsing with FAKE values only — the real keyset file is never
 * read by unit tests (only the live sandbox leg loads it, and never prints
 * it).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EbayAdapterError,
  defaultSandboxUserTokenFilePath,
  loadSandboxCredentialsFromEnvFile,
  loadSandboxUserTokenFromFile,
} from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "loxep-ebay-creds-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeEnv(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const VALID = [
  "# comment line",
  "",
  "LOXEP_EBAY_ENV=sandbox",
  "LOXEP_EBAY_APP_ID=FakeApp-fake-SBX-000000000000-00000000",
  'LOXEP_EBAY_CERT_ID="SBX-fakecert-0000-0000-0000-000000000000"',
  "LOXEP_EBAY_DEV_ID='00000000-0000-0000-0000-000000000000'",
  "LOXEP_EBAY_RU_NAME=Fake_Name-FakeApp-SBX-fakefakef-abcdefgh",
].join("\n");

describe("loadSandboxCredentialsFromEnvFile", () => {
  it("parses the documented format, stripping quotes and skipping comments", () => {
    const creds = loadSandboxCredentialsFromEnvFile(writeEnv("valid.env", VALID));
    expect(creds).toEqual({
      appId: "FakeApp-fake-SBX-000000000000-00000000",
      certId: "SBX-fakecert-0000-0000-0000-000000000000",
      devId: "00000000-0000-0000-0000-000000000000",
      ruName: "Fake_Name-FakeApp-SBX-fakefakef-abcdefgh",
      environment: "sandbox",
    });
  });

  it("treats ruName as optional", () => {
    const creds = loadSandboxCredentialsFromEnvFile(
      writeEnv(
        "no-runame.env",
        VALID.split("\n").filter((l) => !l.includes("RU_NAME")).join("\n"),
      ),
    );
    expect(creds?.ruName).toBeUndefined();
  });

  it("returns null when the file does not exist (tests skip cleanly)", () => {
    expect(
      loadSandboxCredentialsFromEnvFile(join(dir, "absent.env")),
    ).toBeNull();
  });

  it("refuses non-sandbox env declarations", () => {
    expect(() =>
      loadSandboxCredentialsFromEnvFile(
        writeEnv("prod.env", VALID.replace("=sandbox", "=production")),
      ),
    ).toThrowError(EbayAdapterError);
  });

  it("throws on missing required keys, reporting the key name only", () => {
    try {
      loadSandboxCredentialsFromEnvFile(
        writeEnv(
          "missing.env",
          VALID.split("\n").filter((l) => !l.includes("CERT_ID")).join("\n"),
        ),
      );
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EbayAdapterError);
      expect((error as EbayAdapterError).message).toContain(
        "LOXEP_EBAY_CERT_ID",
      );
      // Never echoes values.
      expect((error as Error).message).not.toContain("FakeApp");
    }
  });

  it("throws on malformed lines without echoing content", () => {
    try {
      loadSandboxCredentialsFromEnvFile(
        writeEnv("malformed.env", `${VALID}\nthis is not a key value pair`),
      );
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EbayAdapterError);
      expect((error as Error).message).toContain("malformed line");
      expect((error as Error).message).not.toContain("not a key value");
    }
  });
});

describe("loadSandboxUserTokenFromFile", () => {
  const bundle = {
    accessToken: "v^1.1#i^1#FAKE-ACCESS",
    refreshToken: "v^1.1#i^1#FAKE-REFRESH",
    accessTokenExpiresAt: "2026-08-11T12:00:00.000Z",
    refreshTokenExpiresAt: "2028-02-09T22:00:00.000Z",
    scopes: ["https://api.ebay.com/oauth/api_scope"],
  };

  it("defaults to the documented dev artifact path", () => {
    expect(defaultSandboxUserTokenFilePath()).toMatch(
      /\/\.config\/loxep\/ebay-sandbox-user-token\.json$/,
    );
  });

  it("returns null when the artifact does not exist (live tests skip)", () => {
    expect(loadSandboxUserTokenFromFile(join(dir, "absent.json"))).toBeNull();
  });

  it("parses a well-formed bundle", () => {
    expect(
      loadSandboxUserTokenFromFile(
        writeEnv("token.json", JSON.stringify(bundle)),
      ),
    ).toEqual(bundle);
  });

  it("rejects non-JSON and invalid bundles without echoing token values", () => {
    expect(() =>
      loadSandboxUserTokenFromFile(writeEnv("bad.json", "{nope")),
    ).toThrowError(EbayAdapterError);
    try {
      loadSandboxUserTokenFromFile(
        writeEnv(
          "invalid.json",
          JSON.stringify({ ...bundle, accessTokenExpiresAt: "soon" }),
        ),
      );
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EbayAdapterError);
      const serialized = JSON.stringify(error, [
        "message",
        "kind",
        "detail",
        "issues",
        "path",
        "code",
      ]);
      expect(serialized).not.toContain(bundle.accessToken);
      expect(serialized).not.toContain(bundle.refreshToken);
    }
  });
});
