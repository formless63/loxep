/**
 * Duplicate-candidate finding — exact-normalized matching only.
 *
 * ## What this does
 *
 * Two queries and nothing else:
 *
 * ```text
 * by name     counterparties sharing an identical normalized_name
 * by channel  counterparties sharing an identical (channel_kind,
 *             normalized_value), through their own channels or their
 *             contacts'
 * ```
 *
 * Both are equality on a column that is already normalized and already indexed
 * (`counterparties_normalized_name_idx`,
 * `contact_channels_normalized_value_idx`). Merged rows are excluded from both
 * sides: a loser is already resolved, and offering it as a candidate would
 * invite a second merge that this package refuses anyway.
 *
 * ## Why there is no fuzzy matching, and why that is not a shortcut
 *
 * No trigram similarity, no Levenshtein, no soundex, no token-set ratio, no
 * learned matcher, and no scoring. The reasons, in the order they matter:
 *
 * 1. **The output of this module feeds an operation that is expensive to
 *    undo.** The design's merge posture is a survivor pointer precisely
 *    because a wrong merge must be reversible; a candidate list that is right
 *    most of the time trains an operator to accept it without reading, and the
 *    unmerge that follows is a manual repair for every downstream reference
 *    someone has already created against the survivor.
 * 2. **It is the posture the documentation already took twice.** Phase 5 ships
 *    reconciliation STATE and one deliberately dumb suggestion function over
 *    exact amount and a date window, explicitly deferring "any confidence
 *    score, fuzzy string match, or learned matcher". Phase 6 says merges are
 *    never automatic and that a human merges. A fuzzy matcher here would be the
 *    first place in the codebase where a guess is presented as a finding.
 * 3. **Exact-normalized is not weak.** The normalizer already folds case,
 *    punctuation, diacritics, legal suffixes, and a leading "the", so
 *    `The Acme Roofing Co., Inc.` and `acme roofing company incorporated` are
 *    the SAME candidate group without any similarity metric at all. Most real
 *    duplicates in a small installation are re-typings of the same name, and
 *    that class is caught exactly.
 * 4. **Nothing is lost by waiting.** Adding `pg_trgm` and a similarity
 *    threshold later requires no schema change, no data migration, and no
 *    change to this module's return shape — it is one more finder alongside
 *    these two, with a `matchKind` value the caller can weight differently.
 *    Removing a fuzzy matcher after operators have merged on its suggestions is
 *    not symmetrical.
 *
 * The honest gap this leaves, stated rather than hidden: `Acme Roofing` and
 * `Acme Roofing LLC` do **not** group (the suffix is normalized, not removed),
 * a misspelling never groups, and a local-format phone number never matches its
 * international form. Those pairs sit unfound rather than mis-merged, which is
 * the trade this module is making on purpose.
 */
import type { LoxepDb } from "@loxep/db";
import { pickerPredicate } from "./merge.ts";
import { textLiteral } from "./sql.ts";

export type DuplicateMatchKind = "normalized_name" | "contact_channel";

export interface DuplicateCandidateMember {
  counterpartyId: string;
  referenceCode: string;
  displayName: string;
  kind: string;
  status: string;
  createdAt: Date;
}

export interface DuplicateCandidateGroup {
  matchKind: DuplicateMatchKind;
  /** The normalized value the group matched on. Channel groups prefix the kind. */
  matchValue: string;
  members: DuplicateCandidateMember[];
}

export interface DedupeService {
  /** Groups of two or more counterparties sharing an exact normalized name. */
  byName: (options?: { limit?: number }) => Promise<DuplicateCandidateGroup[]>;
  /**
   * Groups sharing an exact normalized channel value of the same kind.
   *
   * A channel owned by a contact counts for that contact's counterparty, which
   * is what makes "Jane's email appears under two customer records" findable.
   */
  byChannel: (options?: {
    channelKinds?: string[];
    limit?: number;
  }) => Promise<DuplicateCandidateGroup[]>;
  /** Both finders, name groups first. Never merges anything. */
  candidates: (options?: {
    limit?: number;
  }) => Promise<DuplicateCandidateGroup[]>;
}

interface RawGroupRow {
  match_value: string;
  members: unknown;
}

function toGroups(
  rows: Record<string, unknown>[],
  matchKind: DuplicateMatchKind,
): DuplicateCandidateGroup[] {
  return rows.map((row) => {
    const raw = row as unknown as RawGroupRow;
    const members = (raw.members as Record<string, unknown>[]).map(
      (member) => ({
        counterpartyId: member["id"] as string,
        referenceCode: member["reference_code"] as string,
        displayName: member["display_name"] as string,
        kind: member["kind"] as string,
        status: member["status"] as string,
        createdAt: new Date(member["created_at"] as string),
      }),
    );
    return { matchKind, matchValue: raw.match_value, members };
  });
}

export function createDedupeService(options: { db: LoxepDb }): DedupeService {
  const { db } = options;

  function limitClause(limit: number | undefined): string {
    return limit === undefined
      ? ""
      : ` limit ${Math.max(1, Math.trunc(limit))}`;
  }

  async function byName(
    opts?: { limit?: number },
  ): Promise<DuplicateCandidateGroup[]> {
    const result = await db.execute(
      `select c.normalized_name as match_value,
              json_agg(json_build_object(
                'id', c.id::text,
                'reference_code', c.reference_code,
                'display_name', c.display_name,
                'kind', c.kind,
                'status', c.status,
                'created_at', c.created_at
              ) order by c.created_at, c.id) as members
         from counterparties c
        where ${pickerPredicate("c")}
          and c.normalized_name <> ''
        group by c.normalized_name
       having count(*) > 1
        order by count(*) desc, c.normalized_name${limitClause(opts?.limit)}`,
    );
    return toGroups(result.rows, "normalized_name");
  }

  async function byChannel(opts?: {
    channelKinds?: string[];
    limit?: number;
  }): Promise<DuplicateCandidateGroup[]> {
    const kindFilter =
      opts?.channelKinds === undefined || opts.channelKinds.length === 0
        ? ""
        : ` and ch.channel_kind in (${opts.channelKinds.map(textLiteral).join(", ")})`;
    const result = await db.execute(
      `with owned as (
         select coalesce(ch.counterparty_id, ct.counterparty_id) as counterparty_id,
                ch.channel_kind, ch.normalized_value
           from contact_channels ch
           left join counterparty_contacts ct
                  on ct.id = ch.counterparty_contact_id
          where ch.normalized_value <> ''
            and ch.opted_out_at is null${kindFilter}
       ),
       distinct_owned as (
         select distinct counterparty_id, channel_kind, normalized_value
           from owned where counterparty_id is not null
       )
       select o.channel_kind || ':' || o.normalized_value as match_value,
              json_agg(json_build_object(
                'id', c.id::text,
                'reference_code', c.reference_code,
                'display_name', c.display_name,
                'kind', c.kind,
                'status', c.status,
                'created_at', c.created_at
              ) order by c.created_at, c.id) as members
         from distinct_owned o
         join counterparties c on c.id = o.counterparty_id
        where ${pickerPredicate("c")}
        group by o.channel_kind, o.normalized_value
       having count(*) > 1
        order by count(*) desc, 1${limitClause(opts?.limit)}`,
    );
    return toGroups(result.rows, "contact_channel");
  }

  return {
    byName,
    byChannel,
    candidates: async (opts) => [
      ...(await byName(opts)),
      ...(await byChannel(opts)),
    ],
  };
}
