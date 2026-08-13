---
title: "ADR-0022: One-Time Reveal for Minted Secrets"
---

**Status:** PROVISIONAL — resolved per the delegated-decision policy to unblock Phase 7 milestone 3; awaits owner review. Refines ADR-0016/ADR-0019; does not weaken them.

## Context

Configuration & Secrets rule 2 says a stored secret is never readable back by a human: Loxep encrypts, uses, and rotates secrets, and the UI treats every credential field as write-only. The infrastructure control plane broke the assumption behind that rule from the other direction: some secrets are *minted by Loxep's own reconciler* — a scoped host token created through a provider's API, a mailbox password generated at mailbox creation — and they exist precisely so a person can carry them somewhere Loxep does not reach (an SSH session, a mail client, another machine's agent config). A secret that can never be read by anyone is, for this class, a secret that serves no one.

The Phase 7 design refused to resolve this silently and demanded an ADR. This is that ADR.

## Decision

**Reveal-once at mint time; write-only forever after.**

1. When Loxep mints a secret (creates it via a provider API, or generates it locally), the plaintext may be shown to the requesting admin **exactly once, in the response to the creating action** — before or simultaneous with its encrypted storage. The UI presents it with an explicit "this will never be shown again" affordance.
2. After that response completes, the stored ciphertext is subject to rule 2 unchanged: no read-back path exists in any API, server function, or UI. Not for admins, not for support, not for migration.
3. Every reveal is audited (`secret.reveal_once`, actor, subject, request id) in the same transaction that stores the ciphertext.
4. If the one chance is missed — the tab closed, the value lost — the remedy is **rotation, never recovery**: mint a replacement, revoke the old one at the provider where the provider supports it, and the reconciler's read-back rules (ADR-0021-style pending-operation handling) treat an unrevealable lost token as a mandatory roll.
5. Secrets *entered* by a human (provider API keys, tokens pasted into a dialog) get no reveal at all — the human already has them; those fields stay write-only from the first keystroke, exactly as today.

## Consequences

- Milestone 3's mailbox-password and host-token UX is unblocked with a shape that matches what every mainstream credential system does (cloud provider API keys, CI tokens): show once, then rotation-only.
- Rule 2's guarantee actually strengthens in practice: because a legitimate one-time channel exists, there is no pressure to ever add a read-back "just this once" escape hatch.
- The audit trail distinguishes minted-and-revealed from entered secrets permanently.
- The reveal is the single moment plaintext crosses the UI; it must never be logged, and the server function returning it must be excluded from any response-logging middleware — enforced by test.
