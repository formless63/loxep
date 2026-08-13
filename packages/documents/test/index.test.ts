import { describe, expect, it } from "vitest";
import * as surface from "../src/index.ts";

/**
 * The seed test this milestone replaces: a smoke check that the package's
 * public surface exports exactly what the design promises, and — the
 * structural half of the never-auto-commit proof (see
 * `never-auto-commit.test.ts` for the behavioral half) — nothing that would
 * write an `expenses`, `acquisitions`, or `inventory_items` row.
 */
describe("@loxep/documents public surface", () => {
  it("exports the parser interface's pluggable-registry constructor and the manual backend", () => {
    expect(surface.createParserRegistry).toBeTypeOf("function");
    expect(surface.manualParser.id).toBe("manual");
  });

  it("exports the CSV staging helpers", () => {
    expect(surface.parseCsvText).toBeTypeOf("function");
    expect(surface.guessColumnMapping).toBeTypeOf("function");
    expect(surface.computeRowFingerprint).toBeTypeOf("function");
    expect(surface.mapCsvRows).toBeTypeOf("function");
  });

  it("exports the documents and candidates service factories", () => {
    expect(surface.createDocumentsService).toBeTypeOf("function");
    expect(surface.createCandidatesService).toBeTypeOf("function");
  });

  it("exports no function whose name suggests a write to a consuming domain's table", () => {
    const suspiciousNames = /create.*expense|create.*acquisition|create.*inventoryItem|confirmCandidatesAs/i;
    const exportNames = Object.keys(surface);
    const offenders = exportNames.filter((name) => suspiciousNames.test(name));
    expect(offenders).toEqual([]);
  });
});
