/**
 * `createParserRegistry` — the pluggable-backend contract's registry.
 * Unit-only — no database needed.
 */
import { describe, expect, it } from "vitest";
import { createParserRegistry, DocumentsNotFoundError, manualParser } from "../src/index.ts";
import type { ReceiptParser } from "../src/index.ts";

describe("createParserRegistry", () => {
  it("registers the manual backend and returns it by id", () => {
    const registry = createParserRegistry([manualParser]);
    expect(registry.get("manual")).toBe(manualParser);
    expect(registry.list()).toEqual([manualParser]);
  });

  it("throws a DocumentsNotFoundError for an unregistered backend id", () => {
    const registry = createParserRegistry([manualParser]);
    expect(() => registry.get("ocr_tesseract")).toThrow(DocumentsNotFoundError);
  });

  it("a future backend is just another registered ReceiptParser — the interface makes it pluggable, not this package", () => {
    const stub: ReceiptParser = {
      id: "ocr_tesseract",
      label: "Tesseract OCR (stub)",
      parse: async (input) => ({
        parserId: "ocr_tesseract",
        parsedAt: new Date(),
        currency: null,
        documentTotal: null,
        lines: [
          {
            description: "stubbed line",
            quantity: null,
            unitAmount: null,
            lineAmount: "1.00",
            confidence: 0.5,
          },
        ],
        warnings: [],
      }),
    };
    const registry = createParserRegistry([manualParser, stub]);
    expect(registry.get("ocr_tesseract")).toBe(stub);
    expect(registry.list()).toHaveLength(2);
  });

  it("refuses duplicate parser ids at construction", () => {
    expect(() => createParserRegistry([manualParser, manualParser])).toThrow();
  });
});
