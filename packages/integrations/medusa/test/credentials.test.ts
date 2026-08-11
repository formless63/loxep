import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MedusaAdapterError,
  defaultMedusaEnvFilePath,
  loadMedusaCredentialsFromEnvFile,
} from "../src/index.ts";

let tempDir: string | null = null;

function withEnvFile(content: string): string {
  tempDir = mkdtempSync(join(tmpdir(), "loxep-medusa-creds-"));
  const path = join(tempDir, "medusa.env");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("defaultMedusaEnvFilePath", () => {
  it("points at ~/.config/loxep/medusa.env", () => {
    expect(defaultMedusaEnvFilePath()).toMatch(
      /\.config\/loxep\/medusa\.env$/,
    );
  });
});

describe("loadMedusaCredentialsFromEnvFile", () => {
  it("returns null when the file does not exist — the expected state in this environment", () => {
    const missing = join(tmpdir(), "loxep-medusa-env-does-not-exist.env");
    expect(loadMedusaCredentialsFromEnvFile(missing)).toBeNull();
  });

  it("parses a well-formed file, accepting comments/blank lines/quoted values", () => {
    const path = withEnvFile(
      [
        "# a comment",
        "",
        'MEDUSA_URL="https://commerce.example.invalid"',
        "MEDUSA_RO_API_TOKEN=sk_fakefakefakefakefakefakefakefake",
        "",
      ].join("\n"),
    );
    expect(loadMedusaCredentialsFromEnvFile(path)).toEqual({
      baseUrl: "https://commerce.example.invalid",
      apiToken: "sk_fakefakefakefakefakefakefakefake",
    });
  });

  it("accepts the MEDUSA_API_TOKEN / MEDUSA_BASE_URL fallback keys", () => {
    const path = withEnvFile(
      [
        "MEDUSA_BASE_URL=https://commerce.example.invalid",
        "MEDUSA_API_TOKEN=sk_fakefakefakefakefakefakefakefake",
      ].join("\n"),
    );
    expect(loadMedusaCredentialsFromEnvFile(path)).toEqual({
      baseUrl: "https://commerce.example.invalid",
      apiToken: "sk_fakefakefakefakefakefakefakefake",
    });
  });

  it("prefers the _RO_ key over the non-RO fallback when both are present", () => {
    const path = withEnvFile(
      [
        "MEDUSA_URL=https://commerce.example.invalid",
        "MEDUSA_RO_API_TOKEN=sk_readonly",
        "MEDUSA_API_TOKEN=sk_readwrite",
      ].join("\n"),
    );
    expect(loadMedusaCredentialsFromEnvFile(path)?.apiToken).toBe(
      "sk_readonly",
    );
  });

  it("throws invalid_request for a missing required key, without echoing file content", () => {
    const path = withEnvFile("MEDUSA_URL=https://commerce.example.invalid\n");
    try {
      loadMedusaCredentialsFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MedusaAdapterError);
      expect((error as MedusaAdapterError).kind).toBe("invalid_request");
    }
  });

  it("throws invalid_request for a malformed line, reporting only the position", () => {
    const path = withEnvFile("this is not a key=value line\n");
    try {
      loadMedusaCredentialsFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MedusaAdapterError);
      const adapterError = error as MedusaAdapterError;
      expect(adapterError.detail["line"]).toBe(1);
      expect(adapterError.message).not.toContain("this is not a key=value");
    }
  });
});
