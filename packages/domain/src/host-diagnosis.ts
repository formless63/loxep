/**
 * Host diagnosis — the single derived sentence over one hosting target's
 * linked-tool health witnesses (loxep-50t §3.1, loxep-1au §5, loxep-y64 §4).
 *
 * ## What this is FOR
 *
 * Up to four companion tools may be linked to one hosting target, and each
 * answers a DIFFERENT question about it — cheapest and most fundamental
 * first (loxep-50t §3.1):
 *
 * ```text
 * tailscale / private_network    the machine has a network stack and is
 *                                 talking to a control plane Loxep can reach
 * beszel    / host_metrics       the OS is up and an agent is running on it
 * dockhand  / container_console  the Docker daemon is reachable
 * gatus     / uptime_check       one SERVICE on that machine answers, or not
 * ```
 *
 * loxep-y64 §4 names the governing rule: "Loxep is authoritative for none of
 * these tools. It is authoritative for exactly one thing: which witnesses
 * are attached to this target, and when it last managed to hear from each."
 * A panel (or a helper function) that merges four witnesses' opinions into
 * one health chip destroys the one thing that makes linking four tools worth
 * doing — "Beszel up + Gatus down is not a conflict, it is a diagnosis" (the
 * app crashed, not the box). {@link diagnoseHostWitnesses} is the pure,
 * unit-testable core of that diagnosis: given whichever witnesses are
 * currently linked to ONE hosting target, it produces the single best
 * DIAGNOSIS SENTENCE the ladder supports, or the honest admission that it
 * does not support one yet.
 *
 * ## Witness-not-verdict (loxep-y64 §4) — why the return type has no status field
 *
 * {@link HostDiagnosisResult} deliberately carries no `status`/`health` field
 * of its own, and {@link HostDiagnosisReason} deliberately shares no value
 * with `HealthStatus` (`ok`/`degraded`/`failing`/`unknown`, from
 * `./health.ts`). A field shaped like a health status on this type is
 * exactly what would let a caller render a single verdict chip and defeat
 * the whole point — "just add a `.status` for the badge" is the failure mode
 * this doc comment exists to head off, and it is why the fields below are
 * shaped the way they are:
 *
 * - `sentence` is prose that NAMES its subjects ("Host is up and reporting;
 *   one service is failing. Service problem." — never a bare `"degraded"`).
 * - `reason` is a closed set of diagnosis-SHAPE labels (`host_offline`,
 *   `box_gone`, `agent_silent`, `service_problem`, `tailscale_only`,
 *   `healthy`, `insufficient_signals`, `indeterminate`). None of them alias
 *   a {@link HealthStatus} value, so there is no `reason` a renderer could
 *   map 1:1 onto an ok/degraded/failing/unknown badge without writing new
 *   copy for it — it is forced to either render `sentence` verbatim or do
 *   real work.
 * - `witnesses` preserves each LINKED witness's own reading individually, in
 *   ladder order. Nothing here is averaged, worst-of'd, or reconciled across
 *   witnesses — see loxep-y64 §4's panel rule, "no aggregate chip that
 *   averages or reconciles them", which this module's return shape obeys
 *   even though it produces prose, not a panel.
 * - `diagnosed` says whether the ladder found a matching pattern at all,
 *   kept separate from `reason` so "did this even manage to say something"
 *   can never be confused with "what did it say."
 *
 * ## Absent ≠ green (loxep-y64 §4)
 *
 * A witness with no link contributes NOTHING. This module takes that
 * literally: an unlinked witness is simply not a key on
 * {@link HostDiagnosisInput}, it is never synthesized into the `witnesses`
 * array, and it never participates in a condition below as though it read
 * `'ok'`. This is a different thing from a LINKED witness whose status
 * happens to be `'unknown'` (an agent that stopped answering, or a device
 * missing from a sweep) — both are handled, and they mean different things.
 * Only a *linked* reading — `'unknown'` included — counts toward the
 * two-signal floor below and appears in `witnesses`; a witness Loxep never
 * attached is not "unknown", it is not there.
 *
 * ## The mandatory fallback (loxep-50t §3.1) — DO NOT SIMPLIFY THIS AWAY
 *
 * "A confident sentence derived from one signal is worse than no sentence."
 * Fewer than two LINKED witnesses always produces the refusal
 * (`reason: 'insufficient_signals'`, `diagnosed: false`,
 * `sentence: 'Not enough linked tools to say.'`) — never a guess stretched
 * from a single reading, and never a "just this once" exception for a
 * caller that really wants a sentence. The same honesty extends past the
 * two-signal floor: for witness combinations the design was never given a
 * documented reading for, this module also refuses
 * (`reason: 'indeterminate'`) rather than extrapolate a new case. The
 * design's own words are "willing to say it does not know" — not "willing
 * to say it does not know only when short on data." A future change that
 * teaches the ladder a new combination must add it as its own named branch
 * with its own test; it must never lower the two-signal floor, and it must
 * never delete the `indeterminate` branch just to make some borderline
 * input "resolve" into a sentence.
 *
 * ## The two Gatus refinements (loxep-1au §5)
 *
 * 1. **Gatus's input is a SET, not a status.** A host can carry several
 *    linked Gatus endpoints, so {@link HostDiagnosisInput.gatus} is
 *    `{ failing, total }` — never a collapsed boolean and never a single
 *    {@link HealthStatus}. Every sentence that mentions Gatus names the
 *    count ("one of six services", never "gatus down"), and the `gatus`
 *    member of {@link HostDiagnosisWitnessSignal} is a deliberately
 *    DIFFERENT shape from its three siblings (`{ witness, failing, total }`
 *    instead of `{ witness, status }`) so the type system itself keeps this
 *    refinement from quietly regressing into a boolean.
 * 2. **All-failing flips the diagnosis.** Every linked Gatus endpoint
 *    failing while Beszel is silent reads as "the box is gone"
 *    (`reason: 'box_gone'`), not "an app crashed". One (or several, but not
 *    all) failing while Beszel is up reads as an ordinary service problem
 *    (`reason: 'service_problem'`). The threshold between those two
 *    readings — `failing === total` vs `failing < total` — is the entire
 *    value of counting instead of booleanizing, so {@link diagnoseHostWitnesses}
 *    checks the all-failing-plus-silent-Beszel combination BEFORE it checks
 *    the plain "Beszel is silent" case, not after, and the check is exact
 *    equality, never a "mostly failing" threshold the design never asked for.
 *
 * ## Ladder order vs. panel render order — NOT the same decision
 *
 * {@link HOST_DIAGNOSIS_LADDER} orders witnesses fundamental-first —
 * tailscale → beszel → dockhand → gatus, cheapest/most-basic signal to
 * priciest/most-specific — per loxep-50t §3.1, and this module checks them
 * in that order internally and lists them in that order inside `witnesses`.
 * The order a companion PANEL renders witnesses in is a separate, still-open
 * decision: loxep-y64 §4 orders outside-in (gatus → beszel → dockhand) for
 * exactly the opposite reason (walking from user-visible symptom toward
 * machine internals), and loxep-wvm §4.4 records that this conflict gets
 * settled once, in the panel work, not per provider and not by this module.
 * Nothing here should be read as resolving that; a caller is free to
 * re-sort `witnesses` for display.
 *
 * ## Purity
 *
 * No database, no network, no clock of its own. Staleness is the caller's
 * problem to resolve into a {@link HealthStatus} of `'unknown'` before
 * calling this function — `./health.ts`'s own `checked_at`/backoff
 * machinery already exists for exactly that — so this module reasons only
 * over the statuses and counts it is handed, nothing else.
 */
import { DomainValidationError } from "./errors.ts";
import { HEALTH_STATUSES } from "./health.ts";
import type { HealthStatus } from "./health.ts";

/**
 * Fundamental-first ladder order (loxep-50t §3.1). See the module doc's
 * "Ladder order vs. panel render order" section — this is NOT a panel
 * rendering decision.
 */
export const HOST_DIAGNOSIS_LADDER = [
  "tailscale",
  "beszel",
  "dockhand",
  "gatus",
] as const;
export type HostDiagnosisWitness = (typeof HOST_DIAGNOSIS_LADDER)[number];

/**
 * Closed set of diagnosis SHAPES, deliberately sharing no value with
 * {@link HealthStatus} — see the module doc's "witness-not-verdict" section
 * for why that is load-bearing, not incidental.
 */
export const HOST_DIAGNOSIS_REASONS = [
  "host_offline",
  "box_gone",
  "agent_silent",
  "service_problem",
  "tailscale_only",
  "healthy",
  "insufficient_signals",
  "indeterminate",
] as const;
export type HostDiagnosisReason = (typeof HOST_DIAGNOSIS_REASONS)[number];

/**
 * One hosting target's currently-linked witnesses. A key that is `undefined`
 * (or simply omitted) means that witness has NO link — see "Absent ≠ green"
 * above. `gatus` is the SET refinement (loxep-1au §5.1): `{ failing, total }`
 * over every Gatus endpoint linked to this target, never a single status.
 * `gatus.total === 0` is treated identically to "not linked" throughout this
 * module — a Gatus link with zero endpoints carries no information either.
 */
export interface HostDiagnosisInput {
  tailscale?: { status: HealthStatus };
  beszel?: { status: HealthStatus };
  dockhand?: { status: HealthStatus };
  gatus?: { failing: number; total: number };
}

/**
 * One linked witness's own, unmodified reading. `gatus` is intentionally a
 * different shape from its three siblings — see refinement 1 in the module
 * doc — so a caller can never collapse it into a status without visibly
 * discarding the count.
 */
export type HostDiagnosisWitnessSignal =
  | { witness: "tailscale"; status: HealthStatus }
  | { witness: "beszel"; status: HealthStatus }
  | { witness: "dockhand"; status: HealthStatus }
  | { witness: "gatus"; failing: number; total: number };

/**
 * The derived result. See the module doc's "witness-not-verdict" section for
 * why this shape has no aggregate status field and never will.
 */
export interface HostDiagnosisResult {
  /** Whether the ladder matched a pattern it has wording for. */
  diagnosed: boolean;
  /** The diagnosis sentence, or the honest refusal sentence. Never empty. */
  sentence: string;
  /** Which named case matched, or which refusal fired. Not a health status. */
  reason: HostDiagnosisReason;
  /** Every LINKED witness's own reading, ladder-ordered, unmerged. */
  witnesses: HostDiagnosisWitnessSignal[];
}

const WITNESS_LABELS: Record<HostDiagnosisWitness, string> = {
  tailscale: "Tailscale",
  beszel: "Beszel",
  dockhand: "Dockhand",
  gatus: "Gatus",
};

function assertStatus(witness: string, status: HealthStatus): void {
  if (!HEALTH_STATUSES.includes(status)) {
    throw new DomainValidationError(
      `invalid health status "${String(status)}" for ${witness}`,
    );
  }
}

function isGatusLinked(
  gatus: HostDiagnosisInput["gatus"],
): gatus is { failing: number; total: number } {
  return gatus !== undefined && gatus.total > 0;
}

function assertGatusCounts(gatus: { failing: number; total: number }): void {
  if (!Number.isInteger(gatus.total) || gatus.total < 0) {
    throw new DomainValidationError(
      "host diagnosis: gatus.total must be a non-negative integer",
    );
  }
  if (
    !Number.isInteger(gatus.failing) ||
    gatus.failing < 0 ||
    gatus.failing > gatus.total
  ) {
    throw new DomainValidationError(
      "host diagnosis: gatus.failing must be an integer between 0 and gatus.total",
    );
  }
}

/** Ladder order, always — see {@link HOST_DIAGNOSIS_LADDER}. */
function collectWitnesses(input: HostDiagnosisInput): HostDiagnosisWitnessSignal[] {
  const witnesses: HostDiagnosisWitnessSignal[] = [];
  if (input.tailscale !== undefined) {
    assertStatus("tailscale", input.tailscale.status);
    witnesses.push({ witness: "tailscale", status: input.tailscale.status });
  }
  if (input.beszel !== undefined) {
    assertStatus("beszel", input.beszel.status);
    witnesses.push({ witness: "beszel", status: input.beszel.status });
  }
  if (input.dockhand !== undefined) {
    assertStatus("dockhand", input.dockhand.status);
    witnesses.push({ witness: "dockhand", status: input.dockhand.status });
  }
  if (isGatusLinked(input.gatus)) {
    assertGatusCounts(input.gatus);
    witnesses.push({
      witness: "gatus",
      failing: input.gatus.failing,
      total: input.gatus.total,
    });
  }
  return witnesses;
}

/** loxep-1au §5.1: the sentence always names Gatus's actual count. */
function serviceProblemSentence(failing: number, total: number): string {
  if (failing === 1 && total === 1) {
    // The literal loxep-50t §3.1 wording for the single-endpoint case.
    return "Host is up and reporting; one service is failing. Service problem.";
  }
  if (failing === total) {
    return `Host is up and reporting; all ${total} services are failing. Service problem.`;
  }
  if (failing === 1) {
    return `Host is up and reporting; one of ${total} services is failing. Service problem.`;
  }
  return `Host is up and reporting; ${failing} of ${total} services are failing. Service problem.`;
}

/** loxep-1au §5.2: the all-failing-plus-silent-Beszel flip. */
function boxGoneSentence(total: number): string {
  const subject =
    total === 1
      ? "The one linked service check is"
      : `All ${total} linked service checks are`;
  return `${subject} failing and the metrics agent is silent — the box is gone, not a single app crashing.`;
}

function allWitnessesClean(witnesses: HostDiagnosisWitnessSignal[]): boolean {
  return witnesses.every((witness) =>
    witness.witness === "gatus" ? witness.failing === 0 : witness.status === "ok",
  );
}

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Not one of the design's fixed failure cases: every linked witness reads
 * clean. The design's fixed cases (loxep-50t §3.1) are all about diagnosing
 * a PROBLEM; they say nothing about the common case where nothing is wrong.
 * Refusing to say anything here — or worse, reusing `insufficient_signals`'s
 * wording when there plainly ARE enough signals — would itself be
 * dishonest, so this is a deliberate, documented extension of the ladder's
 * terminus rather than an improvised failure case. It still names its
 * subjects (never a bare "ok" verdict), consistent with witness-not-verdict.
 */
function healthySentence(witnesses: HostDiagnosisWitnessSignal[]): string {
  const names = witnesses.map((witness) => WITNESS_LABELS[witness.witness]);
  return `${joinWithAnd(names)} report normally.`;
}

/**
 * Derive the one diagnosis sentence for a hosting target from whichever
 * witnesses are currently linked to it — or the honest refusal to produce
 * one. See the module doc for the full design rationale; this function body
 * is the ladder, checked fundamental-first, with the two Gatus refinements
 * applied in priority order.
 */
export function diagnoseHostWitnesses(
  input: HostDiagnosisInput,
): HostDiagnosisResult {
  const witnesses = collectWitnesses(input);

  // The mandatory fallback (loxep-50t §3.1). Checked before anything else,
  // unconditionally — see the module doc's "DO NOT SIMPLIFY THIS AWAY".
  if (witnesses.length < 2) {
    return {
      diagnosed: false,
      reason: "insufficient_signals",
      sentence: "Not enough linked tools to say.",
      witnesses,
    };
  }

  const tailscaleStatus = input.tailscale?.status;
  const beszelStatus = input.beszel?.status;
  const dockhandStatus = input.dockhand?.status;
  const gatus = isGatusLinked(input.gatus) ? input.gatus : undefined;

  // Rung 1 (cheapest, most fundamental): Tailscale itself says the network
  // stack is not reaching the control plane. Nothing downstream can be
  // trusted once this is true, so it short-circuits every later rung
  // regardless of what Beszel/Dockhand/Gatus say.
  if (tailscaleStatus === "degraded" || tailscaleStatus === "failing") {
    return {
      diagnosed: true,
      reason: "host_offline",
      sentence:
        "The host is offline. The failing check is a symptom, not a second fault.",
      witnesses,
    };
  }

  // Refinement 2 (loxep-1au §5.2), checked before the plain "Beszel is
  // silent" rung because it is the more specific and more severe reading
  // and must win: every linked Gatus endpoint failing while Beszel stays
  // silent is overwhelming evidence the box itself is gone, not that one
  // app crashed. Deliberately independent of Tailscale's own reading — the
  // design's refinement does not condition this on Tailscale, and a stale
  // "online" read from the cheapest rung must not out-rank two independent
  // witnesses agreeing the box is unresponsive.
  if (
    beszelStatus === "unknown" &&
    gatus !== undefined &&
    gatus.failing === gatus.total
  ) {
    return {
      diagnosed: true,
      reason: "box_gone",
      sentence: boxGoneSentence(gatus.total),
      witnesses,
    };
  }

  if (tailscaleStatus === "ok") {
    const beszelSilent = beszelStatus === undefined || beszelStatus === "unknown";

    if (beszelSilent) {
      // Something besides Beszel giving real information is what licenses
      // the narrower "just the agent" diagnosis below; with nothing else
      // informative either, the honest statement is the weaker one: Loxep
      // reached the tailnet, not the host.
      const dockhandInformative =
        dockhandStatus !== undefined && dockhandStatus !== "unknown";
      const gatusInformative = gatus !== undefined;

      if (!dockhandInformative && !gatusInformative) {
        return {
          diagnosed: true,
          reason: "tailscale_only",
          sentence: "Loxep can reach Tailscale but not this host directly.",
          witnesses,
        };
      }
      if (beszelStatus === "unknown") {
        // Beszel is specifically linked and silent, and some other witness
        // (Dockhand or Gatus) DOES report real data — that corroboration is
        // what makes "agent problem, not a host outage" an honest, rather
        // than a guessed, diagnosis.
        return {
          diagnosed: true,
          reason: "agent_silent",
          sentence:
            "Host online but its metrics agent is silent. Agent problem, not a host outage.",
          witnesses,
        };
      }
      // Beszel was never linked at all (so there is no agent-specific claim
      // to make), yet Dockhand or Gatus IS informative. No fixed case
      // covers this combination; fall through to the healthy/indeterminate
      // check below rather than inventing wording for it.
    } else if (beszelStatus === "ok" && gatus !== undefined && gatus.failing > 0) {
      // Host confirmed up at both the network and OS/agent rungs; one or
      // more linked services is failing. Named with Gatus's actual count
      // (loxep-1au §5.1), never a collapsed "gatus down".
      return {
        diagnosed: true,
        reason: "service_problem",
        sentence: serviceProblemSentence(gatus.failing, gatus.total),
        witnesses,
      };
    }
  }

  // Every fixed failure case above is about naming a PROBLEM. When none
  // matched and every linked witness is independently clean, say so — see
  // `healthySentence`'s doc for why this is a deliberate ladder terminus
  // and not an improvised new "case".
  if (allWitnessesClean(witnesses)) {
    return {
      diagnosed: true,
      reason: "healthy",
      sentence: healthySentence(witnesses),
      witnesses,
    };
  }

  // Two or more witnesses are linked, but they disagree in a shape this
  // ladder was never given a documented reading for. This refusal is
  // deliberate, not a gap — see the module doc's "mandatory fallback"
  // section. Do not replace it with a guess.
  return {
    diagnosed: false,
    reason: "indeterminate",
    sentence: "Linked tools disagree in a way this ladder cannot resolve into one diagnosis.",
    witnesses,
  };
}
