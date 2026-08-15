/**
 * `extractPdfTextLayer` (`pdf-text-layer.ts`) — the poppler-utils
 * `pdftotext` wrapper. Two kinds of coverage:
 *
 * - DI-injected fake `spawn` calls, covering the "binary missing" (ENOENT),
 *   "binary present, text extracted", and "binary present, nonzero exit"
 *   branches deterministically, with no dependency on what happens to be
 *   installed wherever this suite runs;
 * - one real-environment assertion: `pdftotext` is verified NOT installed
 *   in this repo's dev container (`which pdftotext` fails) — the same
 *   degrade-honestly path `tesseract-parser.test.ts`'s "PDF routing" test
 *   exercises end to end, asserted here at this module's own boundary.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { extractPdfTextLayer } from "../src/pdf-text-layer.ts";

/** A minimal fake `ChildProcess` — just enough of the surface `extractPdfTextLayer` touches. */
function fakeChildProcess(): {
  child: ChildProcess;
  emitError: (error: NodeJS.ErrnoException) => void;
  emitClose: (code: number) => void;
  stdoutChunks: Buffer[];
  writtenStdin: Buffer[];
} {
  const emitter = new EventEmitter() as ChildProcess;
  const stdoutChunks: Buffer[] = [];
  const writtenStdin: Buffer[] = [];

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, callback) {
      writtenStdin.push(Buffer.from(chunk as Buffer));
      callback();
    },
  });

  Object.assign(emitter, { stdout, stderr, stdin });

  return {
    child: emitter,
    emitError: (error) => emitter.emit("error", error),
    emitClose: (code) => {
      stdoutChunks.forEach((c) => stdout.push(c));
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", code);
    },
    stdoutChunks,
    writtenStdin,
  };
}

describe("extractPdfTextLayer: binary missing (ENOENT)", () => {
  it("resolves { available: false, text: null } instead of rejecting", async () => {
    const fake = fakeChildProcess();
    const spawnFake = (() => fake.child) as unknown as typeof import("node:child_process").spawn;

    const promise = extractPdfTextLayer(new TextEncoder().encode("%PDF-1.4"), spawnFake);
    fake.emitError(Object.assign(new Error("spawn pdftotext ENOENT"), { code: "ENOENT" }));

    await expect(promise).resolves.toEqual({ available: false, text: null });
  });
});

describe("extractPdfTextLayer: binary present", () => {
  it("returns the extracted text on a clean exit", async () => {
    const fake = fakeChildProcess();
    fake.stdoutChunks.push(Buffer.from("TOTAL 12.99\nTHANK YOU\n"));
    const spawnFake = (() => fake.child) as unknown as typeof import("node:child_process").spawn;

    const promise = extractPdfTextLayer(new TextEncoder().encode("%PDF-1.4"), spawnFake);
    fake.emitClose(0);

    await expect(promise).resolves.toEqual({
      available: true,
      text: "TOTAL 12.99\nTHANK YOU",
    });
    expect(fake.writtenStdin[0]?.toString("utf8")).toBe("%PDF-1.4");
  });

  it("reports { available: true, text: null } for a PDF with no text layer (a scanned PDF)", async () => {
    const fake = fakeChildProcess();
    const spawnFake = (() => fake.child) as unknown as typeof import("node:child_process").spawn;

    const promise = extractPdfTextLayer(new TextEncoder().encode("%PDF-1.4"), spawnFake);
    fake.emitClose(0);

    await expect(promise).resolves.toEqual({ available: true, text: null });
  });

  it("rejects when pdftotext itself errors (nonzero exit)", async () => {
    const fake = fakeChildProcess();
    const spawnFake = (() => fake.child) as unknown as typeof import("node:child_process").spawn;

    const promise = extractPdfTextLayer(new TextEncoder().encode("%PDF-1.4"), spawnFake);
    fake.emitClose(1);

    await expect(promise).rejects.toThrow(/pdftotext exited with code 1/);
  });
});

describe("extractPdfTextLayer: real environment", () => {
  it("this dev container has no pdftotext installed — confirms the graceful-degradation path is live, not merely theoretical", async () => {
    const result = await extractPdfTextLayer(new TextEncoder().encode("%PDF-1.4\n"));
    expect(result).toEqual({ available: false, text: null });
  });
});
