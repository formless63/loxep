#!/usr/bin/env node
/**
 * The accuracy measurement loxep-cd3.4 requires as its FIRST task, before
 * anything else in this milestone is treated as done: "Run the extractor
 * over a stack of REAL receipts early in this milestone and report the
 * error rate. If the text is too poor to search, tier A shipped weight for
 * nothing and the sidecar (loxep-cd3.7) becomes the real tier A."
 *
 * This is a GATED script, deliberately NOT wired into `bun run test` or any
 * package.json script (no synthetic bar to pass, no CI gate — the whole
 * point is that only the OPERATOR's own paper answers this question; no
 * fixture this repo could check in would). Run it by hand:
 *
 * ```sh
 * node packages/documents/scripts/measure-ocr-accuracy.ts <directory> [--json out.json]
 * ```
 *
 * `<directory>` holds receipt images (`.jpg`/`.jpeg`/`.png`/`.webp`/`.pdf`).
 * For any image `name.ext`, an optional `name.txt` beside it is read as
 * ground truth — when present, this script reports character error rate
 * (Levenshtein distance / max(1, ground-truth length)) against it; when
 * absent, it reports word count and average per-word confidence only (still
 * useful: a document that recognizes zero words is failing regardless of
 * whether anyone transcribed it).
 *
 * Uses the SAME `ocr_tesseract` backend `@loxep/documents` registers
 * (`createTesseractParser`) — this script is not a separate code path from
 * production, it is production run manually against real input.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { createTesseractParser, getSharedTesseractWorker } from "../src/tesseract-parser.ts";
import type { TesseractWorkerLike } from "../src/tesseract-parser.ts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);

interface FileResult {
  file: string;
  wordCount: number;
  elapsedMs: number;
  warnings: string[];
  characterErrorRate: number | null;
  text: string | null;
}

/** Levenshtein edit distance — O(n*m), fine at receipt-text scale (hundreds of characters, not megabytes). */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[cols - 1] ?? 0;
}

async function readGroundTruth(imagePath: string): Promise<string | null> {
  const withoutExt = imagePath.slice(0, imagePath.length - extname(imagePath).length);
  try {
    return (await readFile(`${withoutExt}.txt`, "utf8")).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: node measure-ocr-accuracy.ts <directory-of-receipt-images> [--json out.json]");
    process.exitCode = 1;
    return;
  }
  const jsonFlagIndex = process.argv.indexOf("--json");
  const jsonOutPath = jsonFlagIndex >= 0 ? process.argv[jsonFlagIndex + 1] : undefined;

  const entries = await readdir(dir);
  const files = entries
    .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort();

  if (files.length === 0) {
    console.error(`no receipt images (${[...IMAGE_EXTENSIONS].join(", ")}) found in ${dir}`);
    process.exitCode = 1;
    return;
  }

  const parser = createTesseractParser({
    readMedia: (path) => readFile(path),
  });

  const results: FileResult[] = [];
  for (const name of files) {
    const path = join(dir, name);
    const groundTruth = await readGroundTruth(path);
    const t0 = performance.now();
    const result = await parser.parse({ mediaObjectId: path, documentKind: "receipt" });
    const elapsedMs = performance.now() - t0;
    const wordCount = result.text ? result.text.split(/\s+/).filter(Boolean).length : 0;
    const characterErrorRate =
      groundTruth !== null
        ? levenshtein(result.text ?? "", groundTruth) / Math.max(1, groundTruth.length)
        : null;
    results.push({
      file: basename(name),
      wordCount,
      elapsedMs,
      warnings: result.warnings,
      characterErrorRate,
      text: result.text,
    });
    const cerText = characterErrorRate !== null ? `${(characterErrorRate * 100).toFixed(1)}% CER` : "no ground truth";
    console.log(
      `${basename(name).padEnd(28)} words=${String(wordCount).padStart(4)}  ${elapsedMs.toFixed(0).padStart(6)}ms  ${cerText}` +
        (result.warnings.length > 0 ? `  [${result.warnings.join("; ")}]` : ""),
    );
  }

  const withGroundTruth = results.filter((r) => r.characterErrorRate !== null);
  if (withGroundTruth.length > 0) {
    const meanCer =
      withGroundTruth.reduce((sum, r) => sum + (r.characterErrorRate ?? 0), 0) / withGroundTruth.length;
    console.log(`\nmean CER over ${withGroundTruth.length} file(s) with ground truth: ${(meanCer * 100).toFixed(1)}%`);
  }
  const zeroWordFiles = results.filter((r) => r.wordCount === 0);
  if (zeroWordFiles.length > 0) {
    console.log(`\n${zeroWordFiles.length} file(s) recognized ZERO words: ${zeroWordFiles.map((r) => r.file).join(", ")}`);
  }

  if (jsonOutPath !== undefined) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(jsonOutPath, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${jsonOutPath}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The tesseract.js worker runs on a `worker_threads` thread — leaving
    // it un-terminated keeps this CLI's event loop alive forever. A long-
    // running worker process (the future Graphile Worker task) keeps it
    // open on purpose (see tesseract-parser.ts's module doc); a one-shot
    // script must close it explicitly.
    const worker = (await getSharedTesseractWorker()) as unknown as TesseractWorkerLike & {
      terminate: () => Promise<unknown>;
    };
    await worker.terminate();
  });
