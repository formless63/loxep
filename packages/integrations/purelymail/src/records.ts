/**
 * **Purelymail's required DNS record set**, and the one file in this milestone
 * whose being wrong would not surface for weeks.
 *
 * The infrastructure design deliberately lists no mail record set and says why:
 *
 * > Verify the exact required record set against the mail provider's own
 * > current documentation at implementation time. Do not carry values forward
 * > from any draft, including this one — this design deliberately lists none.
 * > The set is stable in practice, and it is also the difference between
 * > working mail and a failure mode that presents weeks late.
 *
 * ## Source, verified 2026-08-13
 *
 * `https://purelymail.com/docs/domainDocs` ("Custom Domain Setup"), which is
 * the provider's own reproduction of the instructions on its Add New Domain
 * page. Its Cloudflare walkthrough gives every value literally, and its "Why do
 * I need to add all these DNS records?" section numbers them 1 through 7 — the
 * numbering this file preserves.
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
 * Verbatim from that page, in the Cloudflare section: put `@` on the Name field
 * and *"mailserver.purelymail.com"* on the Mail Server field, *"Leave TTL on
 * Auto and set priority to 50"*; the SPF content is
 * *"v=spf1 include:_spf.purelymail.com ~all"*; the DKIM records are
 * *"purelymail1._domainkey"* → *"key1.dkimroot.purelymail.com"* and the same
 * for 2 and 3; and the DMARC record is *"_dmarc"* → *"dmarcroot.purelymail.com"*.
 *
 * ## Four things about this set that are not obvious
 *
 * 1. **DMARC is a `CNAME`, not a `TXT`.** Nearly every other provider publishes
 *    `_dmarc` as a `TXT` record, and "fixing" this to a TXT policy string is
 *    exactly the plausible edit that would break alignment reporting. It is a
 *    delegation to `dmarcroot.purelymail.com`, which is how Purelymail keeps
 *    the policy under its own control.
 * 2. **There are THREE DKIM keys, not one.** The provider's own explanation:
 *    *"There are three of them because we sign your mails with one of three
 *    different keys, which we regularly rotate for security purposes."*
 *    Publishing only one produces mail that verifies two thirds of the time —
 *    the archetypal failure that presents weeks late.
 * 3. **The ownership code is per ACCOUNT, not per domain.** Verified from the
 *    API rather than the docs page: `getOwnershipCode` takes an EMPTY request
 *    body. The same published value proves every domain in the account, which
 *    is why {@link purelymailRequiredRecords} takes the code as an argument
 *    instead of deriving it from the domain.
 * 4. **`purelymail1._domainkey` is a zone-RELATIVE name.** Loxep's
 *    `dns_records.name` is zone-relative by construction and the DNS provider
 *    adapter (`@loxep/integration-cloudflare`'s `toProviderName`) appends the
 *    zone. Emitting a fully-qualified name here would produce
 *    `purelymail1._domainkey.example.com.example.com`.
 *
 * ## Never proxied — and the provider says so too
 *
 * Every record here is emitted with no proxy intent, and
 * `materializeDesiredRecords` forces `proxied = false` on the whole `mail`
 * owner class regardless of what this file returns, and
 * `dns_records_mail_not_proxied_check` refuses the row if both miss. Three
 * belts, because the failure is invisible.
 *
 * Purelymail's own Cloudflare instructions say the same thing from the other
 * side, for each DKIM CNAME and for DMARC: *"click on the cloud on 'Proxy
 * Status' and set it as DNS only (this is very important)"*. That is the
 * provider independently stating the invariant the schema enforces.
 *
 * ## TTL
 *
 * Every record is emitted with `ttlSeconds: null`, which in Loxep means "let
 * the provider choose". The docs page says *"TTL (Time to Live) fields can
 * generally be left to their defaults"*, so there is no value to carry and a
 * hardcoded one would only be a number to get wrong.
 */

/** One record Purelymail requires, in Loxep's zone-relative vocabulary. */
export interface PurelymailDnsRecord {
  type: "MX" | "TXT" | "CNAME";
  /** ZONE-RELATIVE: `@`, `_dmarc`, `purelymail1._domainkey`. */
  name: string;
  content: string;
  /** `null` means "provider default". */
  ttlSeconds: number | null;
  /** MX only. */
  priority: number | null;
  /**
   * Which of the docs page's numbered records this is, and what it does.
   * Carried through to `dns_records` nowhere — it exists for run-step summaries
   * and for the operator-facing checklist, so a partially-published set can be
   * described in words rather than as a diff.
   */
  purpose: "mx" | "spf" | "ownership" | "dkim" | "dmarc";
}

/** The mail exchanger, docs record #1. */
export const PURELYMAIL_MX_HOST = "mailserver.purelymail.com";
/** Docs record #1: *"set priority to 50"*. */
export const PURELYMAIL_MX_PRIORITY = 50;
/** Docs record #2, verbatim. */
export const PURELYMAIL_SPF_CONTENT = "v=spf1 include:_spf.purelymail.com ~all";
/** Docs records #4-#6: three keys, rotated by the provider. */
export const PURELYMAIL_DKIM_SELECTORS = [
  { name: "purelymail1._domainkey", content: "key1.dkimroot.purelymail.com" },
  { name: "purelymail2._domainkey", content: "key2.dkimroot.purelymail.com" },
  { name: "purelymail3._domainkey", content: "key3.dkimroot.purelymail.com" },
] as const;
/** Docs record #7 — a CNAME, deliberately, not a TXT policy. */
export const PURELYMAIL_DMARC_NAME = "_dmarc";
export const PURELYMAIL_DMARC_CONTENT = "dmarcroot.purelymail.com";

/** How many records a fully-published Purelymail domain has. */
export const PURELYMAIL_RECORD_COUNT = 7;

/**
 * The records that do not depend on the ownership code: #1, #2, #4, #5, #6, #7.
 *
 * These can be published the moment mail is enabled — before the account is
 * even asked for a code — which is what lets DNS propagation and the ownership
 * fetch overlap instead of serializing.
 */
export function purelymailBaseRecords(): PurelymailDnsRecord[] {
  return [
    {
      type: "MX",
      name: "@",
      content: PURELYMAIL_MX_HOST,
      ttlSeconds: null,
      priority: PURELYMAIL_MX_PRIORITY,
      purpose: "mx",
    },
    {
      type: "TXT",
      name: "@",
      content: PURELYMAIL_SPF_CONTENT,
      ttlSeconds: null,
      priority: null,
      purpose: "spf",
    },
    ...PURELYMAIL_DKIM_SELECTORS.map(
      (selector): PurelymailDnsRecord => ({
        type: "CNAME",
        name: selector.name,
        content: selector.content,
        ttlSeconds: null,
        priority: null,
        purpose: "dkim",
      }),
    ),
    {
      type: "CNAME",
      name: PURELYMAIL_DMARC_NAME,
      content: PURELYMAIL_DMARC_CONTENT,
      ttlSeconds: null,
      priority: null,
      purpose: "dmarc",
    },
  ];
}

/**
 * The ownership-proof record, #3 — or nothing while the code is unknown.
 *
 * Emitting nothing is the correct behavior rather than a gap: the materializer
 * runs on every intent change, and a domain whose code has not been fetched yet
 * should publish the six records it CAN publish rather than failing the run.
 * The code arrives from `getOwnershipCode` and the next materialize adds record
 * #3, which is the ordinary desired-state path with no special casing.
 *
 * The value is published VERBATIM. Purelymail's docs page shows the ownership
 * TXT content as an opaque per-account string with no `purelymail-verify=`
 * style prefix — it says only *"This specific value is different per user and
 * can be found on the add Domains page"*. Adding a prefix, trimming, or
 * lower-casing it would break verification silently.
 */
export function purelymailOwnershipRecord(
  ownershipCode: string,
): PurelymailDnsRecord {
  return {
    type: "TXT",
    name: "@",
    content: ownershipCode,
    ttlSeconds: null,
    priority: null,
    purpose: "ownership",
  };
}

/**
 * The full required set for one domain.
 *
 * `ownershipCode` is `null` until the account's code has been fetched, in which
 * case six of the seven records are returned. The name is unused — the set is
 * identical for every domain, which is worth stating explicitly because a
 * reader will assume otherwise from the signature. It is accepted so that the
 * signature does not change when a provider whose set IS domain-dependent is
 * added behind the same port.
 */
export function purelymailRequiredRecords(input: {
  domainName: string;
  ownershipCode: string | null;
}): PurelymailDnsRecord[] {
  const records = purelymailBaseRecords();
  if (input.ownershipCode !== null && input.ownershipCode !== "") {
    records.push(purelymailOwnershipRecord(input.ownershipCode));
  }
  return records;
}
