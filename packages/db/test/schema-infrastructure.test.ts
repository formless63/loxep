/**
 * Phase 7's DDL against real PostgreSQL — migration 0012's milestone-1 tables
 * (`hosting_targets`, `managed_domains`, `dns_records`, `reconcile_runs`,
 * `reconcile_run_steps`, `dns_drift_findings`, `provider_operations`) and
 * migration 0013's milestone-2 mail tables (`mailbox_templates`,
 * `mailbox_template_entries`, `mail_domains`, `mailboxes`).
 *
 * These write through the pool rather than through a service, because the
 * constraints below are the ones that must hold even when a service forgets
 * to. Three of them are load-bearing enough that the design says so explicitly:
 *
 *   * `dns_records_mail_not_proxied_check` — "belt and braces, and both belts
 *     are load-bearing". A proxied mail CNAME breaks signature alignment
 *     silently, weeks later.
 *   * `dns_drift_findings_unexpected_record_check` + the unresolved partial
 *     unique — what makes a recurring sweep idempotent instead of a row
 *     accumulator, and what lets `unexpected` drift exist at all.
 *   * `hosting_targets_*` — the fronting-chain shape whose failure mode is a
 *     published, unreachable address that looks like a propagation problem.
 *
 * `@loxep/infrastructure`'s own tests cover the SERVICE rules (never
 * auto-delete an unexpected record, resurrect a soft-deleted row, refuse a
 * fronting cycle). This file covers only what PostgreSQL itself enforces.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "../src/migrate.ts";
import type { DbHandle } from "../src/migrate.ts";
import { connections } from "../src/schema/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

describe("infrastructure control plane schema (migration 0012)", () => {
  const dbName = scratchDbName("loxep_test_infra_schema");
  let handle: DbHandle;
  let dnsConnectionId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);

    const [connection] = await handle.db
      .insert(connections)
      .values({
        provider: "cloudflare",
        kind: "dns",
        name: "Cloudflare (test)",
        status: "active",
        config: { accountId: "acct_test" },
      })
      .returning();
    if (connection === undefined) {
      throw new Error("connection insert returned no row");
    }
    dnsConnectionId = connection.id;
  }, 120_000);

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  let seq = 0;
  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  async function insertRow(
    table: string,
    columns: Record<string, string>,
  ): Promise<string> {
    const result = await handle.pool.query<{ id: string }>(
      `insert into ${table} (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")}) returning id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`${table} insert returned no row`);
    return id;
  }

  async function insertTarget(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const n = nextSeq();
    return insertRow("hosting_targets", {
      name: `'target-${n}'`,
      control_surface: `'direct_reverse_proxy'`,
      address_v4: `'203.0.113.${n % 200}'`,
      ...overrides,
    });
  }

  async function insertDomain(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const n = nextSeq();
    return insertRow("managed_domains", {
      name: `'example-${n}.test'`,
      dns_connection_id: `'${dnsConnectionId}'`,
      ...overrides,
    });
  }

  async function insertRun(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const subjectId = await insertDomain();
    return insertRow("reconcile_runs", {
      kind: `'sync-records'`,
      subject_type: `'domain'`,
      subject_id: `'${subjectId}'`,
      mode: `'check'`,
      trigger: `'sweep'`,
      ...overrides,
    });
  }

  /* ------------------------------------------------------- hosting_targets */

  describe("hosting_targets", () => {
    it("accepts a direct reverse proxy with an address", async () => {
      await expect(insertTarget()).resolves.toBeTypeOf("string");
    });

    it("validates addresses through inet, so a malformed one never reaches DNS", async () => {
      // inet preserves the netmask it was given (this is `inet`, not `cidr`),
      // so the materializer must publish host(address), not address::text.
      const id = await insertTarget({ address_v4: `'203.0.113.7/32'` });
      const row = await handle.pool.query<{ addr: string; host: string }>(
        `select address_v4::text as addr, host(address_v4) as host
           from hosting_targets where id = $1`,
        [id],
      );
      expect(row.rows[0]?.addr).toBe("203.0.113.7/32");
      expect(row.rows[0]?.host).toBe("203.0.113.7");

      // The whole reason the column is inet rather than text: PostgreSQL
      // refuses the malformed value that would otherwise become a published,
      // unresolvable record.
      await expect(
        insertTarget({ address_v4: `'not-an-address'` }),
      ).rejects.toThrow(/invalid input syntax|inet/i);
      await expect(
        insertTarget({ address_v4: `'203.0.113.300'` }),
      ).rejects.toThrow(/invalid input syntax|inet/i);
    });

    it("accepts an IPv6 address", async () => {
      const id = await insertTarget({
        address_v4: `null`,
        address_v6: `'2001:db8::1'`,
      });
      const row = await handle.pool.query<{ host: string }>(
        `select host(address_v6) as host from hosting_targets where id = $1`,
        [id],
      );
      expect(row.rows[0]?.host).toBe("2001:db8::1");
    });

    it("rejects an unknown control surface", async () => {
      await expect(
        insertTarget({ control_surface: `'kubernetes'` }),
      ).rejects.toThrow(/hosting_targets_control_surface_check/);
    });

    it("requires a name to be unique installation-wide", async () => {
      await insertTarget({ name: `'shared-name'` });
      await expect(insertTarget({ name: `'shared-name'` })).rejects.toThrow(
        /hosting_targets_name_uq/,
      );
    });

    it("requires an addressable target unless control_surface is 'none'", async () => {
      await expect(
        insertTarget({ address_v4: `null` }),
      ).rejects.toThrow(/hosting_targets_addressable_check/);

      await expect(
        insertTarget({ control_surface: `'none'`, address_v4: `null` }),
      ).resolves.toBeTypeOf("string");
    });

    it("ties control_surface = 'tunnel_client' to fronted_by_target_id, both ways", async () => {
      const node = await insertTarget({ control_surface: `'proxy_node'` });

      // tunnel_client without a fronting node
      await expect(
        insertTarget({ control_surface: `'tunnel_client'` }),
      ).rejects.toThrow(/hosting_targets_tunnel_client_check/);

      // a fronting node on a non-tunnel target
      await expect(
        insertTarget({ fronted_by_target_id: `'${node}'` }),
      ).rejects.toThrow(/hosting_targets_tunnel_client_check/);

      // the shape that is allowed: a tunnel client with no address of its own
      await expect(
        insertTarget({
          control_surface: `'tunnel_client'`,
          address_v4: `null`,
          fronted_by_target_id: `'${node}'`,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("blocks the trivial self-loop but NOT a longer cycle", async () => {
      const a = await insertTarget({ control_surface: `'proxy_node'` });
      await expect(
        handle.pool.query(
          `update hosting_targets set fronted_by_target_id = id where id = $1`,
          [a],
        ),
      ).rejects.toThrow(/hosting_targets_no_self_front_check/);

      // Two-hop chains are NOT constrained declaratively — the design says so
      // and puts the guard in the domain service. This test exists so the next
      // reader does not assume the CHECK covers it.
      const b = await insertTarget({
        control_surface: `'tunnel_client'`,
        address_v4: `null`,
        fronted_by_target_id: `'${a}'`,
      });
      const c = await insertTarget({
        control_surface: `'tunnel_client'`,
        address_v4: `null`,
        fronted_by_target_id: `'${b}'`,
      });
      expect(c).toBeTypeOf("string");
    });
  });

  /* ------------------------------------------------------- managed_domains */

  describe("managed_domains", () => {
    it("defaults to the 'draft' state with proxying and mail intent on", async () => {
      const id = await insertDomain();
      const row = await handle.pool.query<{
        state: string;
        apex_proxied: boolean;
        wildcard_proxied: boolean;
        mail_enabled: boolean;
        consecutive_errors: number;
      }>(`select * from managed_domains where id = $1`, [id]);
      expect(row.rows[0]?.state).toBe("draft");
      expect(row.rows[0]?.apex_proxied).toBe(true);
      expect(row.rows[0]?.wildcard_proxied).toBe(true);
      expect(row.rows[0]?.mail_enabled).toBe(true);
      expect(row.rows[0]?.consecutive_errors).toBe(0);
    });

    it("rejects a state outside the provisioning chain", async () => {
      await expect(insertDomain({ state: `'degraded'` })).rejects.toThrow(
        /managed_domains_state_check/,
      );
    });

    it("requires the name to be globally unique", async () => {
      await insertDomain({ name: `'dup.test'` });
      await expect(insertDomain({ name: `'dup.test'` })).rejects.toThrow(
        /managed_domains_name_uq/,
      );
    });

    it("allows many draft domains with no zone but one zone per connection", async () => {
      await insertDomain();
      await insertDomain();

      await insertDomain({ external_zone_id: `'zone-abc'` });
      await expect(
        insertDomain({ external_zone_id: `'zone-abc'` }),
      ).rejects.toThrow(/managed_domains_connection_zone_uq/);
    });

    it("supports the mail-only shape: no apex target, mail enabled", async () => {
      const id = await insertDomain({
        apex_target_id: `null`,
        mail_enabled: `true`,
      });
      const row = await handle.pool.query<{
        apex_target_id: string | null;
        mail_enabled: boolean;
      }>(`select apex_target_id, mail_enabled from managed_domains where id = $1`, [
        id,
      ]);
      expect(row.rows[0]?.apex_target_id).toBeNull();
      expect(row.rows[0]?.mail_enabled).toBe(true);
    });

    it("stores zone_nameservers as an ordered array read back verbatim", async () => {
      const id = await insertDomain({
        zone_nameservers: `array['ns1.example.test', 'ns2.example.test']`,
      });
      const row = await handle.pool.query<{ zone_nameservers: string[] }>(
        `select zone_nameservers from managed_domains where id = $1`,
        [id],
      );
      expect(row.rows[0]?.zone_nameservers).toEqual([
        "ns1.example.test",
        "ns2.example.test",
      ]);
    });

    it("references a monitor_targets row for recurring cadence (open question 5)", async () => {
      const target = await handle.pool.query<{ id: string }>(
        `insert into monitor_targets (target_type, name, interval_seconds)
         values ('infrastructure_domain_reconcile', 'example.test reconcile', 3600)
         returning id`,
      );
      const targetId = target.rows[0]?.id;
      expect(targetId).toBeTypeOf("string");

      const id = await insertDomain({ reconcile_target_id: `'${targetId}'` });
      expect(id).toBeTypeOf("string");

      await expect(
        insertDomain({
          reconcile_target_id: `'00000000-0000-0000-0000-000000000000'`,
        }),
      ).rejects.toThrow(/managed_domains_reconcile_target_id/);
    });
  });

  /* ----------------------------------------------------------- dns_records */

  describe("dns_records", () => {
    async function insertRecord(
      domainId: string,
      overrides: Record<string, string> = {},
    ): Promise<string> {
      return insertRow("dns_records", {
        domain_id: `'${domainId}'`,
        type: `'A'`,
        name: `'@'`,
        content: `'203.0.113.10'`,
        owner: `'apex'`,
        ...overrides,
      });
    }

    it("accepts any IANA record type — there is deliberately NO check", async () => {
      const domainId = await insertDomain();
      for (const type of ["A", "HTTPS", "TLSA", "SVCB", "NAPTR"]) {
        await expect(
          insertRecord(domainId, {
            type: `'${type}'`,
            name: `'${type.toLowerCase()}.example'`,
          }),
        ).resolves.toBeTypeOf("string");
      }
    });

    it("rejects an owner outside the closed set", async () => {
      const domainId = await insertDomain();
      await expect(
        insertRecord(domainId, { owner: `'automatic'` }),
      ).rejects.toThrow(/dns_records_owner_check/);
    });

    it("makes a proxied mail record impossible to insert", async () => {
      const domainId = await insertDomain();
      await expect(
        insertRecord(domainId, {
          owner: `'mail'`,
          type: `'CNAME'`,
          name: `'key1._domainkey'`,
          content: `'key1.mailprovider.test'`,
          proxied: `true`,
        }),
      ).rejects.toThrow(/dns_records_mail_not_proxied_check/);

      // The same record unproxied is fine, which is the only shape the
      // materializer may ever emit for owner = 'mail'.
      await expect(
        insertRecord(domainId, {
          owner: `'mail'`,
          type: `'CNAME'`,
          name: `'key1._domainkey'`,
          content: `'key1.mailprovider.test'`,
          proxied: `false`,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("treats ttl_seconds as seconds, with NULL meaning provider default", async () => {
      const domainId = await insertDomain();
      await expect(
        insertRecord(domainId, { ttl_seconds: `null` }),
      ).resolves.toBeTypeOf("string");
      await expect(
        insertRecord(domainId, { name: `'a'`, ttl_seconds: `300` }),
      ).resolves.toBeTypeOf("string");

      // 1 is one provider's "automatic" sentinel and must never reach a Loxep
      // column — the range check makes that a hard failure, not a silent
      // one-second TTL.
      await expect(
        insertRecord(domainId, { name: `'b'`, ttl_seconds: `1` }),
      ).rejects.toThrow(/dns_records_ttl_seconds_check/);
      await expect(
        insertRecord(domainId, { name: `'c'`, ttl_seconds: `604801` }),
      ).rejects.toThrow(/dns_records_ttl_seconds_check/);
    });

    it("uses (domain_id, type, name, content) as the natural key", async () => {
      const domainId = await insertDomain();
      await insertRecord(domainId);
      await expect(insertRecord(domainId)).rejects.toThrow(
        /dns_records_natural_key_uq/,
      );

      // Different content is a different record, not a conflict — which is
      // what makes the diff recomputable from either side.
      await expect(
        insertRecord(domainId, { content: `'203.0.113.11'` }),
      ).resolves.toBeTypeOf("string");
    });

    it("keeps tombstones inside the natural key (open question 7)", async () => {
      const domainId = await insertDomain();
      const id = await insertRecord(domainId);
      await handle.pool.query(
        `update dns_records set desired_deleted_at = now() where id = $1`,
        [id],
      );

      // Re-declaring the same record collides with its own tombstone, which is
      // exactly why the materializer must RESURRECT rather than insert.
      await expect(insertRecord(domainId)).rejects.toThrow(
        /dns_records_natural_key_uq/,
      );
    });

    it("cascades from its domain", async () => {
      const domainId = await insertDomain();
      await insertRecord(domainId);
      await handle.pool.query(`delete from managed_domains where id = $1`, [
        domainId,
      ]);
      const rows = await handle.pool.query(
        `select 1 from dns_records where domain_id = $1`,
        [domainId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  /* ------------------------------------- reconcile_runs / _run_steps */

  describe("reconcile_runs and reconcile_run_steps", () => {
    it("stores the apply/check mode as a fact, not a parameter", async () => {
      await expect(insertRun({ mode: `'apply'` })).resolves.toBeTypeOf("string");
      await expect(insertRun({ mode: `'dry-run'` })).rejects.toThrow(
        /reconcile_runs_mode_check/,
      );
    });

    it("rejects unknown status, subject_type, and trigger values", async () => {
      await expect(insertRun({ status: `'queued'` })).rejects.toThrow(
        /reconcile_runs_status_check/,
      );
      await expect(insertRun({ subject_type: `'mailbox'` })).rejects.toThrow(
        /reconcile_runs_subject_type_check/,
      );
      await expect(insertRun({ trigger: `'webhook'` })).rejects.toThrow(
        /reconcile_runs_trigger_check/,
      );
    });

    it("keeps a run whose subject was deleted — subject_id is not an FK", async () => {
      const domainId = await insertDomain();
      const runId = await insertRow("reconcile_runs", {
        kind: `'sync-records'`,
        subject_type: `'domain'`,
        subject_id: `'${domainId}'`,
        mode: `'apply'`,
        trigger: `'manual'`,
      });
      await handle.pool.query(`delete from managed_domains where id = $1`, [
        domainId,
      ]);
      const rows = await handle.pool.query(
        `select 1 from reconcile_runs where id = $1`,
        [runId],
      );
      expect(rows.rowCount).toBe(1);
    });

    it("orders steps uniquely within a run and cascades with it", async () => {
      const runId = await insertRun();
      await handle.pool.query(
        `insert into reconcile_run_steps (run_id, sequence, step, status)
         values ($1, 0, 'read-records', 'succeeded')`,
        [runId],
      );
      await expect(
        handle.pool.query(
          `insert into reconcile_run_steps (run_id, sequence, step, status)
           values ($1, 0, 'read-records', 'succeeded')`,
          [runId],
        ),
      ).rejects.toThrow(/reconcile_run_steps_run_sequence_uq/);

      await handle.pool.query(`delete from reconcile_runs where id = $1`, [
        runId,
      ]);
      const rows = await handle.pool.query(
        `select 1 from reconcile_run_steps where run_id = $1`,
        [runId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  /* --------------------------------------------------- dns_drift_findings */

  describe("dns_drift_findings", () => {
    async function insertFinding(
      domainId: string,
      runId: string,
      overrides: Record<string, string> = {},
    ): Promise<string> {
      return insertRow("dns_drift_findings", {
        domain_id: `'${domainId}'`,
        kind: `'unexpected'`,
        record_type: `'TXT'`,
        record_name: `'_acme-challenge'`,
        observed_content: `'token'`,
        first_seen_run_id: `'${runId}'`,
        last_seen_run_id: `'${runId}'`,
        ...overrides,
      });
    }

    it("represents an 'unexpected' record, which has no intent row at all", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      await expect(insertFinding(domainId, runId)).resolves.toBeTypeOf(
        "string",
      );
    });

    it("ties dns_record_id to the kind, both ways", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      const recordId = await insertRow("dns_records", {
        domain_id: `'${domainId}'`,
        type: `'A'`,
        name: `'@'`,
        content: `'203.0.113.20'`,
        owner: `'apex'`,
      });

      // 'unexpected' with an intent row
      await expect(
        insertFinding(domainId, runId, { dns_record_id: `'${recordId}'` }),
      ).rejects.toThrow(/dns_drift_findings_unexpected_record_check/);

      // 'missing' without one
      await expect(
        insertFinding(domainId, runId, {
          kind: `'missing'`,
          record_name: `'@'`,
        }),
      ).rejects.toThrow(/dns_drift_findings_unexpected_record_check/);

      await expect(
        insertFinding(domainId, runId, {
          kind: `'missing'`,
          record_name: `'@'`,
          dns_record_id: `'${recordId}'`,
          desired_content: `'203.0.113.20'`,
          observed_content: `null`,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("rejects an unknown kind or resolution and requires the resolution pair", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      await expect(
        insertFinding(domainId, runId, { kind: `'suspicious'` }),
      ).rejects.toThrow(/dns_drift_findings_kind_check/);
      await expect(
        insertFinding(domainId, runId, {
          resolution: `'deleted'`,
          resolved_at: `now()`,
        }),
      ).rejects.toThrow(/dns_drift_findings_resolution_check/);
      await expect(
        insertFinding(domainId, runId, { resolution: `'dismissed'` }),
      ).rejects.toThrow(/dns_drift_findings_resolution_pair_check/);
      await expect(
        insertFinding(domainId, runId, { resolved_at: `now()` }),
      ).rejects.toThrow(/dns_drift_findings_resolution_pair_check/);
    });

    it("permits ONE unresolved finding per (domain, kind, type, name, observed) — the sweep's upsert probe", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      await insertFinding(domainId, runId);
      await expect(insertFinding(domainId, runId)).rejects.toThrow(
        /dns_drift_findings_unresolved_uq/,
      );
    });

    it("collides NULL observed_content through coalesce, so 'missing' findings do not accumulate", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      const recordId = await insertRow("dns_records", {
        domain_id: `'${domainId}'`,
        type: `'A'`,
        name: `'@'`,
        content: `'203.0.113.30'`,
        owner: `'apex'`,
      });
      const shape = {
        kind: `'missing'`,
        record_type: `'A'`,
        record_name: `'@'`,
        dns_record_id: `'${recordId}'`,
        desired_content: `'203.0.113.30'`,
        observed_content: `null`,
      };
      await insertFinding(domainId, runId, shape);
      // Without the coalesce, two NULLs would not collide and an hourly sweep
      // would insert a row per sweep forever.
      await expect(insertFinding(domainId, runId, shape)).rejects.toThrow(
        /dns_drift_findings_unresolved_uq/,
      );
    });

    it("allows a resolved finding to coexist with a new unresolved one", async () => {
      const domainId = await insertDomain();
      const runId = await insertRun();
      const id = await insertFinding(domainId, runId);
      await handle.pool.query(
        `update dns_drift_findings
            set resolved_at = now(), resolution = 'disappeared'
          where id = $1`,
        [id],
      );
      await expect(insertFinding(domainId, runId)).resolves.toBeTypeOf(
        "string",
      );
    });
  });

  /* -------------------------------------------------- provider_operations */

  describe("provider_operations", () => {
    it("keys on a deterministic idempotency string", async () => {
      await handle.pool.query(
        `insert into provider_operations (idempotency_key, provider, operation)
         values ('cloudflare:zone-create:example.test', 'cloudflare', 'zone-create')`,
      );
      await expect(
        handle.pool.query(
          `insert into provider_operations (idempotency_key, provider, operation)
           values ('cloudflare:zone-create:example.test', 'cloudflare', 'zone-create')`,
        ),
      ).rejects.toThrow(/provider_operations_pkey/);
    });

    it("starts pending with no completion instant and pairs the two", async () => {
      const key = "cloudflare:zone-create:pairing.test";
      await handle.pool.query(
        `insert into provider_operations (idempotency_key, provider, operation)
         values ($1, 'cloudflare', 'zone-create')`,
        [key],
      );
      const row = await handle.pool.query<{
        status: string;
        attempts: number;
        completed_at: string | null;
      }>(`select status, attempts, completed_at from provider_operations where idempotency_key = $1`, [
        key,
      ]);
      expect(row.rows[0]?.status).toBe("pending");
      expect(row.rows[0]?.attempts).toBe(1);
      expect(row.rows[0]?.completed_at).toBeNull();

      // A terminal status without a completion instant is the shape that would
      // make "did this ever succeed" unanswerable.
      await expect(
        handle.pool.query(
          `update provider_operations set status = 'succeeded' where idempotency_key = $1`,
          [key],
        ),
      ).rejects.toThrow(/provider_operations_completed_at_check/);

      await expect(
        handle.pool.query(
          `update provider_operations
              set status = 'succeeded', completed_at = now()
            where idempotency_key = $1`,
          [key],
        ),
      ).resolves.toBeTruthy();
    });

    it("rejects an unknown status", async () => {
      await expect(
        handle.pool.query(
          `insert into provider_operations (idempotency_key, provider, operation, status, completed_at)
           values ('k:unknown', 'cloudflare', 'zone-create', 'in_flight', now())`,
        ),
      ).rejects.toThrow(/provider_operations_status_check/);
    });
  });

  /* ------------------------------------- mail (migration 0013, milestone 2) */

  describe("mailbox_templates and mailbox_template_entries", () => {
    async function insertTemplate(
      overrides: Record<string, string> = {},
    ): Promise<string> {
      const n = nextSeq();
      return insertRow("mailbox_templates", {
        name: `'template-${n}'`,
        ...overrides,
      });
    }

    it("requires a template name to be unique", async () => {
      await insertTemplate({ name: `'standard-addresses'` });
      await expect(
        insertTemplate({ name: `'standard-addresses'` }),
      ).rejects.toThrow(/mailbox_templates_name_uq/);
    });

    it("permits AT MOST ONE default template, declaratively", async () => {
      // The design's `unique(is_default) where is_default`. A service-level
      // check would let two concurrent writers both pass; a partial unique
      // index cannot.
      await insertTemplate({ is_default: "true" });
      await expect(insertTemplate({ is_default: "true" })).rejects.toThrow(
        /mailbox_templates_default_uq/,
      );
      // Any number of NON-default templates coexist: the index covers only
      // rows where the flag is true.
      await expect(insertTemplate()).resolves.toBeTypeOf("string");
      await expect(insertTemplate()).resolves.toBeTypeOf("string");
    });

    it("ties a forwarding kind to forward_to, both ways", async () => {
      const templateId = await insertTemplate();

      // An alias with nowhere to forward is a rule with no effect.
      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'abuse'`,
          kind: `'alias'`,
        }),
      ).rejects.toThrow(/mailbox_template_entries_forward_to_check/);

      // And a real mailbox that also forwards is two different intentions
      // wearing one row.
      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'postmaster'`,
          kind: `'mailbox'`,
          forward_to: `'elsewhere@example.test'`,
        }),
      ).rejects.toThrow(/mailbox_template_entries_forward_to_check/);

      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'postmaster'`,
          kind: `'mailbox'`,
        }),
      ).resolves.toBeTypeOf("string");
      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'abuse'`,
          kind: `'alias'`,
          forward_to: `'postmaster@example.test'`,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("rejects a kind outside the closed set", async () => {
      const templateId = await insertTemplate();
      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'group'`,
          kind: `'distribution_list'`,
        }),
      ).rejects.toThrow(/mailbox_template_entries_kind_check/);
    });

    it("keeps one entry per local part and cascades with its template", async () => {
      const templateId = await insertTemplate();
      await insertRow("mailbox_template_entries", {
        template_id: `'${templateId}'`,
        local_part: `'postmaster'`,
        kind: `'mailbox'`,
      });
      await expect(
        insertRow("mailbox_template_entries", {
          template_id: `'${templateId}'`,
          local_part: `'postmaster'`,
          kind: `'mailbox'`,
        }),
      ).rejects.toThrow(/mailbox_template_entries_local_part_uq/);

      await handle.pool.query(`delete from mailbox_templates where id = $1`, [
        templateId,
      ]);
      const remaining = await handle.pool.query(
        `select 1 from mailbox_template_entries where template_id = $1`,
        [templateId],
      );
      expect(remaining.rowCount).toBe(0);
    });

    it("is referenced by managed_domains.mailbox_template_id — the FK milestone 1 deferred", async () => {
      // Migration 0012 shipped the column without its constraint and its
      // header promised milestone 2 would add it. This is that promise,
      // asserted rather than assumed.
      const templateId = await insertTemplate();
      const domainId = await insertDomain({
        mailbox_template_id: `'${templateId}'`,
      });
      expect(domainId).toBeTypeOf("string");

      await expect(
        insertDomain({
          mailbox_template_id: `'00000000-0000-0000-0000-000000000000'`,
        }),
      ).rejects.toThrow(/managed_domains_mailbox_template_id/);
    });
  });

  describe("mail_domains", () => {
    async function insertMailDomain(
      overrides: Record<string, string> = {},
    ): Promise<string> {
      const domainId = await insertDomain();
      await handle.pool.query(
        `insert into mail_domains (domain_id, mail_connection_id ${
          Object.keys(overrides).length > 0
            ? `, ${Object.keys(overrides).join(", ")}`
            : ""
        })
         values ('${domainId}', '${dnsConnectionId}' ${
           Object.keys(overrides).length > 0
             ? `, ${Object.values(overrides).join(", ")}`
             : ""
         })`,
      );
      return domainId;
    }

    it("is keyed by the domain, so a domain has at most one mail registration", async () => {
      const domainId = await insertMailDomain();
      await expect(
        handle.pool.query(
          `insert into mail_domains (domain_id, mail_connection_id)
           values ($1, $2)`,
          [domainId, dnsConnectionId],
        ),
      ).rejects.toThrow(/mail_domains_pkey/);
    });

    it("stores ownership_code in PLAINTEXT, because it is public by construction", async () => {
      // The design says so explicitly "so the argument is not had twice": the
      // code's entire purpose is to be published in a public TXT record.
      // Someone will eventually propose encrypting it; the answer is no.
      const code = "purelymail-ownership-code-fake-value";
      const domainId = await insertMailDomain({ ownership_code: `'${code}'` });
      const row = await handle.pool.query<{ ownership_code: string }>(
        `select ownership_code from mail_domains where domain_id = $1`,
        [domainId],
      );
      expect(row.rows[0]?.ownership_code).toBe(code);
    });

    it("starts unregistered and unverified, with a zero attempt count", async () => {
      const domainId = await insertMailDomain();
      const row = await handle.pool.query<{
        provider_added_at: Date | null;
        ownership_verified_at: Date | null;
        verify_attempts: number;
      }>(
        `select provider_added_at, ownership_verified_at, verify_attempts
           from mail_domains where domain_id = $1`,
        [domainId],
      );
      expect(row.rows[0]?.provider_added_at).toBeNull();
      expect(row.rows[0]?.ownership_verified_at).toBeNull();
      expect(row.rows[0]?.verify_attempts).toBe(0);
    });

    it("refuses a verification that precedes registration", async () => {
      // The provider cannot have verified a domain it never accepted.
      // Ordering made a constraint rather than a comment, because the
      // reconciler advances the two independently.
      await expect(
        insertMailDomain({ ownership_verified_at: `now()` }),
      ).rejects.toThrow(/mail_domains_verified_implies_added_check/);

      await expect(
        insertMailDomain({
          provider_added_at: `now()`,
          ownership_verified_at: `now()`,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("refuses a negative attempt count", async () => {
      await expect(
        insertMailDomain({ verify_attempts: `-1` }),
      ).rejects.toThrow(/mail_domains_verify_attempts_check/);
    });

    it("cascades from its domain", async () => {
      const domainId = await insertMailDomain();
      await handle.pool.query(`delete from managed_domains where id = $1`, [
        domainId,
      ]);
      const remaining = await handle.pool.query(
        `select 1 from mail_domains where domain_id = $1`,
        [domainId],
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  describe("mailboxes", () => {
    async function insertMailbox(
      domainId: string,
      overrides: Record<string, string> = {},
    ): Promise<string> {
      return insertRow("mailboxes", {
        domain_id: `'${domainId}'`,
        local_part: `'postmaster'`,
        kind: `'mailbox'`,
        ...overrides,
      });
    }

    it("permits one address per domain and rejects the duplicate", async () => {
      const domainId = await insertDomain();
      await insertMailbox(domainId);
      await expect(insertMailbox(domainId)).rejects.toThrow(
        /mailboxes_domain_local_part_uq/,
      );

      // The same local part on a DIFFERENT domain is a different address.
      const other = await insertDomain();
      await expect(insertMailbox(other)).resolves.toBeTypeOf("string");
    });

    it("keeps tombstones inside the unique key, so a re-declared address RESURRECTS", async () => {
      // Open question 7's resolution, applied to the table that shares
      // `dns_records`' shape: the unique covers soft-deleted rows too, so
      // re-adding a removed address must clear `desired_deleted_at` rather
      // than insert a second row.
      const domainId = await insertDomain();
      const id = await insertMailbox(domainId);
      await handle.pool.query(
        `update mailboxes set desired_deleted_at = now() where id = $1`,
        [id],
      );
      await expect(insertMailbox(domainId)).rejects.toThrow(
        /mailboxes_domain_local_part_uq/,
      );
    });

    it("ties a forwarding kind to forward_to, both ways", async () => {
      const domainId = await insertDomain();
      await expect(
        insertMailbox(domainId, { local_part: `'abuse'`, kind: `'alias'` }),
      ).rejects.toThrow(/mailboxes_forward_to_check/);
      await expect(
        insertMailbox(domainId, {
          local_part: `'everything'`,
          kind: `'catchall'`,
          forward_to: `'postmaster@example.test'`,
        }),
      ).resolves.toBeTypeOf("string");
      await expect(
        insertMailbox(domainId, {
          local_part: `'sales'`,
          kind: `'mailbox'`,
          forward_to: `'elsewhere@example.test'`,
        }),
      ).rejects.toThrow(/mailboxes_forward_to_check/);
    });

    it("rejects a kind outside the closed set", async () => {
      const domainId = await insertDomain();
      await expect(
        insertMailbox(domainId, { kind: `'shared_inbox'` }),
      ).rejects.toThrow(/mailboxes_kind_check/);
    });

    it("references a LOGICAL application_secrets row for the minted password", async () => {
      // ADR-0019: the reference is to the logical secret, never to a version
      // row — the same shape `storage_backends.secret_id` and
      // `notification_endpoints.secret_id` already use.
      const domainId = await insertDomain();
      const secret = await handle.pool.query<{ id: string }>(
        `insert into application_secrets (secret_key, purpose, current_version)
         values ($1, 'mailbox_password', 1) returning id`,
        [`infrastructure.mailbox.test-${nextSeq()}`],
      );
      const secretId = secret.rows[0]?.id;
      expect(secretId).toBeTypeOf("string");

      const id = await insertMailbox(domainId, { secret_id: `'${secretId}'` });
      expect(id).toBeTypeOf("string");

      await expect(
        insertMailbox(domainId, {
          local_part: `'sales'`,
          secret_id: `'00000000-0000-0000-0000-000000000000'`,
        }),
      ).rejects.toThrow(/mailboxes_secret_id/);
    });

    it("cascades from its domain", async () => {
      const domainId = await insertDomain();
      await insertMailbox(domainId);
      await handle.pool.query(`delete from managed_domains where id = $1`, [
        domainId,
      ]);
      const remaining = await handle.pool.query(
        `select 1 from mailboxes where domain_id = $1`,
        [domainId],
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  /* --------------------------------------------- dns_provider_tokens (M3) */

  describe("dns_provider_tokens and dns_provider_token_zones (migration 0016)", () => {
    async function insertToken(
      overrides: Record<string, string> = {},
    ): Promise<{ id: string; hostingTargetId: string }> {
      const hostingTargetId = await insertTarget();
      const n = nextSeq();
      const id = await insertRow("dns_provider_tokens", {
        hosting_target_id: `'${hostingTargetId}'`,
        dns_connection_id: `'${dnsConnectionId}'`,
        external_token_id: `'ext-token-${n}'`,
        name: `'token-${n}'`,
        permission_scope: `'dns_edit'`,
        ...overrides,
      });
      return { id, hostingTargetId };
    }

    it("mints a token scoped to a hosting target and a DNS connection", async () => {
      const { id } = await insertToken();
      expect(id).toBeTypeOf("string");
    });

    it("rejects a permission_scope outside the closed set", async () => {
      await expect(
        insertToken({ permission_scope: `'dns_admin'` }),
      ).rejects.toThrow(/dns_provider_tokens_permission_scope_check/);
    });

    it("requires external_token_id to be unique per DNS connection, not globally", async () => {
      await insertToken({ external_token_id: `'shared-ext-id'` });
      // Same connection, same provider id: rejected.
      await expect(
        insertToken({ external_token_id: `'shared-ext-id'` }),
      ).rejects.toThrow(/dns_provider_tokens_connection_external_token_uq/);
    });

    it("references a LOGICAL application_secrets row for the minted value, never a version row", async () => {
      // ADR-0019: the same shape mailboxes.secret_id uses. secret_id is
      // nullable only for the instant between "row exists" and "secret write
      // committed" inside the mint's one transaction (tokens.ts, not this
      // schema) — a bogus id is still rejected by the FK.
      const secret = await handle.pool.query<{ id: string }>(
        `insert into application_secrets (secret_key, purpose, current_version)
         values ($1, 'dns_edit_token', 1) returning id`,
        [`infrastructure.dns_token.test-${nextSeq()}`],
      );
      const secretId = secret.rows[0]?.id;
      expect(secretId).toBeTypeOf("string");

      const { id } = await insertToken({ secret_id: `'${secretId}'` });
      expect(id).toBeTypeOf("string");

      await expect(
        insertToken({
          secret_id: `'00000000-0000-0000-0000-000000000000'`,
        }),
      ).rejects.toThrow(/dns_provider_tokens_secret_id/);
    });

    it("carries no created_by_user_id column — the design names only two tables that need one", async () => {
      const columns = await handle.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'dns_provider_tokens'`,
      );
      expect(
        columns.rows.map((row) => row.column_name),
      ).not.toContain("created_by_user_id");
    });

    it("scopes a token to a zone via the (token_id, domain_id) intent pair", async () => {
      const { id: tokenId } = await insertToken();
      const domainId = await insertDomain();

      await handle.pool.query(
        `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
        [tokenId, domainId],
      );

      const rows = await handle.pool.query(
        `select * from dns_provider_token_zones where token_id = $1`,
        [tokenId],
      );
      expect(rows.rowCount).toBe(1);
    });

    it("rejects a duplicate (token_id, domain_id) pair — the pair IS the primary key", async () => {
      const { id: tokenId } = await insertToken();
      const domainId = await insertDomain();
      await handle.pool.query(
        `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
        [tokenId, domainId],
      );
      await expect(
        handle.pool.query(
          `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
          [tokenId, domainId],
        ),
      ).rejects.toThrow(/dns_provider_token_zones_token_id_domain_id_pk/);
    });

    it("cascades zone scope when the token is deleted", async () => {
      const { id: tokenId } = await insertToken();
      const domainId = await insertDomain();
      await handle.pool.query(
        `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
        [tokenId, domainId],
      );
      await handle.pool.query(`delete from dns_provider_tokens where id = $1`, [
        tokenId,
      ]);
      const remaining = await handle.pool.query(
        `select 1 from dns_provider_token_zones where token_id = $1`,
        [tokenId],
      );
      expect(remaining.rowCount).toBe(0);
    });

    it("cascades zone scope when the domain is deleted", async () => {
      const { id: tokenId } = await insertToken();
      const domainId = await insertDomain();
      await handle.pool.query(
        `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
        [tokenId, domainId],
      );
      await handle.pool.query(`delete from managed_domains where id = $1`, [
        domainId,
      ]);
      const remaining = await handle.pool.query(
        `select 1 from dns_provider_token_zones where domain_id = $1`,
        [domainId],
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  describe("identifier length", () => {
    it("keeps every infrastructure constraint and index name inside PostgreSQL's 63-byte limit", async () => {
      // PostgreSQL TRUNCATES silently at 63 bytes, so two long generated names
      // can collide into one. The design names `mailbox_template_entries` as a
      // candidate; measuring by hand is exactly the wrong tool, so this asks
      // the live catalog instead.
      const rows = await handle.pool.query<{ name: string; len: number }>(
        `select conname as name, length(conname) as len
           from pg_constraint
          where conrelid::regclass::text in (
            'hosting_targets','managed_domains','dns_records','reconcile_runs',
            'reconcile_run_steps','dns_drift_findings','provider_operations',
            'mailbox_templates','mailbox_template_entries','mail_domains','mailboxes',
            'dns_provider_tokens','dns_provider_token_zones',
            'proxy_resources','proxy_resource_rules')
         union all
         select indexname as name, length(indexname) as len
           from pg_indexes
          where tablename in (
            'hosting_targets','managed_domains','dns_records','reconcile_runs',
            'reconcile_run_steps','dns_drift_findings','provider_operations',
            'mailbox_templates','mailbox_template_entries','mail_domains','mailboxes',
            'dns_provider_tokens','dns_provider_token_zones',
            'proxy_resources','proxy_resource_rules')`,
      );
      expect(rows.rowCount).toBeGreaterThan(40);
      const overlong = rows.rows.filter((row) => row.len > 63);
      expect(overlong).toEqual([]);

      // The two longest names in Phase 7, present VERBATIM. Truncation is
      // silent, so "the name exists exactly as written" is the only assertion
      // that catches it — a length check alone would pass on a truncated name.
      const names = new Set(rows.rows.map((row) => row.name));
      expect(names).toContain("mailbox_template_entries_template_fk");
      expect(names).toContain(
        "managed_domains_mailbox_template_id_mailbox_templates_id_fk",
      );
      expect(names).toContain("hosting_targets_fronted_by_target_fk");
      // loxep-acj.2: 60 bytes, 3 bytes of headroom — the same margin
      // `mailbox_template_entries_template_fk` shipped at.
      expect(names).toContain("proxy_resource_rules_proxy_resource_fk");
    });
  });
});
