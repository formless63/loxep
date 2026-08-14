/**
 * Host diagnosis tests (loxep-50t §3.1, loxep-1au §5, loxep-y64 §4). No
 * database, no network — this function is pure, so every test is a plain
 * `describe`/`it` over `diagnoseHostWitnesses` directly.
 *
 * Coverage map:
 * - every fixed case loxep-50t §3.1 names verbatim
 * - both Gatus refinements loxep-1au §5 forces (the SET input, the
 *   all-failing flip)
 * - the mandatory not-enough-signals fallback and its "indeterminate"
 *   sibling for combinations the ladder has no wording for
 * - absent-not-green (an unlinked witness contributes nothing and never
 *   appears in `witnesses`)
 * - ladder ordering of the `witnesses` array
 * - input validation (gatus counts, health status values)
 */
import { describe, expect, it } from "vitest";
import { DomainValidationError, diagnoseHostWitnesses } from "../src/index.ts";

describe("diagnoseHostWitnesses — the mandatory fallback (loxep-50t §3.1)", () => {
  it("refuses with an empty input (zero linked witnesses)", () => {
    const result = diagnoseHostWitnesses({});
    expect(result.diagnosed).toBe(false);
    expect(result.reason).toBe("insufficient_signals");
    expect(result.sentence).toBe("Not enough linked tools to say.");
    expect(result.witnesses).toEqual([]);
  });

  it("refuses with exactly one linked witness", () => {
    const result = diagnoseHostWitnesses({ tailscale: { status: "ok" } });
    expect(result.diagnosed).toBe(false);
    expect(result.reason).toBe("insufficient_signals");
    expect(result.sentence).toBe("Not enough linked tools to say.");
    expect(result.witnesses).toEqual([{ witness: "tailscale", status: "ok" }]);
  });

  it("does not count a gatus link with zero endpoints as a signal", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      gatus: { failing: 0, total: 0 },
    });
    expect(result.reason).toBe("insufficient_signals");
    // The empty gatus link contributes nothing — not even an entry.
    expect(result.witnesses).toEqual([{ witness: "tailscale", status: "ok" }]);
  });

  it("becomes willing to speak the moment a second witness is linked", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      dockhand: { status: "ok" },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).not.toBe("insufficient_signals");
  });
});

describe("diagnoseHostWitnesses — fixed case: tailscale ok + beszel ok + gatus failing", () => {
  it("names the exact loxep-50t §3.1 sentence for a single linked service", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      gatus: { failing: 1, total: 1 },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("service_problem");
    expect(result.sentence).toBe(
      "Host is up and reporting; one service is failing. Service problem.",
    );
  });

  it("names the count for one of several failing (loxep-1au §5.1 refinement)", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      gatus: { failing: 1, total: 6 },
    });
    expect(result.reason).toBe("service_problem");
    expect(result.sentence).toBe(
      "Host is up and reporting; one of 6 services is failing. Service problem.",
    );
  });

  it("names the count for several of several failing", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      gatus: { failing: 3, total: 6 },
    });
    expect(result.reason).toBe("service_problem");
    expect(result.sentence).toBe(
      "Host is up and reporting; 3 of 6 services are failing. Service problem.",
    );
  });

  it("stays 'service problem' — not 'box gone' — when all services fail but Beszel is up", () => {
    // The all-failing flip (loxep-1au §5.2) is conditioned on Beszel being
    // SILENT. Beszel reporting 'ok' already proves the host itself is up,
    // so total Gatus failure here is still an app-level, not a box-level,
    // diagnosis.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      gatus: { failing: 6, total: 6 },
    });
    expect(result.reason).toBe("service_problem");
    expect(result.sentence).toBe(
      "Host is up and reporting; all 6 services are failing. Service problem.",
    );
  });
});

describe("diagnoseHostWitnesses — fixed case: tailscale offline + gatus failing", () => {
  it("names the exact loxep-50t §3.1 sentence and treats the gatus failure as a symptom", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "degraded" },
      gatus: { failing: 1, total: 1 },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("host_offline");
    expect(result.sentence).toBe(
      "The host is offline. The failing check is a symptom, not a second fault.",
    );
  });

  it("dominates every other witness — tailscale offline wins over an otherwise-ok beszel", () => {
    // The cheapest, most fundamental rung (loxep-50t §3.1's stated ladder
    // order) short-circuits everything downstream once it says the network
    // stack itself is unreachable.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "degraded" },
      beszel: { status: "ok" },
      gatus: { failing: 1, total: 1 },
    });
    expect(result.reason).toBe("host_offline");
  });
});

describe("diagnoseHostWitnesses — fixed case: tailscale ok + beszel unknown/stale", () => {
  it("names the exact loxep-50t §3.1 sentence when another witness corroborates the host is otherwise reachable", () => {
    // Dockhand reporting 'ok' is the corroboration that licenses the
    // narrower "just the agent" diagnosis, distinguishing this from the
    // "everything else unknown" case below.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "unknown" },
      dockhand: { status: "ok" },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("agent_silent");
    expect(result.sentence).toBe(
      "Host online but its metrics agent is silent. Agent problem, not a host outage.",
    );
  });

  it("also fires when gatus (not dockhand) is the corroborating witness", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "unknown" },
      gatus: { failing: 0, total: 3 },
    });
    expect(result.reason).toBe("agent_silent");
  });
});

describe("diagnoseHostWitnesses — fixed case: tailscale ok + everything else unknown", () => {
  it("names the exact loxep-50t §3.1 sentence when beszel is silent and nothing else is linked", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "unknown" },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("tailscale_only");
    expect(result.sentence).toBe("Loxep can reach Tailscale but not this host directly.");
  });

  it("also fires when dockhand (not beszel) is the only other, silent, witness", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      dockhand: { status: "unknown" },
    });
    expect(result.reason).toBe("tailscale_only");
  });
});

describe("diagnoseHostWitnesses — loxep-1au §5.2 refinement: the all-failing flip", () => {
  it("reads as 'the box is gone', not an app crash, when every linked service fails and beszel is silent", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "unknown" },
      gatus: { failing: 6, total: 6 },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("box_gone");
    expect(result.sentence).toBe(
      "All 6 linked service checks are failing and the metrics agent is silent — the box is gone, not a single app crashing.",
    );
  });

  it("uses singular wording for exactly one linked, all-failing endpoint", () => {
    const result = diagnoseHostWitnesses({
      beszel: { status: "unknown" },
      gatus: { failing: 1, total: 1 },
    });
    expect(result.reason).toBe("box_gone");
    expect(result.sentence).toBe(
      "The one linked service check is failing and the metrics agent is silent — the box is gone, not a single app crashing.",
    );
  });

  it("does not flip when only some (not all) linked services fail while beszel is silent", () => {
    // This is the threshold the SET input exists to preserve — a boolean
    // "gatus down" could never draw this line. Gatus reporting a partial
    // failure is itself the corroborating signal that the host is otherwise
    // reachable, so this reads as the plain agent-silent case, not the
    // all-failing "box is gone" flip.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "unknown" },
      gatus: { failing: 1, total: 6 },
    });
    expect(result.reason).toBe("agent_silent");
    expect(result.sentence).toBe(
      "Host online but its metrics agent is silent. Agent problem, not a host outage.",
    );
  });

  it("does not fire when tailscale reports offline — the offline rung still wins", () => {
    // Tailscale is the cheapest, most fundamental rung; once it says
    // offline, that is the root cause regardless of the gatus/beszel
    // pattern that would otherwise trigger the box-gone flip.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "degraded" },
      beszel: { status: "unknown" },
      gatus: { failing: 3, total: 3 },
    });
    expect(result.reason).toBe("host_offline");
  });

  it("fires even without a tailscale link at all", () => {
    const result = diagnoseHostWitnesses({
      beszel: { status: "unknown" },
      gatus: { failing: 2, total: 2 },
    });
    expect(result.reason).toBe("box_gone");
  });
});

describe("diagnoseHostWitnesses — healthy terminus (documented extension, not a fixed case)", () => {
  it("names its subjects when every linked witness reads clean", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      dockhand: { status: "ok" },
      gatus: { failing: 0, total: 4 },
    });
    expect(result.diagnosed).toBe(true);
    expect(result.reason).toBe("healthy");
    expect(result.sentence).toBe("Tailscale, Beszel, Dockhand, and Gatus report normally.");
  });

  it("works with exactly two clean witnesses", () => {
    const result = diagnoseHostWitnesses({
      beszel: { status: "ok" },
      dockhand: { status: "ok" },
    });
    expect(result.reason).toBe("healthy");
    expect(result.sentence).toBe("Beszel and Dockhand report normally.");
  });
});

describe("diagnoseHostWitnesses — indeterminate (honest refusal beyond the signal floor)", () => {
  it("refuses rather than guess when linked witnesses disagree in an undocumented shape", () => {
    // Beszel actively reporting 'failing' (not silent) alongside an
    // otherwise-fine tailscale is a combination none of the fixed cases
    // describe — the honest move is to say so, not to invent wording.
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "failing" },
    });
    expect(result.diagnosed).toBe(false);
    expect(result.reason).toBe("indeterminate");
    expect(result.sentence).toBe(
      "Linked tools disagree in a way this ladder cannot resolve into one diagnosis.",
    );
  });

  it("refuses when tailscale itself is unresolved and nothing licenses a stronger reading", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "unknown" },
      dockhand: { status: "ok" },
    });
    expect(result.reason).toBe("indeterminate");
  });
});

describe("diagnoseHostWitnesses — absent ≠ green (loxep-y64 §4)", () => {
  it("never synthesizes an entry for an unlinked witness", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      // dockhand and gatus: not linked at all.
    });
    expect(result.witnesses.map((witness) => witness.witness)).toEqual([
      "tailscale",
      "beszel",
    ]);
  });

  it("an absent witness never contributes toward a clean-diagnosis reading it did not earn", () => {
    // Two witnesses are linked and clean; two are simply not attached. The
    // result must speak only about what is linked, never imply the
    // unlinked pair are healthy too.
    const result = diagnoseHostWitnesses({
      beszel: { status: "ok" },
      dockhand: { status: "ok" },
    });
    expect(result.reason).toBe("healthy");
    expect(result.sentence).not.toMatch(/tailscale|gatus/i);
  });
});

describe("diagnoseHostWitnesses — witness ordering", () => {
  it("lists linked witnesses fundamental-first regardless of input key order", () => {
    const result = diagnoseHostWitnesses({
      gatus: { failing: 0, total: 2 },
      dockhand: { status: "ok" },
      beszel: { status: "ok" },
      tailscale: { status: "ok" },
    });
    expect(result.witnesses.map((witness) => witness.witness)).toEqual([
      "tailscale",
      "beszel",
      "dockhand",
      "gatus",
    ]);
  });
});

describe("diagnoseHostWitnesses — the gatus SET, preserved verbatim in witnesses", () => {
  it("carries the raw failing/total pair rather than a collapsed status", () => {
    const result = diagnoseHostWitnesses({
      tailscale: { status: "ok" },
      beszel: { status: "ok" },
      gatus: { failing: 2, total: 5 },
    });
    const gatusWitness = result.witnesses.find((witness) => witness.witness === "gatus");
    expect(gatusWitness).toEqual({ witness: "gatus", failing: 2, total: 5 });
  });
});

describe("diagnoseHostWitnesses — input validation", () => {
  it("rejects a gatus count where failing exceeds total", () => {
    expect(() =>
      diagnoseHostWitnesses({
        tailscale: { status: "ok" },
        beszel: { status: "ok" },
        gatus: { failing: 4, total: 2 },
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects a negative gatus failing count", () => {
    expect(() =>
      diagnoseHostWitnesses({
        tailscale: { status: "ok" },
        beszel: { status: "ok" },
        gatus: { failing: -1, total: 2 },
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects a non-integer gatus total", () => {
    expect(() =>
      diagnoseHostWitnesses({
        tailscale: { status: "ok" },
        beszel: { status: "ok" },
        gatus: { failing: 1, total: 2.5 },
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects a status outside the HealthStatus vocabulary", () => {
    expect(() =>
      diagnoseHostWitnesses({
        // @ts-expect-error — deliberately invalid at the runtime boundary
        tailscale: { status: "green" },
        beszel: { status: "ok" },
      }),
    ).toThrow(DomainValidationError);
  });
});
