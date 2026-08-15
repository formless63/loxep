/**
 * LOXEP_LIVE_TESTS opt-in gate for this package's live-integration test(s).
 *
 * A live test needs BOTH its credential file AND this flag before it is
 * allowed to talk to a real instance. Duplicated per package rather than
 * centralized, mirroring this repo's existing norm — see any sibling
 * package's identical `live-gate.ts` for the full rationale. Do not "DRY"
 * this into a shared package without re-weighing that tradeoff.
 */

/**
 * Parses `LOXEP_LIVE_TESTS` and reports whether `slug` is opted in.
 *
 * - unset, empty, "0", or "false" (case-insensitive) -> nothing is opted in,
 *   regardless of credentials.
 * - "1", "all", or "true" (case-insensitive) -> every live test is opted in.
 * - a comma-separated list of provider slugs, trimmed and compared
 *   case-insensitively -> only the named slugs are opted in.
 */
export function liveTestsEnabledFor(slug: string): boolean {
  const raw = (process.env["LOXEP_LIVE_TESTS"] ?? "").trim();
  if (raw === "" || raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "all" || normalized === "true") {
    return true;
  }
  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(slug.toLowerCase());
}
