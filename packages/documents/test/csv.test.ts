/**
 * CSV parsing, column-mapping best-guess, row fingerprinting, and row
 * mapping. Unit-only — no database needed.
 */
import { describe, expect, it } from "vitest";
import { computeRowFingerprint, guessColumnMapping, mapCsvRows, parseCsvText } from "../src/index.ts";

describe("parseCsvText", () => {
  it("parses a simple comma-separated file with a header row", () => {
    const result = parseCsvText("Date,Amount,Description\n2026-03-01,12.50,Coffee\n");
    expect(result.headers).toEqual(["Date", "Amount", "Description"]);
    expect(result.rows).toEqual([["2026-03-01", "12.50", "Coffee"]]);
  });

  it("handles quoted fields with embedded commas and doubled-quote escaping", () => {
    const result = parseCsvText(
      'Date,Description,Amount\n2026-03-01,"Staples, Inc.",24.99\n2026-03-02,"He said ""hi""",5.00\n',
    );
    expect(result.rows[0]).toEqual(["2026-03-01", "Staples, Inc.", "24.99"]);
    expect(result.rows[1]).toEqual(["2026-03-02", 'He said "hi"', "5.00"]);
  });

  it("handles CRLF line endings and a trailing blank line", () => {
    const result = parseCsvText("Date,Amount\r\n2026-03-01,1.00\r\n2026-03-02,2.00\r\n");
    expect(result.rows).toHaveLength(2);
  });

  it("pads a short row to the header width", () => {
    const result = parseCsvText("Date,Amount,Description\n2026-03-01,1.00\n");
    expect(result.rows[0]).toEqual(["2026-03-01", "1.00", ""]);
  });
});

describe("guessColumnMapping", () => {
  it("matches common header synonyms case-insensitively", () => {
    const mapping = guessColumnMapping(["Transaction Date", "Total", "Memo", "Vendor", "Currency"]);
    expect(mapping.date).toBe("Transaction Date");
    expect(mapping.amount).toBe("Total");
    expect(mapping.description).toBe("Memo");
    expect(mapping.payee).toBe("Vendor");
    expect(mapping.currency).toBe("Currency");
  });

  it("leaves a field unmapped when no header matches — never a wrong guess", () => {
    const mapping = guessColumnMapping(["Column A", "Column B"]);
    expect(mapping.date).toBeUndefined();
    expect(mapping.amount).toBeUndefined();
  });
});

describe("computeRowFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    const input = { lineDate: "2026-03-01", lineAmount: "12.50", description: "Coffee", payeeName: "Cafe" };
    expect(computeRowFingerprint(input)).toBe(computeRowFingerprint({ ...input }));
  });

  it("is case/whitespace-insensitive on description and payee", () => {
    const a = computeRowFingerprint({
      lineDate: "2026-03-01",
      lineAmount: "12.50",
      description: "  Coffee  ",
      payeeName: "CAFE",
    });
    const b = computeRowFingerprint({
      lineDate: "2026-03-01",
      lineAmount: "12.50",
      description: "coffee",
      payeeName: "cafe",
    });
    expect(a).toBe(b);
  });

  it("differs when the amount differs — two identical coffees at different prices are different rows", () => {
    const a = computeRowFingerprint({ lineDate: "2026-03-01", lineAmount: "4.50", description: "Coffee", payeeName: null });
    const b = computeRowFingerprint({ lineDate: "2026-03-01", lineAmount: "4.75", description: "Coffee", payeeName: null });
    expect(a).not.toBe(b);
  });

  it("is IDENTICAL for two genuinely identical rows — the design's 'two coffees same day' case is expected to collide", () => {
    const a = computeRowFingerprint({ lineDate: "2026-03-01", lineAmount: "4.50", description: "Coffee", payeeName: "Cafe" });
    const b = computeRowFingerprint({ lineDate: "2026-03-01", lineAmount: "4.50", description: "Coffee", payeeName: "Cafe" });
    expect(a).toBe(b);
  });
});

describe("mapCsvRows", () => {
  it("maps a clean row through the mapping with normalized money and date", () => {
    const parsed = parseCsvText("Date,Amount,Description,Vendor\n3/5/2026,$12.50,Coffee,Cafe\n");
    const mapping = { date: "Date", amount: "Amount", description: "Description", payee: "Vendor" };
    const [row] = mapCsvRows(parsed, mapping, { defaultCurrency: "USD" });
    expect(row).toBeDefined();
    expect(row?.lineDate).toBe("2026-03-05");
    expect(row?.lineAmount).toBe("12.50");
    expect(row?.description).toBe("Coffee");
    expect(row?.payeeName).toBe("Cafe");
    expect(row?.currency).toBe("USD");
    expect(row?.rowWarnings).toEqual([]);
  });

  it("warns, never drops, a row whose amount fails to normalize", () => {
    const parsed = parseCsvText("Date,Amount,Description\n2026-03-01,N/A,Mystery\n");
    const mapping = { date: "Date", amount: "Amount", description: "Description" };
    const [row] = mapCsvRows(parsed, mapping);
    expect(row).toBeDefined();
    expect(row?.lineAmount).toBeNull();
    expect(row?.rowWarnings.length).toBeGreaterThan(0);
  });

  it("warns on a row with no amount at all", () => {
    const parsed = parseCsvText("Date,Amount\n2026-03-01,\n");
    const mapping = { date: "Date", amount: "Amount" };
    const [row] = mapCsvRows(parsed, mapping);
    expect(row?.rowWarnings).toContain("row has no amount");
  });

  it("assigns sequential line numbers from 1", () => {
    const parsed = parseCsvText("Amount\n1.00\n2.00\n3.00\n");
    const rows = mapCsvRows(parsed, { amount: "Amount" });
    expect(rows.map((r) => r.lineNumber)).toEqual([1, 2, 3]);
  });

  it("uses each row's own currency column over the default when both are present", () => {
    const parsed = parseCsvText("Amount,Currency\n1.00,GBP\n");
    const [row] = mapCsvRows(parsed, { amount: "Amount", currency: "Currency" }, { defaultCurrency: "USD" });
    expect(row?.currency).toBe("GBP");
  });
});
