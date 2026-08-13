import { describe, expect, it } from "vitest";

describe("@loxep/documents scaffold", () => {
  it("exports a module surface for the document-intake milestone to fill", async () => {
    const surface = await import("../src/index.ts");
    expect(surface).toBeDefined();
  });
});
