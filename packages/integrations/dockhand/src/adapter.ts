/**
 * The Dockhand adapter (ADR-0009, loxep-9j6): a **read surface** over container
 * and stack state, plus a **host-registration intent surface** that is the one
 * carve-out from rule 13 the owner granted.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so a consumer re-declares the
 * shapes it needs structurally and takes no dependency here — the discipline
 * `@loxep/commerce` applies to the eBay fact types and `@loxep/infrastructure`
 * applies to Cloudflare's.
 *
 * ## Two surfaces, and the line between them
 *
 * ```text
 * READ            listHosts, listContainers, listStacks
 *                 Dockhand's view of a fleet, projected to one row per subject.
 *
 * HOST INTENT     readHosts, applyHost
 *                 Desired state for Dockhand's OWN INVENTORY of managed hosts —
 *                 what Dockhand calls an "environment". Phase 7's read/apply
 *                 shape, so `@loxep/infrastructure` can drive it with the same
 *                 reconciler that drives DNS and mail.
 *
 * FORBIDDEN       everything else, permanently and testably.
 * ```
 *
 * The fleet-observability design put Dockhand at *"tier 1, and no adapter"*, on
 * the grounds that *"its verbs are the forbidden ones"* and that an adapter
 * refusing them *"is a worse Dockhand embedded in Loxep"*. The owner amended
 * that on 2026-08-13 in two parts, and both are honoured here:
 *
 * 1. the read half ships after all, because a fleet panel that shows which
 *    stacks are running is worth having even when the buttons live elsewhere;
 * 2. **host registration is not a forbidden verb.** *"Adding a new VPS could be
 *    pretty simple when it's all here"* — and adding one to Dockhand writes a
 *    row in Dockhand's environment table. Nothing executes on the new machine.
 *    Container lifecycle verbs stay forbidden without exception.
 *
 * The distinction is drawn on the resource, not the HTTP method, and
 * `operations.ts` explains why that is the only test that works. Everything
 * that acts on a Docker daemon is absent from this file; everything that edits
 * Dockhand's inventory of hosts is present.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://finsys-dockhand.mintlify.app/api/overview as the
 * primary source, ruling that the repository's no-AI-ingestion wish *"covers
 * source, not published docs"*. **No Dockhand source was read.** Every path,
 * field, and default here is transcribed from the documentation site's API
 * reference pages. Three consequences:
 *
 * - **Session-cookie authentication only.** `POST /api/auth/login`, then
 *   `Cookie: session=…` on every request; upstream also notes authentication is
 *   optional and that when disabled *"the API is fully accessible without
 *   credentials"*, which `probeSession()` detects so an operator is told which
 *   mode their instance is in rather than discovering it from a 403.
 * - **No OpenAPI, an unversioned `/api`, and an additive-compatibility promise
 *   instead of a version.** Every response field is read optionally; only an
 *   identifier is required.
 * - **The documentation contradicts itself on list envelopes** — the overview
 *   says list endpoints *"return arrays directly without wrapping"* while the
 *   containers page documents a wrapping `containers` field. Both are accepted.
 *   See `errors.ts`.
 *
 * Field names are **UNVERIFIED against a running instance**;
 * `test/live-dockhand.test.ts` skips cleanly until
 * `~/.config/loxep/dockhand.env` exists and is the standing job to confirm them.
 */
import { z } from "zod";
import {
  DOCKHAND_ALLOWED_NON_GET_PREFIXES,
  DOCKHAND_CONNECTION_TYPES,
  DOCKHAND_CONTAINERS_PATH,
  DOCKHAND_ENVIRONMENTS_PATH,
  DOCKHAND_LOGIN_PATH,
  DOCKHAND_MAX_LABELS,
  DOCKHAND_SESSION_PATH,
  DOCKHAND_STACKS_PATH,
  type DockhandConnectionType,
  dockhandEnvironmentPath,
} from "./operations.ts";
import {
  DockhandAdapterError,
  dockhandErrorFromResponse,
  normalizeDockhandError,
  readDockhandErrorEnvelope,
} from "./errors.ts";
import {
  type DockhandAdapterConfig,
  type DockhandAdapterConfigInput,
  parseDockhandAdapterConfig,
} from "./config.ts";
import {
  DOCKHAND_LOGIN_COST,
  DOCKHAND_SUGGESTED_CAPACITY,
  DOCKHAND_SUGGESTED_REFILL_PER_SECOND,
  type DockhandAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type DockhandFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * One managed Docker host, as Dockhand holds it. Dockhand's own name for this
 * is an "environment"; Loxep's fleet vocabulary says host.
 *
 * TLS material is **deliberately absent**. `tlsCa`, `tlsCert`, and `tlsKey` are
 * documented response fields, and `tlsKey` is a private key: reading one into a
 * Loxep fact would put it in memory, in a diff, and eventually in a run-step
 * summary, in exchange for nothing — the reconciler compares TLS material by
 * PRESENCE, never by value. {@link DockhandHostFact.tlsConfigured} is that
 * presence bit.
 */
export interface DockhandHostFact {
  externalHostId: string;
  name: string;
  connectionType: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
  socketPath: string | null;
  /** Whether upstream holds any TLS material. Never the material itself. */
  tlsConfigured: boolean;
  tlsSkipVerify: boolean | null;
  labels: string[];
  publicIp: string | null;
  /** Whether a Hawser agent token is configured. Never the token. */
  hawserConfigured: boolean;
  /** Last contact from the Hawser agent, when upstream reports one. */
  hawserLastSeen: string | null;
  updatedAt: string | null;
}

/** One container, reduced to the fields a fleet panel renders. */
export interface DockhandContainerFact {
  externalContainerId: string;
  externalHostId: string;
  name: string | null;
  image: string | null;
  /** Docker's own string, verbatim (`running`, `exited`, …). */
  state: string;
  /** Docker's human status line, verbatim (`Up 3 days`). */
  status: string | null;
}

/**
 * One Compose stack. `status` is documented as a closed set —
 * `running | stopped | partial | created` — but is carried verbatim anyway,
 * because an unversioned API with an additive-compatibility promise may add a
 * fifth value and a Loxep union would turn that into a parse failure.
 */
export interface DockhandStackFact {
  name: string;
  externalHostId: string;
  status: string;
  /** `internal`, `git`, or `external`. Verbatim, for the same reason. */
  sourceType: string | null;
  containerCount: number;
  /** How many of this stack's containers Dockhand reports as running. */
  runningContainerCount: number;
}

/**
 * Desired state for one managed host — the payload the reconciler applies.
 *
 * Mirrors `DnsRecordPayload` in `@loxep/infrastructure`: a Loxep-owned intent
 * shape, not a provider request body. `tlsKey`/`tlsCert`/`tlsCa` and
 * `hawserToken` are **write-only** here — they can be sent and never read back,
 * which is exactly the asymmetry `DockhandHostFact` encodes with presence bits.
 */
export interface DockhandHostPayload {
  name: string;
  connectionType: DockhandConnectionType;
  host?: string | null;
  port?: number | null;
  protocol?: string | null;
  socketPath?: string | null;
  tlsSkipVerify?: boolean | null;
  labels?: string[];
  publicIp?: string | null;
  /** Write-only. Never read back into a fact. */
  tlsCa?: string;
  /** Write-only. Never read back into a fact. */
  tlsCert?: string;
  /** Write-only. Never read back into a fact. */
  tlsKey?: string;
  /** Write-only. Never read back into a fact. */
  hawserToken?: string;
}

/**
 * The one mutating operation this adapter performs, and the shape that makes it
 * reviewable: a create or an update of Dockhand's host inventory, never
 * anything else.
 *
 * There is deliberately **no `delete` member**. Removing a host from Dockhand
 * is not a Loxep decision — an operator who decommissions a machine says so in
 * `hosting_targets`, and Loxep's answer is to stop reconciling it, not to
 * delete somebody else's inventory row. Adding a delete later would need its
 * own owner ruling; leaving the union open-ended would have invited one by
 * accident.
 */
export type DockhandHostOperation =
  | { kind: "create"; host: DockhandHostPayload }
  | {
      kind: "update";
      externalHostId: string;
      host: Partial<DockhandHostPayload> & { name?: string };
    };

export interface DockhandHostApplyResult {
  kind: DockhandHostOperation["kind"];
  name: string;
  status: "applied";
  externalHostId: string;
}

/** What Dockhand's session endpoint says about how this instance is secured. */
export interface DockhandSessionFact {
  /** `false` when upstream reports authentication disabled entirely. */
  authenticationEnabled: boolean;
  /** Whether the adapter currently holds a session Dockhand accepts. */
  authenticated: boolean;
}

export interface DockhandCapabilities {
  provider: "dockhand";
  /** Reads, plus host inventory. Structural: no other write member exists. */
  hostRegistration: true;
  /** Rule 13, permanently. No exported member starts, stops, or execs. */
  containerLifecycle: false;
  /** Loxep reads current state only; Dockhand keeps the history. */
  metricHistory: false;
  /** Session cookie is the only documented machine credential. */
  bearerTokenAuth: false;
  // (see DOCKHAND_SESSION_COOKIE_NAME below for the cookie's observed name)
  connectionTypes: readonly DockhandConnectionType[];
}

/**
 * The name of the session cookie Dockhand actually sets, and the name this
 * adapter sends back.
 *
 * ## This was a transcribed guess until a live instance falsified it
 *
 * The original implementation looked for a cookie named plainly `session`,
 * transcribed from the same upstream reference as everything else in this
 * package — and the stub fixtures were written from that same reference, so
 * the whole suite passed while a real instance could never have authenticated.
 * That is the failure mode worth remembering here: a fixture written from the
 * document the implementation was written from validates the guess, not the
 * provider.
 *
 * OBSERVED 2026-08-14 against a real Dockhand instance: `POST /api/auth/login`
 * answers `200` with `Set-Cookie: dockhand_session=…` and a body of
 * `{ success, user }`. The old pattern could not match that name — in
 * `dockhand_session=`, the substring `session=` is preceded by `dockhand_`
 * rather than by a start-of-string or `; ` — so every live login failed with
 * "login succeeded but set no session cookie" despite the credential being
 * accepted.
 *
 * The name lives here, in exactly one place, because it is now a fact about a
 * provider rather than an assumption, and because sending the wrong cookie
 * name is a silent authentication failure rather than a loud one.
 */
export const DOCKHAND_SESSION_COOKIE_NAME = "dockhand_session";

/**
 * Matches {@link DOCKHAND_SESSION_COOKIE_NAME} at a cookie boundary — start of
 * string or after `; ` — so a differently-prefixed cookie that merely ENDS in
 * the same characters cannot be mistaken for the session.
 */
const DOCKHAND_SESSION_COOKIE_PATTERN = new RegExp(
  `(?:^|;\\s*)${DOCKHAND_SESSION_COOKIE_NAME}=([^;]+)`,
);

export interface DockhandAdapterStats {
  rateBudget: RateBudgetStats;
  /** Login exchanges performed since creation. Should stay very small. */
  authExchanges: number;
  /** Requests retried once after a mid-run session expiry. */
  reauthRetries: number;
}

export interface DockhandAdapter {
  /** Unauthenticated-safe: reports whether this instance requires a login. */
  probeSession(): Promise<DockhandSessionFact>;
  /** READ — Dockhand's inventory of managed hosts. */
  listHosts(): Promise<DockhandHostFact[]>;
  /** READ — containers in one managed host. */
  listContainers(input: {
    externalHostId: string;
    includeStopped?: boolean;
  }): Promise<DockhandContainerFact[]>;
  /** READ — Compose stacks in one managed host. */
  listStacks(input: { externalHostId: string }): Promise<DockhandStackFact[]>;
  /** HOST INTENT — the reconciler's read half. Alias of {@link listHosts}. */
  readHosts(): Promise<DockhandHostFact[]>;
  /** HOST INTENT — the reconciler's apply half. The only write. */
  applyHost(
    operation: DockhandHostOperation,
  ): Promise<DockhandHostApplyResult>;
  capabilities(): DockhandCapabilities;
  stats(): DockhandAdapterStats;
}

export interface CreateDockhandAdapterInput {
  config: DockhandAdapterConfigInput;
  credentials: { username: string; password: string };
  fetchImpl: DockhandFetch;
  logger?: DockhandAdapterLogger;
  rateBudget?: RateBudget;
}

/**
 * One environment record. Only `id` and `name` are required — everything else
 * is optional against an unversioned API with no specification.
 *
 * `z.object` STRIPS unknown keys, which is the boundary behaviour ADR-0009
 * wants: an upstream addition is dropped here rather than propagating into a
 * Loxep fact by accident. In particular, `tlsKey` is not in this schema at all,
 * so a private key cannot survive parsing even if upstream sends one.
 */
const environmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  connectionType: z.string().optional(),
  host: z.string().nullable().optional(),
  port: z.union([z.string(), z.number()]).nullable().optional(),
  protocol: z.string().nullable().optional(),
  socketPath: z.string().nullable().optional(),
  tlsSkipVerify: z.boolean().nullable().optional(),
  labels: z.array(z.string()).nullable().optional(),
  publicIp: z.string().nullable().optional(),
  hawserLastSeen: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

/**
 * Presence bits are read from the RAW record rather than the parsed one,
 * precisely because the parsed one has already discarded the sensitive fields.
 */
function hasNonEmpty(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === "string" ? value.length > 0 : value != null;
}

const containerSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});

const stackContainerSchema = z.object({
  state: z.string().nullable().optional(),
});

const stackSchema = z.object({
  name: z.string().min(1),
  status: z.string().nullable().optional(),
  sourceType: z.string().nullable().optional(),
  containers: z.array(z.unknown()).nullable().optional(),
  containerDetails: z.array(z.unknown()).nullable().optional(),
});

const sessionSchema = z.object({
  authEnabled: z.boolean().optional(),
  authenticated: z.boolean().optional(),
  user: z.unknown().optional(),
});

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Accept BOTH documented list shapes: a bare array, and an object wrapping one
 * under a named key. See `errors.ts` for why the documentation supports both.
 */
function unwrapList(body: unknown, key: string): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const wrapped = (body as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return wrapped;
  }
  return null;
}

export function createDockhandAdapter(
  input: CreateDockhandAdapterInput,
): DockhandAdapter {
  const config: DockhandAdapterConfig = parseDockhandAdapterConfig(input.config);
  const { fetchImpl, logger } = input;
  const username = input.credentials.username;
  const password = input.credentials.password;
  if (username === "" || password === "") {
    throw new DockhandAdapterError(
      "invalid_request",
      "Dockhand credentials require both a username and a password",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: DOCKHAND_SUGGESTED_CAPACITY,
      refillPerSecond: DOCKHAND_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  /**
   * The session cookie value. In memory only, for the life of this adapter
   * instance. Upstream expires it after seven days by default; persisting it
   * would be a second credential to protect in exchange for saving one request.
   */
  let sessionCookie: string | null = null;
  let authExchanges = 0;
  let reauthRetries = 0;

  const request = async (
    path: string,
    init: {
      method: "GET" | "POST" | "PUT";
      query?: Record<string, string>;
      body?: unknown;
      cookie?: string | null;
      cost?: number;
    },
    operation: string,
  ): Promise<unknown> => {
    const context = { operation, path };

    if (init.method !== "GET") {
      const allowed = DOCKHAND_ALLOWED_NON_GET_PREFIXES.some((prefix) =>
        path === prefix || path.startsWith(`${prefix}/`),
      );
      if (!allowed) {
        // Unreachable through the exported surface. It exists so a future edit
        // adding a lifecycle call fails HERE rather than at a Docker daemon.
        throw new DockhandAdapterError(
          "invalid_request",
          "Dockhand adapter refused a write outside login and host registration",
          { operation, path, method: init.method },
        );
      }
    }

    await rateBudget.acquire(init.cost ?? 1);

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.cookie != null)
      headers["cookie"] = `${DOCKHAND_SESSION_COOKIE_NAME}=${init.cookie}`;

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw normalizeDockhandError(error, context);
    }

    let parsed: unknown = null;
    let parseFailed = false;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (!response.ok || parseFailed) {
      throw dockhandErrorFromResponse(
        response.status,
        parseFailed
          ? { error: null, hasDetails: false }
          : readDockhandErrorEnvelope(parsed),
        context,
      );
    }

    // The login route answers with `Set-Cookie`; capture it there and only
    // there, so no other response can quietly replace the session.
    if (path === DOCKHAND_LOGIN_PATH) {
      const setCookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [response.headers.get("set-cookie") ?? ""];
      for (const raw of setCookies) {
        const match = DOCKHAND_SESSION_COOKIE_PATTERN.exec(raw);
        if (match?.[1] !== undefined) {
          sessionCookie = match[1];
          break;
        }
      }
    }

    return parsed;
  };

  const login = async (): Promise<string> => {
    await request(
      DOCKHAND_LOGIN_PATH,
      {
        method: "POST",
        body: { username, password },
        cost: DOCKHAND_LOGIN_COST,
      },
      "auth.login",
    );
    if (sessionCookie === null) {
      throw new DockhandAdapterError(
        "provider_unavailable",
        "Dockhand login succeeded but set no session cookie",
        { operation: "auth.login", path: DOCKHAND_LOGIN_PATH },
      );
    }
    authExchanges += 1;
    return sessionCookie;
  };

  /**
   * Run an authenticated call, logging in first if needed and **exactly once**
   * more if Dockhand rejects the cached session mid-run.
   *
   * Bounded to one retry, and here the bound is not merely tidy: upstream locks
   * an account out after five failed logins. A loop would convert a transient
   * rejection into a fleet-wide outage of Loxep's Dockhand reads.
   */
  const authenticated = async <T>(
    run: (cookie: string) => Promise<T>,
  ): Promise<T> => {
    const cookie = sessionCookie ?? (await login());
    try {
      return await run(cookie);
    } catch (error) {
      if (error instanceof DockhandAdapterError && error.kind === "auth") {
        sessionCookie = null;
        reauthRetries += 1;
        logger?.debug?.(
          { operation: "auth.retry" },
          "Dockhand rejected the cached session; re-authenticating once",
        );
        return await run(await login());
      }
      throw error;
    }
  };

  const toHostFact = (raw: unknown): DockhandHostFact | null => {
    const parsed = environmentSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    const record = (raw ?? {}) as Record<string, unknown>;
    return {
      externalHostId: String(value.id),
      name: value.name,
      connectionType: value.connectionType ?? "socket",
      host: value.host ?? null,
      port: toNumber(value.port),
      protocol: value.protocol ?? null,
      socketPath: value.socketPath ?? null,
      tlsConfigured:
        hasNonEmpty(record, "tlsCa") ||
        hasNonEmpty(record, "tlsCert") ||
        hasNonEmpty(record, "tlsKey"),
      tlsSkipVerify: value.tlsSkipVerify ?? null,
      labels: value.labels ?? [],
      publicIp: value.publicIp ?? null,
      hawserConfigured: hasNonEmpty(record, "hawserToken"),
      hawserLastSeen: value.hawserLastSeen ?? null,
      updatedAt: value.updatedAt ?? null,
    };
  };

  const listHosts = async (): Promise<DockhandHostFact[]> =>
    await authenticated(async (cookie) => {
      const body = await request(
        DOCKHAND_ENVIRONMENTS_PATH,
        { method: "GET", cookie },
        "hosts.list",
      );
      const items = unwrapList(body, "environments");
      if (items === null) {
        throw new DockhandAdapterError(
          "invalid_request",
          "Dockhand environments list was neither an array nor a wrapped array",
          { operation: "hosts.list", path: DOCKHAND_ENVIRONMENTS_PATH },
        );
      }
      const facts: DockhandHostFact[] = [];
      for (const item of items) {
        const fact = toHostFact(item);
        if (fact === null) {
          logger?.warn?.(
            { operation: "hosts.list" },
            "Dockhand returned an environment Loxep could not read; skipping it",
          );
          continue;
        }
        facts.push(fact);
      }
      return facts;
    });

  const validatePayload = (
    payload: Partial<DockhandHostPayload>,
    operation: string,
  ): void => {
    if (
      payload.connectionType !== undefined &&
      !DOCKHAND_CONNECTION_TYPES.includes(payload.connectionType)
    ) {
      throw new DockhandAdapterError(
        "invalid_request",
        "Dockhand connection type is not one upstream documents",
        { operation, connectionType: payload.connectionType },
      );
    }
    if (payload.labels !== undefined && payload.labels.length > DOCKHAND_MAX_LABELS) {
      // Caught locally rather than at the provider, so a reconcile run reports
      // the reason instead of an opaque 400.
      throw new DockhandAdapterError(
        "invalid_request",
        `Dockhand allows at most ${DOCKHAND_MAX_LABELS} labels on a host`,
        { operation, labelCount: payload.labels.length },
      );
    }
  };

  return {
    async probeSession() {
      // Upstream: "Always check if authentication is enabled via
      // /api/auth/session". Deliberately NOT wrapped in `authenticated` — its
      // whole job is to answer before a login is attempted.
      const body = await request(
        DOCKHAND_SESSION_PATH,
        { method: "GET", cookie: sessionCookie },
        "auth.session",
      );
      const parsed = sessionSchema.safeParse(body);
      if (!parsed.success) {
        return { authenticationEnabled: true, authenticated: false };
      }
      return {
        authenticationEnabled: parsed.data.authEnabled ?? true,
        authenticated:
          parsed.data.authenticated ?? parsed.data.user != null,
      };
    },

    listHosts,
    readHosts: listHosts,

    async listContainers({ externalHostId, includeStopped }) {
      return await authenticated(async (cookie) => {
        const body = await request(
          DOCKHAND_CONTAINERS_PATH,
          {
            method: "GET",
            cookie,
            query: {
              env: externalHostId,
              all: String(includeStopped ?? true),
            },
          },
          "containers.list",
        );
        const items = unwrapList(body, "containers");
        if (items === null) {
          throw new DockhandAdapterError(
            "invalid_request",
            "Dockhand containers list was neither an array nor a wrapped array",
            { operation: "containers.list", path: DOCKHAND_CONTAINERS_PATH },
          );
        }
        const facts: DockhandContainerFact[] = [];
        for (const item of items) {
          const parsed = containerSchema.safeParse(item);
          if (!parsed.success) continue;
          facts.push({
            externalContainerId: parsed.data.id,
            externalHostId,
            name: parsed.data.name ?? null,
            image: parsed.data.image ?? null,
            state: parsed.data.state ?? "",
            status: parsed.data.status ?? null,
          });
        }
        return facts;
      });
    },

    async listStacks({ externalHostId }) {
      return await authenticated(async (cookie) => {
        const body = await request(
          DOCKHAND_STACKS_PATH,
          { method: "GET", cookie, query: { env: externalHostId } },
          "stacks.list",
        );
        const items = unwrapList(body, "stacks");
        if (items === null) {
          throw new DockhandAdapterError(
            "invalid_request",
            "Dockhand stacks list was neither an array nor a wrapped array",
            { operation: "stacks.list", path: DOCKHAND_STACKS_PATH },
          );
        }
        const facts: DockhandStackFact[] = [];
        for (const item of items) {
          const parsed = stackSchema.safeParse(item);
          if (!parsed.success) continue;
          const details = parsed.data.containerDetails ?? [];
          const running = details.filter((detail) => {
            const d = stackContainerSchema.safeParse(detail);
            return d.success && d.data.state === "running";
          }).length;
          facts.push({
            name: parsed.data.name,
            externalHostId,
            status: parsed.data.status ?? "",
            sourceType: parsed.data.sourceType ?? null,
            containerCount:
              parsed.data.containers?.length ?? details.length,
            runningContainerCount: running,
          });
        }
        return facts;
      });
    },

    async applyHost(operation) {
      const label = `hosts.${operation.kind}`;
      validatePayload(operation.host, label);

      return await authenticated(async (cookie) => {
        if (operation.kind === "create") {
          const body = await request(
            DOCKHAND_ENVIRONMENTS_PATH,
            { method: "POST", cookie, body: operation.host },
            label,
          );
          const fact = toHostFact(body);
          if (fact === null) {
            throw new DockhandAdapterError(
              "provider_unavailable",
              "Dockhand created a host but returned no readable record",
              { operation: label, path: DOCKHAND_ENVIRONMENTS_PATH },
            );
          }
          return {
            kind: "create" as const,
            name: fact.name,
            status: "applied" as const,
            externalHostId: fact.externalHostId,
          };
        }

        const path = dockhandEnvironmentPath(operation.externalHostId);
        const body = await request(
          path,
          { method: "PUT", cookie, body: operation.host },
          label,
        );
        const fact = toHostFact(body);
        return {
          kind: "update" as const,
          name: fact?.name ?? operation.host.name ?? "",
          status: "applied" as const,
          externalHostId: fact?.externalHostId ?? operation.externalHostId,
        };
      });
    },

    capabilities() {
      return {
        provider: "dockhand",
        hostRegistration: true,
        containerLifecycle: false,
        metricHistory: false,
        bearerTokenAuth: false,
        connectionTypes: DOCKHAND_CONNECTION_TYPES,
      };
    },

    stats() {
      return { rateBudget: rateBudget.stats(), authExchanges, reauthRetries };
    },
  };
}
