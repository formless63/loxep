/**
 * `document_line_candidates.source_region`'s serialization format — fixed
 * here, deliberately, because nothing fixed it before.
 *
 * The column has existed since migration 0017 (`expense-entry-design.md`'s
 * "shipped and unreachable" list) with no writer and no reader: `documents.ts`'s
 * `insertCandidates`/`recordParseResult` already `JSON.stringify`s a
 * {@link ParseResultLine.sourceRegion} when a parser supplies one, but no
 * backend has ever supplied one (`manual-parser.ts` and — until this
 * milestone — `tesseract-parser.ts` both always return `sourceRegion:
 * undefined`). Tier B (loxep-cd3.5, M5) is the first thing that populates it
 * for real, which the design's own "contradictions" section calls out by
 * name: "whoever writes the first backend fixes the format for everyone."
 *
 * **The fixed format: a JSON object, `{"page":1,"x":12,"y":34,"w":56,"h":78}`.**
 * All five fields are always present and are plain (non-negative) numbers.
 * `x`/`y`/`w`/`h` are pixel coordinates in the SOURCE image's own coordinate
 * space — exactly what Tesseract's `tsv` output already reports (`left`/
 * `top`/`width`/`height`), so {@link tesseractLinesFromRawOutput} (`tsv-lines.ts`)
 * needs no unit conversion. `page` is 1-based; every backend that exists
 * today (`ocr_tesseract`'s image path) processes one page per call, so it is
 * always `1`, but the field is carried through for a future multi-page
 * backend (a PDF rasterizer, say) rather than assumed away.
 *
 * The column stays `text`, not `jsonb` (the schema comment's own reasoning:
 * "nothing but the review UI reads it" — a free-form attribute bag was
 * explicitly declined). {@link serializeSourceRegion}/{@link parseSourceRegion}
 * are the ONLY two functions that should ever touch that string; every
 * writer and every reader in this codebase should go through them rather
 * than reimplementing `JSON.stringify`/`JSON.parse` at the call site, so a
 * future format change (adding a unit flag, say) has exactly two functions
 * to update.
 */
import { z } from "zod";

/** Mirrors `ParseResultLine.sourceRegion` (`parser.ts`) field-for-field. */
export const sourceRegionSchema = z.strictObject({
  page: z.number().int().positive(),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export type SourceRegion = z.infer<typeof sourceRegionSchema>;

/** `null` in, `null` out — a candidate with no known position (manual entry, a CSV row) stores no region at all. */
export function serializeSourceRegion(region: SourceRegion | null | undefined): string | null {
  if (region === null || region === undefined) return null;
  const value = sourceRegionSchema.parse(region);
  return JSON.stringify(value);
}

/**
 * Parses `document_line_candidates.source_region` back into a
 * {@link SourceRegion}. Deliberately lenient on malformed input — a
 * corrupted or hand-edited row should degrade to "no box drawn", never
 * throw and break the review UI — so this returns `null` rather than
 * raising on invalid JSON or a shape that fails {@link sourceRegionSchema}.
 */
export function parseSourceRegion(raw: string | null | undefined): SourceRegion | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = sourceRegionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
