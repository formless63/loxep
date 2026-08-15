/**
 * Tests for the dev/test env-file loader. Never touches the real
 * `~/.config/loxep/pangolin.env` — every case uses a scratch file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PangolinAdapterError, loadPangolinCredentialsFromEnvFile } from "../src/index.ts";

let dir: string | null = null;

function writeEnvFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "pangolin-credentials-test-"));
  const path = join(dir, "pangolin.env");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("loadPangolinCredentialsFromEnvFile", () => {
  it("returns null when the file does not exist", () => {
    expect(loadPangolinCredentialsFromEnvFile("/nonexistent/pangolin.env")).toBeNull();
  });

  it("parses the owner's real file shape: PANGOLIN_API_KEY as one combined <id>.<secret> value", () => {
    const path = writeEnvFile(
      [
        "PANGOLIN_API_KEY=99nfitsqgw5ry5t.duavlsls2x65scs22zw26qqld7opwkuyka6opzmd",
        "PANGOLIN_KEY_NAME=prod-primary",
        "PANGOLIN_URL=https://pangolin.example.com",
      ].join("\n"),
    );
    const credentials = loadPangolinCredentialsFromEnvFile(path);
    expect(credentials).toEqual({
      baseUrl: "https://pangolin.example.com",
      apiKeyId: "99nfitsqgw5ry5t",
      apiKeySecret: "duavlsls2x65scs22zw26qqld7opwkuyka6opzmd",
      keyName: "prod-primary",
    });
  });

  it("splits on the FIRST dot only, preserving a secret that itself contains a dot", () => {
    const path = writeEnvFile(["PANGOLIN_API_KEY=abc.def.ghi", "PANGOLIN_URL=https://pangolin.example.com"].join("\n"));
    const credentials = loadPangolinCredentialsFromEnvFile(path);
    expect(credentials?.apiKeyId).toBe("abc");
    expect(credentials?.apiKeySecret).toBe("def.ghi");
  });

  it("reads an optional PANGOLIN_ORG_ID", () => {
    const path = writeEnvFile(
      ["PANGOLIN_API_KEY=abc.def", "PANGOLIN_URL=https://pangolin.example.com", "PANGOLIN_ORG_ID=home-lab"].join(
        "\n",
      ),
    );
    expect(loadPangolinCredentialsFromEnvFile(path)?.orgId).toBe("home-lab");
  });

  it("throws invalid_request when PANGOLIN_URL is missing", () => {
    const path = writeEnvFile("PANGOLIN_API_KEY=abc.def");
    expect(() => loadPangolinCredentialsFromEnvFile(path)).toThrowError(PangolinAdapterError);
  });

  it("throws invalid_request when PANGOLIN_API_KEY is missing", () => {
    const path = writeEnvFile("PANGOLIN_URL=https://pangolin.example.com");
    expect(() => loadPangolinCredentialsFromEnvFile(path)).toThrowError(PangolinAdapterError);
  });

  it("throws invalid_request when the key has no dot at all", () => {
    const path = writeEnvFile(["PANGOLIN_API_KEY=nodothere", "PANGOLIN_URL=https://pangolin.example.com"].join("\n"));
    expect(() => loadPangolinCredentialsFromEnvFile(path)).toThrowError(PangolinAdapterError);
  });

  it("never throws content into its error message", () => {
    const path = writeEnvFile("this is not = a valid line = at all");
    try {
      loadPangolinCredentialsFromEnvFile(path);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("this is not");
    }
  });
});
