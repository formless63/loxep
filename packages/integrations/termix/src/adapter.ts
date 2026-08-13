/**
 * The Termix read adapter (ADR-0009, loxep-g3f).
 *
 * Loxep reads **an inventory of a Termix instance's SSH hosts (with
 * best-effort connectivity), and its active terminal sessions** — plus a
 * whoami-equivalent identity probe. Nothing else: no terminal exec, no
 * Docker control, no systemd/process control, no file manager, no
 * credential/snippet/tunnel management.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://docs.termix.site/api/termix-api/ as the
 * primary source. Its live page is a JavaScript-rendered API-reference app
 * this environment could not fetch as text beyond navigation chrome; its
 * GENERATING SOURCE — `Termix-SSH/Docs`'s `static/openapi.json`, a full
 * OpenAPI 3.0.3 document regenerated 2026-08-06 — is what this package and
 * `operations.ts` are built from. Four findings shape this module:
 *
 * 1. **Reads exist and are reachable.** `GET /host/db/host` ("Retrieves all
 *    SSH hosts for the authenticated user"), `GET /status` ("Retrieves the
 *    status of all hosts for the authenticated user" — documented as *"A
 *    map of host IDs to their status entries"*, an object, not a list), and
 *    `GET /open-tabs/active-sessions` ("Returns live terminal sessions from
 *    the session manager, both sessions the caller owns and SSH sessions
 *    shared to the caller by another user"). This settles the bd issue's
 *    open question: the fetched docs prove reads are usable, so this
 *    adapter ships rather than falling back to link-only.
 * 2. **Auth is username/password, exchanged for a JWT in two possible
 *    hops.** `POST /users/login` — *"Authenticates a user and returns a
 *    JWT"* — is called first; if its response body does not itself carry a
 *    usable `token` (its response schema is undocumented, unlike every
 *    other claim here), this adapter falls back to the session cookie
 *    `POST /users/login` sets and calls `GET /users/me/token` — *"Returns
 *    the JWT for the currently authenticated session. Intended for mobile
 *    WebView clients that cannot read HTTP-only cookies"* — which is a
 *    verbatim description of this adapter's own situation. Every
 *    subsequent read sends `Authorization: Bearer <token>`, matching
 *    `openapi.json`'s global `bearerAuth` security requirement.
 * 3. **`GET /host/db/host` and `GET /status` carry NO documented response
 *    schema anywhere in the spec** — only the prose descriptions quoted
 *    above. Every field this module reads from a host record beyond an
 *    identifier (`name`, `ip`) and from a status entry (a connectivity
 *    boolean, a last-seen timestamp) is therefore an UNVERIFIED, plausible
 *    guess, read defensively so a wrong guess degrades one fact to `null`
 *    rather than failing the whole read. `test/live-termix.test.ts` is the
 *    standing job to replace this paragraph with observed fact.
 * 4. **`GET /open-tabs/active-sessions` IS fully specified** (`sessionId`,
 *    `hostId`, `hostName`, `isConnected`, `createdAt`, `isOwnSession`,
 *    `sharedByUsername`, `permissionLevel`, plus two internal ids this
 *    module deliberately does not carry into a Loxep fact —
 *    `tabInstanceId`, `shareId`), so this is the one read in the package
 *    with confirmed field names.
 *
 * ## Read-only by construction
 *
 * Termix's surface is an order of magnitude larger and more dangerous than
 * any sibling integration's (Docker container control, systemd services,
 * process signals, file deletion, terminal exec). This package exports no
 * member that starts, stops, deletes, execs, or shares anything, and
 * `operations.ts` enumerates the forbidden segments defensively even though
 * none of the four read paths below approaches them.
 */
import { z } from "zod";
import {
  TERMIX_ACTIVE_SESSIONS_PATH,
  TERMIX_HOSTS_PATH,
  TERMIX_LOGIN_PATH,
  TERMIX_ME_PATH,
  TERMIX_ME_TOKEN_PATH,
  TERMIX_STATUS_PATH,
} from "./operations.ts";
import {
  TermixAdapterError,
  normalizeTermixError,
  readTermixErrorEnvelope,
  termixErrorFromResponse,
} from "./errors.ts";
import {
  type TermixAdapterConfig,
  type TermixAdapterConfigInput,
  parseTermixAdapterConfig,
} from "./config.ts";
import {
  TERMIX_LOGIN_COST,
  TERMIX_SUGGESTED_CAPACITY,
  TERMIX_SUGGESTED_REFILL_PER_SECOND,
  type TermixAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type TermixFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * One SSH host, in Loxep's vocabulary. `name`/`ip` are UNVERIFIED field
 * names — see the module doc — read defensively so a wrong guess degrades
 * to `null` rather than failing the whole read. `online`/`lastSeenAt` come
 * from merging `/status`'s equally-undocumented per-host entry.
 */
export interface TermixHostFact {
  externalHostId: string;
  /** UNVERIFIED field name; `null` when absent. */
  name: string | null;
  /** UNVERIFIED field name; `null` when absent. */
  ip: string | null;
  /** `null` when `/status` reported nothing readable for this host. */
  online: boolean | null;
  /** `null` when absent or the device is currently online. */
  lastSeenAt: string | null;
}

/** One active terminal session — the fully-specified read in this package. */
export interface TermixSessionFact {
  sessionId: string;
  hostId: string;
  hostName: string | null;
  isConnected: boolean;
  /** Epoch milliseconds, Termix's own `number` type — never reformatted here. */
  createdAt: number | null;
  isOwnSession: boolean;
  /** `null` for the caller's own session. */
  sharedByUsername: string | null;
  /** `null` for the caller's own session. */
  permissionLevel: string | null;
}

export interface TermixProbeFact {
  /** `false` only for a network-level failure. */
  reachable: boolean;
  authenticated: boolean;
}

export interface TermixCapabilities {
  provider: "termix";
  readOnly: true;
  /** No response schema is published for hosts/status; see the module doc. */
  stableRecordShapes: false;
}

export interface TermixAdapterStats {
  rateBudget: RateBudgetStats;
  authExchanges: number;
  reauthRetries: number;
}

export interface TermixAdapter {
  probe(): Promise<TermixProbeFact>;
  listHosts(): Promise<TermixHostFact[]>;
  listSessions(): Promise<TermixSessionFact[]>;
  capabilities(): TermixCapabilities;
  stats(): TermixAdapterStats;
}

export interface CreateTermixAdapterInput {
  config: TermixAdapterConfigInput;
  credentials: { username: string; password: string };
  fetchImpl: TermixFetch;
  logger?: TermixAdapterLogger;
  rateBudget?: RateBudget;
}

const loginResponseSchema = z.object({ token: z.string().min(1) }).partial();
const meTokenResponseSchema = z.object({ token: z.string().min(1) });

const hostSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  ip: z.string().optional(),
});

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  hostId: z.union([z.string(), z.number()]),
  hostName: z.string().nullable().optional(),
  isConnected: z.boolean().optional(),
  createdAt: z.number().optional(),
  isOwnSession: z.boolean().optional(),
  sharedByUsername: z.string().nullable().optional(),
  permissionLevel: z.string().nullable().optional(),
});

function unwrapList(body: unknown, wrapperKeys: string[]): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    for (const key of wrapperKeys) {
      const wrapped = (body as Record<string, unknown>)[key];
      if (Array.isArray(wrapped)) return wrapped;
    }
  }
  return null;
}

/**
 * `/status`'s documented shape is "a map of host IDs to their status
 * entries" — an object, never a list. Each entry's own shape is
 * undocumented, so this reads a small set of plausible connectivity keys
 * defensively and treats a bare boolean value as the connectivity signal
 * directly.
 */
function statusEntryToConnectivity(
  entry: unknown,
): { online: boolean | null; lastSeenAt: string | null } {
  if (typeof entry === "boolean") return { online: entry, lastSeenAt: null };
  if (typeof entry !== "object" || entry === null) {
    return { online: null, lastSeenAt: null };
  }
  const record = entry as Record<string, unknown>;
  const onlineCandidate = ["connected", "isConnected", "online", "isOnline"]
    .map((key) => record[key])
    .find((value) => typeof value === "boolean");
  const lastSeenCandidate = ["lastSeen", "lastChecked", "updatedAt", "timestamp"]
    .map((key) => record[key])
    .find((value) => typeof value === "string");
  return {
    online: typeof onlineCandidate === "boolean" ? onlineCandidate : null,
    lastSeenAt: typeof lastSeenCandidate === "string" ? lastSeenCandidate : null,
  };
}

export function createTermixAdapter(
  input: CreateTermixAdapterInput,
): TermixAdapter {
  const config: TermixAdapterConfig = parseTermixAdapterConfig(input.config);
  const { fetchImpl, logger } = input;
  const username = input.credentials.username;
  const password = input.credentials.password;
  if (username === "" || password === "") {
    throw new TermixAdapterError(
      "invalid_request",
      "Termix credentials require both a username and a password",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: TERMIX_SUGGESTED_CAPACITY,
      refillPerSecond: TERMIX_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  /** In-memory only, for the life of this adapter instance. */
  let bearerToken: string | null = null;
  let sessionCookie: string | null = null;
  let authExchanges = 0;
  let reauthRetries = 0;

  const request = async (
    path: string,
    init: {
      method: "GET" | "POST";
      jsonBody?: unknown;
      authorization?: string | null;
      cookie?: string | null;
      cost?: number;
    },
    operation: string,
  ): Promise<{ body: unknown; response: Response }> => {
    const context = { operation, path };
    if (init.method !== "GET" && path !== TERMIX_LOGIN_PATH) {
      // Unreachable through the exported surface. It exists so that a future
      // edit adding a write call fails here rather than at the provider.
      throw new TermixAdapterError(
        "invalid_request",
        "Termix adapter refused a non-GET request outside login",
        { operation, path, method: init.method },
      );
    }

    await rateBudget.acquire(init.cost ?? 1);

    const url = new URL(`${config.baseUrl}${path}`);
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.jsonBody !== undefined) headers["content-type"] = "application/json";
    if (init.authorization != null) headers["authorization"] = init.authorization;
    if (init.cookie != null) headers["cookie"] = init.cookie;

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        ...(init.jsonBody === undefined
          ? {}
          : { body: JSON.stringify(init.jsonBody) }),
      });
    } catch (error) {
      throw normalizeTermixError(error, context);
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
      throw termixErrorFromResponse(
        response.status,
        parseFailed ? { message: null } : readTermixErrorEnvelope(parsed),
        context,
      );
    }
    return { body: parsed, response };
  };

  /**
   * Authenticate and return a bearer token, per the two-hop exchange the
   * module doc explains: prefer a token in the login response body; fall
   * back to the session cookie + `/users/me/token` when the body has none.
   */
  const login = async (): Promise<string> => {
    const { body, response } = await request(
      TERMIX_LOGIN_PATH,
      {
        method: "POST",
        jsonBody: { username, password },
        cost: TERMIX_LOGIN_COST,
      },
      "auth.login",
    );

    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
    const cookie = setCookies.filter((raw) => raw !== "").join("; ") || null;
    sessionCookie = cookie;

    const loginParsed = loginResponseSchema.safeParse(body);
    if (loginParsed.success && loginParsed.data.token !== undefined) {
      authExchanges += 1;
      bearerToken = loginParsed.data.token;
      return bearerToken;
    }

    // The login body carried no usable token; fall back to the endpoint
    // documented for exactly this case (see module doc, finding 2).
    const meToken = await request(
      TERMIX_ME_TOKEN_PATH,
      { method: "GET", cookie },
      "auth.me_token",
    );
    const tokenParsed = meTokenResponseSchema.safeParse(meToken.body);
    if (!tokenParsed.success) {
      throw new TermixAdapterError(
        "provider_unavailable",
        "Termix login succeeded but neither the login response nor /users/me/token returned a usable JWT",
        { operation: "auth.login", path: TERMIX_LOGIN_PATH },
      );
    }
    authExchanges += 1;
    bearerToken = tokenParsed.data.token;
    return bearerToken;
  };

  /**
   * Run an authenticated read, logging in first if needed and exactly once
   * more if Termix rejects the cached token mid-run.
   */
  const authenticated = async <T>(
    run: (authorization: string) => Promise<T>,
  ): Promise<T> => {
    const token = bearerToken ?? (await login());
    try {
      return await run(`Bearer ${token}`);
    } catch (error) {
      if (error instanceof TermixAdapterError && error.kind === "auth") {
        bearerToken = null;
        reauthRetries += 1;
        logger?.debug?.(
          { operation: "auth.retry" },
          "Termix rejected the cached token; re-authenticating once",
        );
        return await run(`Bearer ${await login()}`);
      }
      throw error;
    }
  };

  const listHostsRaw = async (): Promise<Map<string, TermixHostFact>> =>
    await authenticated(async (authorization) => {
      // Sequential, not concurrent: deterministic call order matters more
      // than the small latency win, and every sibling adapter in this repo
      // makes its reads one at a time for the same reason.
      const { body: hostsBody } = await request(
        TERMIX_HOSTS_PATH,
        { method: "GET", authorization },
        "hosts.list",
      );
      const { body: statusBody } = await request(
        TERMIX_STATUS_PATH,
        { method: "GET", authorization },
        "hosts.status",
      );

      const items = unwrapList(hostsBody, ["hosts", "data", "items"]);
      if (items === null) {
        throw new TermixAdapterError(
          "invalid_request",
          "Termix hosts list was neither an array nor a recognized wrapped array",
          { operation: "hosts.list", path: TERMIX_HOSTS_PATH },
        );
      }

      const statusMap =
        typeof statusBody === "object" && statusBody !== null && !Array.isArray(statusBody)
          ? (statusBody as Record<string, unknown>)
          : {};

      const facts = new Map<string, TermixHostFact>();
      for (const item of items) {
        const parsed = hostSchema.safeParse(item);
        if (!parsed.success) {
          logger?.warn?.(
            { operation: "hosts.list" },
            "Termix returned a host record Loxep could not read; skipping it",
          );
          continue;
        }
        const externalHostId = String(parsed.data.id);
        const connectivity = statusEntryToConnectivity(statusMap[externalHostId]);
        facts.set(externalHostId, {
          externalHostId,
          name: parsed.data.name ?? null,
          ip: parsed.data.ip ?? null,
          online: connectivity.online,
          lastSeenAt: connectivity.online === true ? null : connectivity.lastSeenAt,
        });
      }
      return facts;
    });

  return {
    async probe() {
      try {
        await authenticated(async (authorization) => {
          await request(TERMIX_ME_PATH, { method: "GET", authorization }, "auth.me");
        });
        return { reachable: true, authenticated: true };
      } catch (error) {
        if (error instanceof TermixAdapterError && error.kind === "auth") {
          return { reachable: true, authenticated: false };
        }
        throw error;
      }
    },

    async listHosts() {
      return [...(await listHostsRaw()).values()];
    },

    async listSessions() {
      return await authenticated(async (authorization) => {
        const { body } = await request(
          TERMIX_ACTIVE_SESSIONS_PATH,
          { method: "GET", authorization },
          "sessions.list",
        );
        const items = unwrapList(body, ["sessions", "data", "items"]);
        if (items === null) {
          throw new TermixAdapterError(
            "invalid_request",
            "Termix active sessions list was neither an array nor a recognized wrapped array",
            { operation: "sessions.list", path: TERMIX_ACTIVE_SESSIONS_PATH },
          );
        }
        const facts: TermixSessionFact[] = [];
        for (const item of items) {
          const parsed = sessionSchema.safeParse(item);
          if (!parsed.success) continue;
          const value = parsed.data;
          facts.push({
            sessionId: value.sessionId,
            hostId: String(value.hostId),
            hostName: value.hostName ?? null,
            isConnected: value.isConnected ?? false,
            createdAt: value.createdAt ?? null,
            isOwnSession: value.isOwnSession ?? true,
            sharedByUsername: value.sharedByUsername ?? null,
            permissionLevel: value.permissionLevel ?? null,
          });
        }
        return facts;
      });
    },

    capabilities() {
      return { provider: "termix", readOnly: true, stableRecordShapes: false };
    },

    stats() {
      return { rateBudget: rateBudget.stats(), authExchanges, reauthRetries };
    },
  };
}
