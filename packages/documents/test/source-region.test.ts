/**
 * `source-region.ts` — the serialization format loxep-cd3.5 (M5) fixes for
 * `document_line_candidates.source_region`, unit-tested per the milestone's
 * own "unit tests for the source_region serialization round-trip" ask.
 */
import { describe, expect, it } from "vitest";
import { parseSourceRegion, serializeSourceRegion, sourceRegionSchema } from "../src/source-region.ts";

describe("serializeSourceRegion / parseSourceRegion", () => {
  it("round-trips a region through the exact fixed shape", () => {
    const region = { page: 1, x: 12, y: 34, w: 56, h: 78 };
    const serialized = serializeSourceRegion(region);
    expect(serialized).toBe(JSON.stringify(region));
    expect(parseSourceRegion(serialized)).toEqual(region);
  });

  it("serializes null/undefined to null, and parses null back to null", () => {
    expect(serializeSourceRegion(null)).toBeNull();
    expect(serializeSourceRegion(undefined)).toBeNull();
    expect(parseSourceRegion(null)).toBeNull();
    expect(parseSourceRegion(undefined)).toBeNull();
  });

  it("round-trips a multi-page region (page carried through even though every current backend emits page 1)", () => {
    const region = { page: 3, x: 0, y: 0, w: 100.5, h: 20.25 };
    expect(parseSourceRegion(serializeSourceRegion(region))).toEqual(region);
  });

  it("rejects an out-of-shape region at serialize time rather than writing garbage", () => {
    expect(() =>
      serializeSourceRegion({ page: 0, x: 1, y: 1, w: 1, h: 1 }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error deliberately missing a field
      serializeSourceRegion({ page: 1, x: 1, y: 1, w: 1 }),
    ).toThrow();
  });

  it("degrades malformed stored JSON to null rather than throwing (a corrupted row must not break the review UI)", () => {
    expect(parseSourceRegion("not json")).toBeNull();
    expect(parseSourceRegion("{}")).toBeNull();
    expect(parseSourceRegion('{"page":1,"x":1,"y":1,"w":1}')).toBeNull();
    expect(parseSourceRegion('{"page":-1,"x":1,"y":1,"w":1,"h":1}')).toBeNull();
    expect(parseSourceRegion('{"page":1,"x":1,"y":1,"w":1,"h":1,"extra":true}')).toBeNull();
  });

  it("sourceRegionSchema is strict — an extra field fails validation", () => {
    const result = sourceRegionSchema.safeParse({ page: 1, x: 1, y: 1, w: 1, h: 1, z: 9 });
    expect(result.success).toBe(false);
  });
});
