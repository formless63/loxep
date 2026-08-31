/**
 * LIVE leg — a REAL Purelymail account, READ-ONLY **by construction of this
 * file**, not by construction of the credential.
 *
 * Requires `LOXEP_LIVE_TESTS=purelymail` (or `=all`) before it inspects
 * `~/.config/loxep/purelymail.env`. Without opt-in it skips without reading
 * local credentials; an opted-in run also skips when that file is absent.
 *
 * ## The difference from milestone 1, stated plainly
 *
 * `@loxep/integration-cloudflare`'s live leg asks for a token scoped to
 * `Zone:Read` + `DNS:Read`, so its read-only promise is enforced by Cloudflare
 * itself: even a bug in the test could not write. **Purelymail has no token
 * scoping at all.** One account token carries every operation in the API,
 * including `deleteDomain` and `deleteUser`, and there is no safe-by-
 * construction credential to ask for.
 *
 * Safety therefore comes from THIS FILE's call list rather than from the
 * credential, which is a weaker guarantee and is recorded as such:
 *
 * - the only adapter methods called anywhere below are `checkAccountCredit`,
 *   `listDomains`, `listUsers` (the provider's `listUser`), and
 *   `listRoutingRules`. There is no `addDomain`, no `createUser`, no
 *   `deleteUser`, no `createRoutingRule`, no `deleteRoutingRule`, and no
 *   `recheckDomainDns` — the last of those is a WRITE to
 *   `updateDomainSettings` despite reading like a query;
 * - the account this file points at should be one whose loss would not matter;
 * - no credential material is printed, asserted by value, or interpolated into
 *   a message. Leak checks are containment comparisons over serialized output;
 * - {@link check} runs each assertion group inside a try/catch and re-throws a
 *   message built only from the label, so a vitest diff can never print a
 *   payload — a real account's domain and mailbox names are the operator's
 *   data, not test fixtures;
 * - polite volume: at most four requests through a budget well below the
 *   suggested default, against an API with no published limit.
 *
 * ## What this leg is for
 *
 * **Confirming the operation NAMES currently marked UNVERIFIED in
 * `operations.ts`.** Every name there was transcribed from the provider's
 * OpenAPI document and none has been exercised against a live account. Because
 * the API is RPC-shaped, a wrong name presents unmistakably — HTTP 404 with an
 * HTML page, which the adapter classifies as `not_found` — so a green run of
 * this file is exactly the evidence needed to strike the UNVERIFIED markers
 * from the four read operations. The write names stay unverified on purpose.
 *
 * Two other things it records rather than asserts: any envelope error code the
 * real API returns that is not in `PURELYMAIL_AUTH_ERROR_CODES`, and whether a
 * successful call really carries the `type: "success"` discriminator or only
 * the documented bare `result`.
 */
import { describe, expect, it } from "vitest";
import {
  PURELYMAIL_LIST_USER_LIMIT,
  createPurelymailAdapter,
  createRateBudget,
  defaultPurelymailEnvFilePath,
  loadPurelymailCredentialsFromEnvFile,
} from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const optedIn = liveTestsEnabledFor("purelymail");
const creds = optedIn ? loadPurelymailCredentialsFromEnvFile() : null;

if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-purelymail] skipped: not opted in — set " +
      "LOXEP_LIVE_TESTS=purelymail (or =all) to run against the live instance.",
  );
} else if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    `[live-purelymail] skipped: no credentials at ${defaultPurelymailEnvFilePath()}`,
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

function makeAdapter() {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createPurelymailAdapter({
    apiToken: creds.apiToken,
    ...(creds.baseUrl === undefined ? {} : { baseUrl: creds.baseUrl }),
    // Deliberately gentle against an API that publishes no limit at all. The
    // absence of a documented ceiling is a reason for a smaller number, not a
    // larger one.
    rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 0.5 }),
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text.includes(creds.apiToken)).toBe(false);
}

/**
 * Run an assertion group with scrubbed failure output: on failure, only the
 * label escapes, never a diff over a real account's data.
 */
function check(label: string, assertions: () => void): void {
  try {
    assertions();
  } catch {
    throw new Error(`live assertion failed: ${label}`);
  }
}

describeLive("Purelymail live account (read-only)", () => {
  it("authenticates with the Purelymail-Api-Token header and reads the credit", async () => {
    // The cheapest authenticated read in the API, and the one path already
    // live-verified to EXIST (the 2026-08-13 unauthenticated probe hit it). A
    // success here confirms the header, the base URL, and the `account.credit`
    // name at once — and proves the HTTP 200 envelope can carry a success as
    // well as the `invalidToken` error the probe saw.
    const adapter = makeAdapter();
    const credit = await adapter.checkAccountCredit();

    check("credit is the provider's own string, never a number", () => {
      expect(typeof credit).toBe("string");
      expect(credit.length).toBeGreaterThan(0);
    });

    check("no credential material reaches stats", () => {
      assertNoCredentialMaterial(JSON.stringify(adapter.stats()));
    });
  });

  it("confirms the listDomains name and returns Loxep domain facts", async () => {
    const adapter = makeAdapter();
    const domains = await adapter.listDomains();

    check("every domain is a fact with a name and a four-part DNS verdict", () => {
      expect(Array.isArray(domains)).toBe(true);
      for (const domain of domains) {
        expect(domain.name.length).toBeGreaterThan(0);
        expect(typeof domain.dns.passesMx).toBe("boolean");
        expect(typeof domain.dns.passesSpf).toBe("boolean");
        expect(typeof domain.dns.passesDkim).toBe("boolean");
        expect(typeof domain.dns.passesDmarc).toBe("boolean");
      }
    });

    check("shared domains are excluded unless asked for", () => {
      for (const domain of domains) expect(domain.isShared).toBe(false);
    });

    check("no credential material reaches the facts", () => {
      assertNoCredentialMaterial(JSON.stringify(domains));
    });

    // Reported, not asserted. Purelymail warns that anyone controlling a
    // domain's DNS can recover the ACCOUNT password when this is on, and Loxep
    // never turns it on — but an operator may have, before Loxep existed.
    const resettable = domains.filter((domain) => domain.allowAccountReset);
    if (resettable.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[live-purelymail] ${resettable.length} domain(s) allow ACCOUNT password reset`,
      );
    }
  });

  it("confirms the listUser name and the absence of any paging", async () => {
    const adapter = makeAdapter();
    const users = await adapter.listUsers();

    check("users are plain address strings", () => {
      expect(Array.isArray(users)).toBe(true);
      for (const user of users) {
        expect(typeof user).toBe("string");
        expect(user.includes("@")).toBe(true);
      }
    });

    check("no credential material reaches the addresses", () => {
      assertNoCredentialMaterial(JSON.stringify(users));
    });

    // The operation is documented as returning "up to 1000" with no page,
    // cursor, or per_page parameter of any kind, so a result AT the ceiling is
    // indistinguishable from a truncated one. Reported rather than failed: it
    // is a finding about the account, not about the adapter.
    if (users.length >= PURELYMAIL_LIST_USER_LIMIT) {
      // eslint-disable-next-line no-console
      console.info(
        `[live-purelymail] listUser returned ${users.length} addresses — at or above the ${PURELYMAIL_LIST_USER_LIMIT} ceiling, so the list may be truncated`,
      );
    }
  });

  it("confirms the listRoutingRules name and the int64 rule id", async () => {
    const adapter = makeAdapter();
    const rules = await adapter.listRoutingRules();

    check("every rule carries the numeric id its delete call needs", () => {
      expect(Array.isArray(rules)).toBe(true);
      for (const rule of rules) {
        expect(Number.isFinite(rule.id)).toBe(true);
        expect(rule.domainName.length).toBeGreaterThan(0);
        expect(Array.isArray(rule.targetAddresses)).toBe(true);
      }
    });

    check("no credential material reaches the rules", () => {
      assertNoCredentialMaterial(JSON.stringify(rules));
    });
  });

  it("reports capabilities that match what the account actually allows", () => {
    const capabilities = makeAdapter().capabilities();
    check("capabilities are the honest-degradation contract", () => {
      expect(capabilities.provider).toBe("purelymail");
      expect(capabilities.routingRules).toBe(true);
      expect(capabilities.catchAll).toBe(true);
      // Loxep mints the mailbox password; the provider does not supply one.
      expect(capabilities.suppliesMailboxPassword).toBe(false);
      expect(capabilities.ownershipCodeScope).toBe("account");
      expect(capabilities.requiredRecordCount).toBe(7);
    });
  });

  // NOT tested here, and deliberately: `getOwnershipCode` is a read, but it is
  // the account's proof-of-ownership secret-shaped value, and this file's
  // scrubbing discipline is easier to keep if it never holds one. Confirming
  // that name is an owner-gated manual check. Every write name —
  // `addDomain`, `updateDomainSettings`, `createUser`, `deleteUser`,
  // `createRoutingRule`, `deleteRoutingRule` — stays UNVERIFIED until an
  // operator exercises it against a throwaway domain by hand.
});
