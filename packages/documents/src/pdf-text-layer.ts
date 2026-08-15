/**
 * Existing-PDF-text-layer extraction via poppler-utils' `pdftotext` —
 * design section 3's "PDF handling: extract an existing text layer where
 * one exists rather than OCRing a digital invoice. Only scanned/image PDFs
 * need the OCR path."
 *
 * ## Why a binary, and why this one
 *
 * A digital invoice's PDF already contains its text as glyph outlines with
 * an embedded text layer; running OCR on a rendered page throws that away
 * and re-introduces recognition error for no reason. `pdftotext` reads the
 * layer directly. It is NOT installed in the Loxep image as of this
 * module's implementation (`which pdftotext` fails in this repo's dev
 * container and, per the design, in the shipped image) — poppler-utils
 * (~7 MB) needs an `apt-get install --no-install-recommends poppler-utils`
 * line in `docker/Dockerfile`, which this milestone's write fence does not
 * include (no Docker changes this wave). This module is written to degrade
 * exactly as the design requires when the binary is absent: it reports
 * `available: false` rather than crashing or silently returning no text as
 * if the PDF had none.
 *
 * ## Security: argv array, never a shell string
 *
 * The design calls out `node-tesseract-ocr`'s CVE (OS command injection via
 * `child_process.exec` with a concatenated path) BY NAME as the mistake to
 * never repeat. This module never shells out with an interpolated string —
 * `execFile`/`spawn` with a fixed argv array, and the PDF bytes travel over
 * stdin rather than a filename at all (`pdftotext - -`: read stdin, write
 * stdout), so there is no filename — attacker-controlled or otherwise — for
 * a shell to ever see.
 */
import { spawn } from "node:child_process";

export interface PdfTextLayerResult {
  /** `false` when the `pdftotext` binary could not be found/executed (ENOENT) — distinct from "found the binary but the PDF has no text layer". */
  available: boolean;
  /** `null` when unavailable, or when the PDF genuinely has no text layer (a scanned/image PDF). */
  text: string | null;
}

function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Run `pdftotext - -` over `bytes` (stdin in, stdout out — no temp file, no
 * filename ever crosses the process boundary). Resolves
 * `{ available: false, text: null }` when the binary is missing; resolves
 * `{ available: true, text: null }` when `pdftotext` ran but the layer was
 * empty (a scanned PDF); never rejects for either of those two cases.
 */
export function extractPdfTextLayer(
  bytes: Uint8Array,
  spawnPdftotext: typeof spawn = spawn,
): Promise<PdfTextLayerResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnPdftotext("pdftotext", ["-", "-"], { stdio: ["pipe", "pipe", "pipe"] });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        resolve({ available: false, text: null });
        return;
      }
      reject(error);
    });

    const stdoutPromise = child.stdout ? collectStream(child.stdout) : Promise.resolve(Buffer.alloc(0));
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stdoutPromise
        .then((stdout) => {
          if (code !== 0) {
            reject(
              new Error(
                `pdftotext exited with code ${String(code)}: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`,
              ),
            );
            return;
          }
          const text = stdout.toString("utf8").trim();
          resolve({ available: true, text: text.length > 0 ? text : null });
        })
        .catch(reject);
    });

    child.stdin?.on("error", () => {
      // A closed stdin (e.g. the process exited immediately because the
      // binary is missing) surfaces via the 'error'/'close' handlers above;
      // swallow the EPIPE here so it never becomes an unhandled rejection.
    });
    child.stdin?.end(bytes);
  });
}
