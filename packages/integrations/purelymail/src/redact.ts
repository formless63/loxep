/**
 * Per-response redactors for the Purelymail boundary (ADR-0021's
 * `redactWooOrderFact` / `redactEbayOrderFact` precedent).
 *
 * The redactor lives HERE, next to the knowledge of which fields are sensitive,
 * and the domain service accepts only redacted input. That is the design's rule
 * for `reconcile_run_steps.request_summary` / `response_summary` and
 * `provider_operations.response_summary`:
 *
 * > What must never appear: token values, mailbox passwords, `Authorization`
 * > header contents, or a full request URL carrying credentials in a query
 * > string. What should appear: the operation, the record identity, and the
 * > values that actually differed.
 *
 * ## The highest-risk line in THIS milestone
 *
 * Cloudflare's equivalent risk was a response — the token-create body. **Here
 * it is a REQUEST.** `createUser` carries `password`, a value Loxep minted
 * seconds earlier, and the run step recording that call is exactly where a
 * debugging instinct would dump the body.
 *
 * {@link redactPurelymailRequest} is therefore an ALLOW-LIST that never reads a
 * request body generically. It cannot pass `password` through even if the
 * request shape changes, because there is no code path that copies an unknown
 * field. `boundary.test.ts` asserts this against a full-shaped fixture,
 * including a password with a distinctive marker, per the design's
 * pre-implementation item 8: *"confirm no adapter can place a token value, a
 * mailbox password, or an `Authorization` header into `reconcile_run_steps` or
 * a job payload — a test per adapter, not a code review."*
 *
 * ## The ownership code IS included, deliberately
 *
 * `getOwnershipCode`'s response is summarized WITH its value. That looks like a
 * leak and is not: the code's entire purpose is to be published in a public TXT
 * record, and the design states the point explicitly *"so the argument is not
 * had twice"*. Redacting it would make a half-published mail domain
 * undiagnosable from the run history — the operator's first question is "which
 * code did we publish", and the answer is public data.
 */

/** A redacted structure safe for `reconcile_run_steps` / `provider_operations`. */
export type RedactedSummary = Record<string, unknown>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Domain info -> summary, including the DNS check results, which are the whole
 * reason the reconciler reads a domain back.
 */
export function redactPurelymailDomain(domain: unknown): RedactedSummary {
  const record = (domain ?? {}) as Record<string, unknown>;
  const dns = (record["dnsSummary"] ?? {}) as Record<string, unknown>;
  return {
    name: scalar(record["name"]),
    isShared: flag(record["isShared"]),
    allowAccountReset: flag(record["allowAccountReset"]),
    symbolicSubaddressing: flag(record["symbolicSubaddressing"]),
    passesMx: flag(dns["passesMx"]),
    passesSpf: flag(dns["passesSpf"]),
    passesDkim: flag(dns["passesDkim"]),
    passesDmarc: flag(dns["passesDmarc"]),
  };
}

/**
 * Ownership-code response -> summary. **Includes the code**, on purpose; see
 * the module doc. It is published in a public DNS record either way.
 */
export function redactPurelymailOwnershipCode(
  response: unknown,
): RedactedSummary {
  const record = (response ?? {}) as Record<string, unknown>;
  return {
    ownershipCode: scalar(record["code"]),
    ownershipCodeIsPublic: true,
  };
}

/**
 * Routing-rule -> summary. `targetAddresses` are ordinary email addresses an
 * operator typed into a template; they are the identity of the rule and are
 * useless to redact, since the same values are in `mailboxes.forward_to`.
 */
export function redactPurelymailRoutingRule(rule: unknown): RedactedSummary {
  const record = (rule ?? {}) as Record<string, unknown>;
  const targets = record["targetAddresses"];
  return {
    routingRuleId:
      typeof record["id"] === "number" ? record["id"] : null,
    domainName: scalar(record["domainName"]),
    matchUser: scalar(record["matchUser"]),
    prefix: flag(record["prefix"]),
    catchall: flag(record["catchall"]),
    targetCount: Array.isArray(targets) ? targets.length : 0,
  };
}

/**
 * User-create response -> summary. Purelymail answers `createUser` with an
 * EMPTY result object, so there is nothing to project — but the summary states
 * positively what was created and that the password was not recorded, so a
 * reader of a run step knows the omission is deliberate rather than a gap.
 *
 * The address is Loxep's own input, echoed back for identity. The password is
 * never a parameter of this function, which is the structural half of the rule.
 */
export function redactPurelymailUserCreate(input: {
  userName: string;
  domainName: string;
}): RedactedSummary {
  return {
    userName: input.userName,
    domainName: input.domainName,
    created: true,
    passwordOmitted: true,
  };
}

/**
 * Request summary for an outbound call.
 *
 * Takes the operation label and the PATH — never the URL, and never the body.
 * The body is described by an explicit, per-operation allow-list of identity
 * fields, because the one field that must never appear (`password`) lives in
 * the same object as the ones that must (`userName`, `domainName`).
 */
export function redactPurelymailRequest(input: {
  operation: string;
  path: string;
  /** Identity fields ONLY. Never spread a request body into this. */
  subject?: {
    domainName?: string;
    userName?: string;
    localPart?: string;
    routingRuleId?: number;
  };
}): RedactedSummary {
  const subject = input.subject ?? {};
  return {
    operation: input.operation,
    method: "POST",
    path: input.path,
    ...(subject.domainName === undefined
      ? {}
      : { domainName: subject.domainName }),
    ...(subject.userName === undefined ? {} : { userName: subject.userName }),
    ...(subject.localPart === undefined ? {} : { localPart: subject.localPart }),
    ...(subject.routingRuleId === undefined
      ? {}
      : { routingRuleId: subject.routingRuleId }),
  };
}
