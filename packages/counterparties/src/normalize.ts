/**
 * Normalization for matching: `counterparties.normalized_name` and
 * `contact_channels.normalized_value`.
 *
 * ## These are matching AIDS, not identities
 *
 * `normalized_name` deliberately carries **no unique constraint**, because two
 * genuinely different "Smith Plumbing" businesses are a real thing. It exists
 * so the duplicate-candidate report has something to group by, and grouping is
 * a suggestion a human acts on — never an automatic merge.
 *
 * `normalized_value` DOES participate in a unique, but a scoped one: the same
 * channel value may not be recorded twice against the same owner and kind. It
 * says nothing about two different parties sharing an address, which happens
 * (a shared family mailbox, an agency inbox) and must not fail an insert.
 *
 * ## Every rule here is deliberately dumb, and that is the design
 *
 * There is no fuzzy matching, no edit distance, no phonetic key, no
 * transliteration, no company-registry lookup, and no phone-number library.
 * The design's posture for merges is the same one Phase 5 took for
 * reconciliation — *ship the state, not the matcher* — because an automatic
 * merge of two customers is far more expensive to undo than an unmatched pair
 * is to leave sitting in a queue. A normalizer clever enough to be useful is
 * clever enough to be confidently wrong, and its mistakes arrive as a
 * pre-approved suggestion.
 *
 * The rules are therefore all reversible-by-eye and all documented:
 */

/**
 * Legal-form suffixes collapsed to a single token so `Acme Ltd` and
 * `Acme Limited` group together.
 *
 * Longest forms first: the replacement runs in order and `incorporated` must be
 * matched before `inc` would strip its prefix.
 */
const LEGAL_SUFFIXES: readonly (readonly [RegExp, string])[] = [
  [/\bincorporated\b/g, "inc"],
  [/\bcorporation\b/g, "corp"],
  [/\bcompany\b/g, "co"],
  [/\blimited liability company\b/g, "llc"],
  [/\blimited\b/g, "ltd"],
  [/\bproprietary\b/g, "pty"],
  [/\bunlimited\b/g, "ultd"],
  [/\band\b/g, "&"],
];

/**
 * Case-folded, punctuation-stripped, suffix-normalized, leading-`the`-dropped.
 *
 * ```text
 * "The Acme Roofing Co., Inc."   ->  "acme roofing co inc"
 * "acme  roofing company inc"    ->  "acme roofing co inc"
 * "Åkerman & Sons"               ->  "akerman & sons"
 * ```
 *
 * Diacritics are folded through NFKD so `Åkerman` and `Akerman` group; that is
 * a genuine transcription variant rather than a different business, and it is
 * the one transformation here that changes letters rather than removing
 * characters.
 */
export function normalizeName(value: string): string {
  let normalized = value
    .normalize("NFKD")
    // Strip combining marks left by the decomposition.
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .trim();
  // Punctuation to spaces (not to nothing): "acme,inc" must not become
  // "acmeinc", which would group it with a different string than "acme inc".
  normalized = normalized.replace(/[^\p{L}\p{N}&]+/gu, " ").trim();
  normalized = normalized.replace(/^the\s+/, "");
  for (const [pattern, replacement] of LEGAL_SUFFIXES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/\s+/g, " ").trim();
}

/**
 * Per-kind channel normalization.
 *
 * ```text
 * email               lowercase + trim. Plus-addressing is NOT stripped and
 *                     dots are NOT removed: those rules are provider-specific
 *                     (Gmail's, not the standard's), and applying them
 *                     collapses two addresses that a strict mail server treats
 *                     as different.
 * phone/mobile/fax    digits only, keeping a single leading '+'. No region
 *                     inference, no libphonenumber: guessing a country code
 *                     from an installation's locale is how a UK number becomes
 *                     a US one. A local-format number and its international
 *                     form therefore do NOT match, which is an honest gap.
 * website             lowercase, scheme dropped, leading 'www.' dropped,
 *                     trailing '/' dropped.
 * everything else     lowercase, whitespace collapsed.
 * ```
 */
export function normalizeChannelValue(kind: string, value: string): string {
  const trimmed = value.trim();
  switch (kind) {
    case "email":
      return trimmed.toLowerCase();
    case "phone":
    case "mobile":
    case "fax": {
      const plus = trimmed.startsWith("+") ? "+" : "";
      return `${plus}${trimmed.replace(/\D/g, "")}`;
    }
    case "website":
      return trimmed
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "");
    default:
      return trimmed.toLowerCase().replace(/\s+/g, " ");
  }
}
