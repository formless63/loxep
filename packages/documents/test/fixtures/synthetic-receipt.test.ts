/**
 * The pure-Node PNG fixture generator itself — unit-only, no OCR involved.
 * `tesseract-parser.test.ts`'s real-OCR block is what proves the OUTPUT is
 * actually legible; this file proves the ENCODER is well-formed and
 * deterministic.
 */
import { describe, expect, it } from "vitest";
import { renderTextPng, syntheticReceiptPng } from "./synthetic-receipt.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("renderTextPng", () => {
  it("produces a well-formed PNG signature and IHDR chunk", () => {
    const png = renderTextPng(["TOTAL 12.99"]);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(png.readUInt8(24)).toBe(8); // bit depth
    expect(png.readUInt8(25)).toBe(0); // grayscale
  });

  it("is deterministic: the same input renders byte-identical output", () => {
    const a = renderTextPng(["DATE 2026-08-15", "SALES COST .84"]);
    const b = renderTextPng(["DATE 2026-08-15", "SALES COST .84"]);
    expect(a.equals(b)).toBe(true);
  });

  it("different text renders different bytes", () => {
    const a = renderTextPng(["TOTAL 1.00"]);
    const b = renderTextPng(["TOTAL 2.00"]);
    expect(a.equals(b)).toBe(false);
  });

  it("a larger scale produces a larger image", () => {
    const small = renderTextPng(["TOTAL"], { scale: 2 });
    const large = renderTextPng(["TOTAL"], { scale: 6 });
    expect(large.readUInt32BE(16)).toBeGreaterThan(small.readUInt32BE(16));
    expect(large.length).toBeGreaterThan(small.length);
  });

  it("more lines produce a taller image", () => {
    const one = renderTextPng(["TOTAL 1.00"]);
    const three = renderTextPng(["TOTAL 1.00", "DATE 2026-08-15", "SALES COST .84"]);
    expect(three.readUInt32BE(20)).toBeGreaterThan(one.readUInt32BE(20));
  });

  it("syntheticReceiptPng returns a stable, non-trivial image", () => {
    const png = syntheticReceiptPng();
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.length).toBeGreaterThan(200);
    expect(png.equals(syntheticReceiptPng())).toBe(true);
  });
});
