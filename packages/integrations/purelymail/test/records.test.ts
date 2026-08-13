/**
 * **The verified DNS record set** — the highest-value file in this suite,
 * because it is the one whose being wrong would not surface for weeks.
 *
 * The infrastructure design refuses to list a mail record set and says why:
 *
 * > Verify the exact required record set against the mail provider's own
 * > current documentation at implementation time. Do not carry values forward
 * > from any draft, including this one — this design deliberately lists none.
 * > The set is stable in practice, and it is also the difference between
 * > working mail and a failure mode that presents weeks late.
 *
 * So these assertions are written from the provider's own page rather than
 * from `src/records.ts`: `https://purelymail.com/docs/domainDocs` ("Custom
 * Domain Setup"), read 2026-08-13, whose "Why do I need to add all these DNS
 * records?" section numbers them 1 through 7:
 *
 * ```text
 * #1  MX     @                       mailserver.purelymail.com   priority 50
 * #2  TXT    @                       v=spf1 include:_spf.purelymail.com ~all
 * #3  TXT    @                       <ownership code>            per ACCOUNT
 * #4  CNAME  purelymail1._domainkey  key1.dkimroot.purelymail.com
 * #5  CNAME  purelymail2._domainkey  key2.dkimroot.purelymail.com
 * #6  CNAME  purelymail3._domainkey  key3.dkimroot.purelymail.com
 * #7  CNAME  _dmarc                  dmarcroot.purelymail.com
 * ```
 *
 * Every literal below is typed out in full rather than referenced through a
 * `PURELYMAIL_*` constant, on purpose. A test that asserts
 * `record.content === PURELYMAIL_MX_HOST` passes no matter what the constant
 * says and therefore verifies nothing about the record set; it only verifies
 * that a function returns its own input. The constants are checked separately,
 * once, against the same literals.
 *
 * Four properties get their own named test because each is a plausible WRONG
 * EDIT rather than a plausible typo: three DKIM keys and not one, DMARC as a
 * CNAME and not a TXT, zone-relative names, and the ownership code verbatim.
 */
import { describe, expect, it } from "vitest";
import {
  PURELYMAIL_DKIM_SELECTORS,
  PURELYMAIL_DMARC_CONTENT,
  PURELYMAIL_DMARC_NAME,
  PURELYMAIL_MX_HOST,
  PURELYMAIL_MX_PRIORITY,
  PURELYMAIL_RECORD_COUNT,
  PURELYMAIL_SPF_CONTENT,
  purelymailBaseRecords,
  purelymailOwnershipRecord,
  purelymailRequiredRecords,
} from "../src/index.ts";
import type { PurelymailDnsRecord } from "../src/index.ts";
import { TEST_DOMAIN, TEST_OWNERSHIP_CODE } from "./http.ts";

/** The set, as the provider's page states it. Not derived from the source. */
const SEVEN_RECORDS: PurelymailDnsRecord[] = [
  {
    type: "MX",
    name: "@",
    content: "mailserver.purelymail.com",
    ttlSeconds: null,
    priority: 50,
    purpose: "mx",
  },
  {
    type: "TXT",
    name: "@",
    content: "v=spf1 include:_spf.purelymail.com ~all",
    ttlSeconds: null,
    priority: null,
    purpose: "spf",
  },
  {
    type: "CNAME",
    name: "purelymail1._domainkey",
    content: "key1.dkimroot.purelymail.com",
    ttlSeconds: null,
    priority: null,
    purpose: "dkim",
  },
  {
    type: "CNAME",
    name: "purelymail2._domainkey",
    content: "key2.dkimroot.purelymail.com",
    ttlSeconds: null,
    priority: null,
    purpose: "dkim",
  },
  {
    type: "CNAME",
    name: "purelymail3._domainkey",
    content: "key3.dkimroot.purelymail.com",
    ttlSeconds: null,
    priority: null,
    purpose: "dkim",
  },
  {
    type: "CNAME",
    name: "_dmarc",
    content: "dmarcroot.purelymail.com",
    ttlSeconds: null,
    priority: null,
    purpose: "dmarc",
  },
  {
    type: "TXT",
    name: "@",
    content: TEST_OWNERSHIP_CODE,
    ttlSeconds: null,
    priority: null,
    purpose: "ownership",
  },
];

const full = (): PurelymailDnsRecord[] =>
  purelymailRequiredRecords({
    domainName: TEST_DOMAIN,
    ownershipCode: TEST_OWNERSHIP_CODE,
  });

describe("the seven records purelymail.com/docs/domainDocs requires", () => {
  it("emits exactly the seven records, with exactly those names and contents", () => {
    // The whole set in one assertion, so a record that is added, dropped, or
    // reordered fails here rather than in six places.
    expect(full()).toEqual(SEVEN_RECORDS);
    expect(full()).toHaveLength(7);
    expect(PURELYMAIL_RECORD_COUNT).toBe(7);
  });

  it("publishes mail to mailserver.purelymail.com at priority 50", () => {
    // Docs record #1, verbatim: put `@` on Name, `mailserver.purelymail.com` on
    // Mail Server, "Leave TTL on Auto and set priority to 50".
    const mx = full().filter((record) => record.type === "MX");
    expect(mx).toHaveLength(1);
    expect(mx[0]?.name).toBe("@");
    expect(mx[0]?.content).toBe("mailserver.purelymail.com");
    expect(mx[0]?.priority).toBe(50);
    // And a priority on nothing else, MX being the only type that takes one.
    for (const record of full()) {
      if (record.type !== "MX") expect(record.priority).toBeNull();
    }
  });

  it("publishes the SPF include with a soft fail, not a hard one", () => {
    // Docs record #2, character for character. `~all` and `-all` are one
    // character apart and mean very different things to a receiving MTA.
    const spf = full().find((record) => record.purpose === "spf");
    expect(spf?.type).toBe("TXT");
    expect(spf?.name).toBe("@");
    expect(spf?.content).toBe("v=spf1 include:_spf.purelymail.com ~all");
  });

  it("publishes THREE DKIM records, because the provider rotates three keys", () => {
    // The provider's own explanation: "There are three of them because we sign
    // your mails with one of three different keys, which we regularly rotate
    // for security purposes." Publishing one produces mail that verifies two
    // thirds of the time — the archetypal failure that presents weeks late,
    // looks like a receiving-side problem, and is invisible to the sender.
    const dkim = full().filter((record) => record.purpose === "dkim");
    expect(dkim).toHaveLength(3);
    expect(dkim.map((record) => [record.type, record.name, record.content])).toEqual([
      ["CNAME", "purelymail1._domainkey", "key1.dkimroot.purelymail.com"],
      ["CNAME", "purelymail2._domainkey", "key2.dkimroot.purelymail.com"],
      ["CNAME", "purelymail3._domainkey", "key3.dkimroot.purelymail.com"],
    ]);
  });

  it("keeps the DKIM selector index aligned with the key index", () => {
    // `purelymail2._domainkey` -> `key2....`. A transposed pair would publish
    // three valid-looking records that verify nothing, which reads as correct
    // in every diff and in the provider's own record count.
    for (const [index, record] of full()
      .filter((entry) => entry.purpose === "dkim")
      .entries()) {
      const n = index + 1;
      expect(record.name).toBe(`purelymail${n}._domainkey`);
      expect(record.content).toBe(`key${n}.dkimroot.purelymail.com`);
    }
  });

  it("publishes _dmarc as a CNAME, NOT as a TXT policy string", () => {
    // Nearly every other mail provider publishes `_dmarc` as a TXT carrying
    // `v=DMARC1; p=none; ...`, so "fixing" this to a TXT is the single most
    // plausible wrong edit in the file. Purelymail delegates instead, keeping
    // the policy under its own control at dmarcroot.purelymail.com.
    const dmarc = full().filter((record) => record.name === "_dmarc");
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0]?.type).toBe("CNAME");
    expect(dmarc[0]?.content).toBe("dmarcroot.purelymail.com");
    expect(dmarc[0]?.content.startsWith("v=DMARC")).toBe(false);
  });

  it("uses only the MX, TXT, and CNAME types this provider needs", () => {
    expect(new Set(full().map((record) => record.type))).toEqual(
      new Set(["MX", "TXT", "CNAME"]),
    );
  });
});

describe("the ownership code travels verbatim", () => {
  // Purelymail's page shows the ownership TXT as an opaque per-account string
  // with no `purelymail-verify=` style prefix — "This specific value is
  // different per user and can be found on the add Domains page". A prefix,
  // a trim, a quote, or a case change breaks verification SILENTLY: the record
  // resolves, the provider simply never matches it, and the domain sits
  // unverified while everything else looks published and healthy.
  it("adds no prefix, suffix, or quoting", () => {
    const record = purelymailOwnershipRecord(TEST_OWNERSHIP_CODE);
    expect(record.content).toBe(TEST_OWNERSHIP_CODE);
    // A DNS provider adds presentation-format quoting itself; adding it here
    // would publish a TXT whose content includes literal quote characters.
    expect(record.content.startsWith('"')).toBe(false);
    expect(record.content.endsWith('"')).toBe(false);
  });

  it("does not trim whitespace and does not change case", () => {
    const padded = "  code-with-padding  ";
    expect(purelymailOwnershipRecord(padded).content).toBe(padded);
    const mixed = "AbCdEf0123XyZ";
    expect(purelymailOwnershipRecord(mixed).content).toBe(mixed);
  });

  it("is a TXT at the apex, with the same TTL treatment as every other record", () => {
    expect(purelymailOwnershipRecord(TEST_OWNERSHIP_CODE)).toEqual({
      type: "TXT",
      name: "@",
      content: TEST_OWNERSHIP_CODE,
      ttlSeconds: null,
      priority: null,
      purpose: "ownership",
    });
  });
});

describe("names are ZONE-RELATIVE", () => {
  // Loxep's `dns_records.name` is zone-relative by construction and the DNS
  // provider adapter appends the zone (`@loxep/integration-cloudflare`'s
  // `toProviderName`). A fully-qualified name emitted here would become
  // `purelymail1._domainkey.example.test.example.test` — a record that resolves
  // to nothing and looks plausible in the provider's UI.
  it("never appends the domain name, and never emits a trailing dot", () => {
    for (const record of full()) {
      expect(record.name.includes(TEST_DOMAIN)).toBe(false);
      expect(record.name.endsWith(".")).toBe(false);
    }
    // `@` for the apex, not the domain name: the three apex records are the MX,
    // the SPF TXT, and the ownership TXT.
    expect(
      full()
        .filter((record) => record.name === "@")
        .map((record) => record.purpose),
    ).toEqual(["mx", "spf", "ownership"]);
  });

  it("emits the same set regardless of the domain name", () => {
    // Stated explicitly because the signature invites the opposite assumption:
    // `domainName` is accepted so the port's shape survives a provider whose
    // set IS domain-dependent, and is unused today.
    expect(
      purelymailRequiredRecords({
        domainName: "alpha.test",
        ownershipCode: TEST_OWNERSHIP_CODE,
      }),
    ).toEqual(
      purelymailRequiredRecords({
        domainName: "beta.example.co.uk",
        ownershipCode: TEST_OWNERSHIP_CODE,
      }),
    );
  });
});

describe("the ownership code decides six records or seven", () => {
  it("returns SIX records when the code is null, and never a placeholder", () => {
    // A domain whose code has not been fetched yet must publish what it CAN,
    // so DNS propagation and the ownership fetch overlap instead of
    // serializing. Emitting a record with an empty or placeholder content would
    // publish a TXT that permanently fails verification.
    const records = purelymailRequiredRecords({
      domainName: TEST_DOMAIN,
      ownershipCode: null,
    });
    expect(records).toHaveLength(6);
    expect(records.some((record) => record.purpose === "ownership")).toBe(false);
    expect(records).toEqual(SEVEN_RECORDS.slice(0, 6));
  });

  it("treats an empty-string code as unknown rather than as a value", () => {
    expect(
      purelymailRequiredRecords({
        domainName: TEST_DOMAIN,
        ownershipCode: "",
      }),
    ).toHaveLength(6);
  });

  it("adds the ownership record LAST, so the base six keep their order", () => {
    // Not cosmetic: a desired-state materializer that diffs by position would
    // otherwise report six changes on the run that first learns the code.
    const base = purelymailBaseRecords();
    expect(base).toHaveLength(6);
    expect(base.map((record) => record.purpose)).toEqual([
      "mx",
      "spf",
      "dkim",
      "dkim",
      "dkim",
      "dmarc",
    ]);
    expect(full().slice(0, 6)).toEqual(base);
    expect(full()[6]?.purpose).toBe("ownership");
  });
});

describe("every record is unproxied and TTL-neutral", () => {
  it("carries no proxy intent of any kind", () => {
    // Three belts hold this invariant — this function, the materializer forcing
    // `proxied = false` on the whole `mail` owner class, and the
    // `dns_records_mail_not_proxied_check` constraint — because a proxied MX or
    // DKIM record is invisible until mail stops. Purelymail's own Cloudflare
    // instructions state it from the other side: "set it as DNS only (this is
    // very important)". The record shape here simply has no field to say
    // otherwise, which is the strongest form of the guarantee.
    for (const record of full()) {
      const keys = Object.keys(record).sort();
      expect(keys).toEqual([
        "content",
        "name",
        "priority",
        "purpose",
        "ttlSeconds",
        "type",
      ]);
      expect(keys.some((key) => /prox/i.test(key))).toBe(false);
    }
  });

  it("leaves every ttlSeconds null, meaning 'let the provider choose'", () => {
    // The docs page says "TTL (Time to Live) fields can generally be left to
    // their defaults", so there is no value to carry and a hardcoded one would
    // only be a number to get wrong.
    for (const record of full()) {
      expect(record.ttlSeconds).toBeNull();
    }
  });
});

describe("the exported constants agree with the published set", () => {
  it("names the mail exchanger, the SPF content, DKIM, and DMARC", () => {
    expect(PURELYMAIL_MX_HOST).toBe("mailserver.purelymail.com");
    expect(PURELYMAIL_MX_PRIORITY).toBe(50);
    expect(PURELYMAIL_SPF_CONTENT).toBe(
      "v=spf1 include:_spf.purelymail.com ~all",
    );
    expect(PURELYMAIL_DMARC_NAME).toBe("_dmarc");
    expect(PURELYMAIL_DMARC_CONTENT).toBe("dmarcroot.purelymail.com");
    expect([...PURELYMAIL_DKIM_SELECTORS]).toEqual([
      { name: "purelymail1._domainkey", content: "key1.dkimroot.purelymail.com" },
      { name: "purelymail2._domainkey", content: "key2.dkimroot.purelymail.com" },
      { name: "purelymail3._domainkey", content: "key3.dkimroot.purelymail.com" },
    ]);
  });
});

describe("callers cannot corrupt the set for the next caller", () => {
  it("returns a fresh array of fresh objects on every call", () => {
    // A materializer that normalizes in place would otherwise mutate the set
    // every later domain receives.
    const first = purelymailBaseRecords();
    first.push(purelymailOwnershipRecord("injected"));
    const mx = first[0];
    if (mx !== undefined) mx.content = "mutated.example.test";

    const second = purelymailBaseRecords();
    expect(second).toHaveLength(6);
    expect(second[0]?.content).toBe("mailserver.purelymail.com");
  });
});
