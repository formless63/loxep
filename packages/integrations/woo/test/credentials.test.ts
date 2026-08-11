import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  WooAdapterError,
  defaultWooEnvFilePath,
  loadWooCredentialsFromEnvFile,
} from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "loxep-woo-creds-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadWooCredentialsFromEnvFile", () => {
  it("returns null when the file is absent, so tests can skip cleanly", () => {
    expect(loadWooCredentialsFromEnvFile(join(dir, "nope.env"))).toBeNull();
  });

  it("parses the documented key names, comments, blanks, and quotes", () => {
    const path = write(
      "ok.env",
      [
        "# a comment",
        "",
        "WOO_URL=https://shop.example.invalid",
        'WOO_RO_CONSUMER_KEY="ck_aaaa"',
        "WOO_RO_CONSUMER_SECRET='cs_bbbb'",
        "",
      ].join("\n"),
    );
    expect(loadWooCredentialsFromEnvFile(path)).toEqual({
      baseUrl: "https://shop.example.invalid",
      consumerKey: "ck_aaaa",
      consumerSecret: "cs_bbbb",
    });
  });

  it("accepts the non-read-only aliases", () => {
    const path = write(
      "alias.env",
      [
        "WOO_BASE_URL=https://shop.example.invalid",
        "WOO_CONSUMER_KEY=ck_aaaa",
        "WOO_CONSUMER_SECRET=cs_bbbb",
      ].join("\n"),
    );
    expect(loadWooCredentialsFromEnvFile(path)?.consumerKey).toBe("ck_aaaa");
  });

  it("prefers the read-only key when both spellings are present", () => {
    const path = write(
      "both.env",
      [
        "WOO_URL=https://shop.example.invalid",
        "WOO_RO_CONSUMER_KEY=ck_ro",
        "WOO_CONSUMER_KEY=ck_rw",
        "WOO_RO_CONSUMER_SECRET=cs_ro",
      ].join("\n"),
    );
    expect(loadWooCredentialsFromEnvFile(path)?.consumerKey).toBe("ck_ro");
  });

  it("reports a malformed line by POSITION and never echoes its content", () => {
    const secret = "cs_this_must_never_appear_in_an_error";
    const path = write(
      "bad.env",
      ["WOO_URL=https://shop.example.invalid", `this is not ${secret}`].join("\n"),
    );
    let thrown: WooAdapterError | undefined;
    try {
      loadWooCredentialsFromEnvFile(path);
    } catch (error) {
      thrown = error as WooAdapterError;
    }
    expect(thrown).toBeInstanceOf(WooAdapterError);
    expect(thrown?.kind).toBe("invalid_request");
    expect(thrown?.detail["line"]).toBe(2);
    expect(`${thrown?.message}${JSON.stringify(thrown?.detail)}`).not.toContain(
      secret,
    );
  });

  it.each([
    ["url", ["WOO_RO_CONSUMER_KEY=ck", "WOO_RO_CONSUMER_SECRET=cs"]],
    ["key", ["WOO_URL=https://x.invalid", "WOO_RO_CONSUMER_SECRET=cs"]],
    ["secret", ["WOO_URL=https://x.invalid", "WOO_RO_CONSUMER_KEY=ck"]],
  ])("rejects a file missing the %s", (label, lines) => {
    const path = write(`missing-${label}.env`, lines.join("\n"));
    expect(() => loadWooCredentialsFromEnvFile(path)).toThrowError(
      WooAdapterError,
    );
  });

  it("points at the documented default location", () => {
    expect(defaultWooEnvFilePath()).toMatch(
      /\.config[/\\]loxep[/\\]woo-syracusesynergy\.env$/,
    );
  });
});
