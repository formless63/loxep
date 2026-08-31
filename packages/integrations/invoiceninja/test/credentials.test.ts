import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvoiceNinjaAdapterError,
  defaultInvoiceNinjaEnvFilePath,
  loadInvoiceNinjaCredentialsFromEnvFile,
} from "../src/index.ts";

let tempDir: string | null = null;

function withEnvFile(content: string): string {
  tempDir = mkdtempSync(join(tmpdir(), "loxep-invoiceninja-creds-"));
  const path = join(tempDir, "invoiceninja.env");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("defaultInvoiceNinjaEnvFilePath", () => {
  it("points at ~/.config/loxep/invoiceninja.env", () => {
    expect(defaultInvoiceNinjaEnvFilePath()).toMatch(
      /\.config\/loxep\/invoiceninja\.env$/,
    );
  });
});

describe("loadInvoiceNinjaCredentialsFromEnvFile", () => {
  it("returns null when the file does not exist", () => {
    const missing = join(tmpdir(), "loxep-invoiceninja-env-does-not-exist.env");
    expect(loadInvoiceNinjaCredentialsFromEnvFile(missing)).toBeNull();
  });

  it("parses a well-formed file, accepting comments/blank lines/quoted values", () => {
    const path = withEnvFile(
      [
        "# a comment",
        "",
        'INVOICENINJA_URL="https://billing.example.invalid"',
        "INVOICENINJA_RO_API_TOKEN=fakefakefakefakefakefakefakefakefakefakefakefake",
        "",
      ].join("\n"),
    );
    expect(loadInvoiceNinjaCredentialsFromEnvFile(path)).toEqual({
      baseUrl: "https://billing.example.invalid",
      apiToken: "fakefakefakefakefakefakefakefakefakefakefakefake",
    });
  });

  it("accepts the INVOICENINJA_API_TOKEN / INVOICENINJA_BASE_URL fallback keys", () => {
    const path = withEnvFile(
      [
        "INVOICENINJA_BASE_URL=https://billing.example.invalid",
        "INVOICENINJA_API_TOKEN=fakefakefakefakefakefakefakefakefakefakefakefake",
      ].join("\n"),
    );
    expect(loadInvoiceNinjaCredentialsFromEnvFile(path)).toEqual({
      baseUrl: "https://billing.example.invalid",
      apiToken: "fakefakefakefakefakefakefakefakefakefakefakefake",
    });
  });

  it("prefers the _RO_ key over the non-RO fallback when both are present", () => {
    const path = withEnvFile(
      [
        "INVOICENINJA_URL=https://billing.example.invalid",
        "INVOICENINJA_RO_API_TOKEN=readonlytokenfakefakefakefakefakefake",
        "INVOICENINJA_API_TOKEN=readwritetokenfakefakefakefakefakefake",
      ].join("\n"),
    );
    expect(loadInvoiceNinjaCredentialsFromEnvFile(path)?.apiToken).toBe(
      "readonlytokenfakefakefakefakefakefake",
    );
  });

  it("throws invalid_request for a missing required key, without echoing file content", () => {
    const path = withEnvFile("INVOICENINJA_URL=https://billing.example.invalid\n");
    try {
      loadInvoiceNinjaCredentialsFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceNinjaAdapterError);
      expect((error as InvoiceNinjaAdapterError).kind).toBe("invalid_request");
    }
  });

  it("throws invalid_request for a malformed line, reporting only the position", () => {
    const path = withEnvFile("this is not a key=value line\n");
    try {
      loadInvoiceNinjaCredentialsFromEnvFile(path);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceNinjaAdapterError);
      const adapterError = error as InvoiceNinjaAdapterError;
      expect(adapterError.detail["line"]).toBe(1);
      expect(adapterError.message).not.toContain("this is not a key=value");
    }
  });
});
