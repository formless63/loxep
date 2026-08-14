/**
 * LOXEP_LIVE_TESTS opt-in gate for this package's live-integration test(s).
 *
 * A live test now needs BOTH its credential file AND this flag before it is
 * allowed to talk to a real — often production — instance. Credentials alone
 * used to be sufficient, which meant a routine `bun run test:packages` would
 * silently contact production the moment a credential file existed on disk
 * (e.g. the owner's real Beszel/Dockhand/Gatus/Termix/Woo/eBay/Medusa
 * instances, logging in to Dockhand and Termix on every run). This flag is
 * the second, explicit condition that keeps a routine run from doing that.
 *
 * Duplicated per package rather than centralized in a shared package,
 * mirroring this repo's existing norm of package-local test helpers (see
 * `packages/app/test/helpers.ts`): duplicating this ~15-line file is a
 * deliberate tradeoff against adding a new dependency edge into the
 * integration packages, which are kept thin on purpose. Do not "DRY" this
 * into a shared package without re-weighing that tradeoff.
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
