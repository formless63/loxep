/**
 * The Tailscale read adapter (ADR-0009, loxep-4su).
 *
 * Loxep reads **one row per device in a tailnet: its name, its addresses,
 * and whether it is currently connected** — plus a reachability/auth probe.
 * Nothing else. No route table, no ACL/policy-file content, no key
 * management, no device authorization or removal.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so a consumer re-declares the
 * shapes it needs structurally and takes no dependency here.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://tailscale.com/docs/reference/tailscale-api as
 * the primary source. That page's live content is now a one-line redirect
 * notice — *"The Tailscale API documentation has moved to
 * https://tailscale.com/api"* — an interactive JavaScript-rendered OpenAPI
 * explorer this environment cannot fetch as readable text. `operations.ts`
 * records the three artifacts that corroborate every literal path and field
 * used here: the pre-move `api.md` mirror, Tailscale's own maintained Go
 * client (`tailscale.com/client/tailscale/v2`), and the OAuth-clients doc
 * page. Three findings shape this module:
 *
 * 1. **Auth is one of two documented modes.** A personal access token
 *    (*"generated from the Keys page of the admin console"*, sent as HTTP
 *    Basic auth with the token as username and empty password) that
 *    *"expires after"* an operator-chosen *"1 and 90"* days with **no
 *    auto-renewal** — the operational implication the owner asked to be
 *    noted: this adapter's `auth` error is the ordinary, expected signal
 *    that a fresh token is due. Or an OAuth client (`client_id` +
 *    `client_secret`, RFC 6749 §4.4 client-credentials), whose minted
 *    access tokens *"expire after one hour"* and which this adapter
 *    re-exchanges automatically — the better fit for unattended polling.
 *    See `credentials.ts`.
 * 2. **No rate limit is published**, and an upstream feature request asking
 *    for one to be documented (tailscale/tailscale#14328) is still open.
 *    See `rate-budget.ts`.
 * 3. **No whoami/identity endpoint is documented.** The Go client's
 *    `Client` exposes `Contacts`, `DNS`, `DevicePosture`, `Devices`, `Keys`,
 *    `Logging`, `PolicyFile`, `Services`, `TailnetSettings`, `Users`,
 *    `VIPServices`, `Webhooks` — no `WhoAmI`/`Me`. `probe()` therefore
 *    reuses the cheapest authenticated read available (a devices list) and
 *    reports reachability/auth validity from its outcome; unlike Beszel's
 *    genuinely unauthenticated health tier, Tailscale requires the
 *    credential for even this cheapest call.
 *
 * `Device` field names (`hostname`, `name`, `addresses`, `lastSeen`,
 * `connectedToControl`, `os`) are read directly from the Go client's
 * published struct, which is a stronger source than Beszel/Dockhand's
 * UNVERIFIED-field situation — but `test/live-tailscale.test.ts` is still
 * the standing job to confirm them against a real tailnet.
 *
 * ## Read-only by construction
 *
 * The `devices:core` scope grants read AND write together — Tailscale
 * publishes no device-mutation-free scope narrower than that — so the
 * restraint lives entirely in this package's own exported surface (no
 * member named after a write verb) and in `operations.ts`'s allow-list.
 * `test/boundary.test.ts` asserts every request is a `GET`, except the
 * OAuth token exchange.
 */
import { z } from "zod";
import {
  TAILSCALE_ALLOWED_NON_GET_PATHS,
  TAILSCALE_OAUTH_TOKEN_PATH,
  tailscaleDevicesPath,
} from "./operations.ts";
import {
  TailscaleAdapterError,
  normalizeTailscaleError,
  readTailscaleErrorEnvelope,
  tailscaleErrorFromResponse,
} from "./errors.ts";
import {
  type TailscaleAdapterConfig,
  type TailscaleAdapterConfigInput,
  parseTailscaleAdapterConfig,
} from "./config.ts";
import type { TailscaleCredentials } from "./credentials.ts";
import {
  TAILSCALE_SUGGESTED_CAPACITY,
  TAILSCALE_SUGGESTED_REFILL_PER_SECOND,
  type TailscaleAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type TailscaleFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * One tailnet device, in Loxep's vocabulary. `os`, `authorized` are extra
 * confirmed-cheap facts beyond the minimum ask (hostname/addresses/online/
 * lastSeen); nothing else from the much larger `Device` struct is read.
 */
export interface TailscaleDeviceFact {
  /** `nodeId` (Tailscale's preferred identifier), falling back to `id`. */
  externalDeviceId: string;
  /** The MagicDNS name (the Go client's `Name` field). */
  name: string | null;
  hostname: string | null;
  addresses: string[];
  /** `true` when the control plane reports the node as connected. */
  online: boolean;
  /** `null` when `online` — the Go client documents `LastSeen` as nil then. */
  lastSeen: string | null;
  os: string | null;
  authorized: boolean | null;
}

export interface TailscaleProbeFact {
  /** `false` only for a network-level failure; an auth rejection still reached the API. */
  reachable: boolean;
  /** Whether the stored credential was accepted. */
  authenticated: boolean;
  /** `null` when `authenticated` is `false`. */
  deviceCount: number | null;
}

export interface TailscaleCapabilities {
  provider: "tailscale";
  readOnly: true;
  /** Which credential mode this adapter instance was built with. */
  authMode: TailscaleCredentials["mode"];
  /** No whoami endpoint is published; `probe()` substitutes a devices read. */
  unauthenticatedHealthProbe: false;
}

export interface TailscaleAdapterStats {
  rateBudget: RateBudgetStats;
  /** OAuth token exchanges performed (`api_access_token` mode: always 0). */
  oauthExchanges: number;
  /** Requests retried once after a mid-run OAuth token rejection. */
  reauthRetries: number;
}

export interface TailscaleAdapter {
  probe(): Promise<TailscaleProbeFact>;
  listDevices(): Promise<TailscaleDeviceFact[]>;
  capabilities(): TailscaleCapabilities;
  stats(): TailscaleAdapterStats;
}

export interface CreateTailscaleAdapterInput {
  config: TailscaleAdapterConfigInput;
  credentials: TailscaleCredentials;
  fetchImpl: TailscaleFetch;
  logger?: TailscaleAdapterLogger;
  rateBudget?: RateBudget;
}

/** The `Device` shape, read defensively beyond the guaranteed identifier. */
const deviceSchema = z.object({
  id: z.string().optional(),
  nodeId: z.string().optional(),
  name: z.string().optional(),
  hostname: z.string().optional(),
  addresses: z.array(z.string()).optional(),
  lastSeen: z.string().nullable().optional(),
  connectedToControl: z.boolean().optional(),
  os: z.string().optional(),
  authorized: z.boolean().optional(),
});

/** Accept both a bare array and Tailscale's documented `{devices: [...]}` wrapper. */
function unwrapDevices(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const wrapped = (body as Record<string, unknown>)["devices"];
    if (Array.isArray(wrapped)) return wrapped;
  }
  return null;
}

const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

export function createTailscaleAdapter(
  input: CreateTailscaleAdapterInput,
): TailscaleAdapter {
  const config: TailscaleAdapterConfig = parseTailscaleAdapterConfig(
    input.config,
  );
  const { fetchImpl, logger, credentials } = input;

  if (credentials.mode === "api_access_token" && credentials.apiAccessToken === "") {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale API access token must not be empty",
    );
  }
  if (
    credentials.mode === "oauth_client" &&
    (credentials.clientId === "" || credentials.clientSecret === "")
  ) {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale OAuth client requires both a client id and a client secret",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: TAILSCALE_SUGGESTED_CAPACITY,
      refillPerSecond: TAILSCALE_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  /** In-memory only, for the life of this adapter instance — mode `oauth_client` only. */
  let oauthAccessToken: string | null = null;
  let oauthExchanges = 0;
  let reauthRetries = 0;

  const request = async (
    path: string,
    init: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      formBody?: Record<string, string>;
      authorization: string | null;
    },
    operation: string,
  ): Promise<unknown> => {
    const context = { operation, path };
    if (
      init.method !== "GET" &&
      !TAILSCALE_ALLOWED_NON_GET_PATHS.includes(
        path as (typeof TAILSCALE_ALLOWED_NON_GET_PATHS)[number],
      )
    ) {
      // Unreachable through the exported surface. It exists so that a future
      // edit adding a mutating call fails here rather than at the provider.
      throw new TailscaleAdapterError(
        "invalid_request",
        "Tailscale adapter refused a non-GET request outside the OAuth token exchange",
        { operation, path, method: init.method },
      );
    }

    await rateBudget.acquire(1);

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (init.authorization !== null) headers["authorization"] = init.authorization;
    let body: string | undefined;
    if (init.formBody !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.formBody).toString();
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw normalizeTailscaleError(error, context);
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
      throw tailscaleErrorFromResponse(
        response.status,
        parseFailed ? { message: null } : readTailscaleErrorEnvelope(parsed),
        context,
      );
    }
    return parsed;
  };

  /** RFC 6749 §4.4 client-credentials exchange. Form-encoded, per the RFC. */
  const exchangeOAuthToken = async (): Promise<string> => {
    if (credentials.mode !== "oauth_client") {
      throw new TailscaleAdapterError(
        "invalid_request",
        "OAuth token exchange requested without an OAuth client credential",
      );
    }
    const body = await request(
      TAILSCALE_OAUTH_TOKEN_PATH,
      {
        method: "POST",
        authorization: null,
        formBody: {
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        },
      },
      "oauth.token",
    );
    const parsed = oauthTokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TailscaleAdapterError(
        "provider_unavailable",
        "Tailscale OAuth token exchange succeeded but returned no usable access token",
        { operation: "oauth.token", path: TAILSCALE_OAUTH_TOKEN_PATH },
      );
    }
    oauthExchanges += 1;
    oauthAccessToken = parsed.data.access_token;
    return parsed.data.access_token;
  };

  /** Resolve the `Authorization` header for one request, per credential mode. */
  const authorizationHeader = async (): Promise<string> => {
    if (credentials.mode === "api_access_token") {
      // Basic auth, token as username, empty password — the documented curl
      // example is `-u "tskey-api-xxxxx:"`.
      return `Basic ${Buffer.from(`${credentials.apiAccessToken}:`, "utf8").toString("base64")}`;
    }
    const token = oauthAccessToken ?? (await exchangeOAuthToken());
    return `Bearer ${token}`;
  };

  /**
   * Run an authenticated read, re-exchanging the OAuth token exactly once if
   * the API rejects it mid-run. `api_access_token` mode never retries here:
   * the token either works or has expired, and expiry is not something a
   * retry fixes.
   */
  const authenticated = async <T>(
    run: (authorization: string) => Promise<T>,
  ): Promise<T> => {
    const authorization = await authorizationHeader();
    try {
      return await run(authorization);
    } catch (error) {
      if (
        credentials.mode === "oauth_client" &&
        error instanceof TailscaleAdapterError &&
        error.kind === "auth"
      ) {
        oauthAccessToken = null;
        reauthRetries += 1;
        logger?.debug?.(
          { operation: "oauth.retry" },
          "Tailscale rejected the cached OAuth token; re-exchanging once",
        );
        return await run(await authorizationHeader());
      }
      throw error;
    }
  };

  const toDeviceFact = (raw: unknown): TailscaleDeviceFact | null => {
    const parsed = deviceSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    const externalDeviceId = value.nodeId ?? value.id;
    if (externalDeviceId === undefined) return null;
    const online = value.connectedToControl ?? false;
    return {
      externalDeviceId,
      name: value.name ?? null,
      hostname: value.hostname ?? null,
      addresses: value.addresses ?? [],
      online,
      // The Go client documents LastSeen as nil while connected; degrade
      // consistently even if a future field addition disagrees.
      lastSeen: online ? null : (value.lastSeen ?? null),
      os: value.os ?? null,
      authorized: value.authorized ?? null,
    };
  };

  const listDevicesRaw = async (): Promise<unknown[]> =>
    await authenticated(async (authorization) => {
      const body = await request(
        tailscaleDevicesPath(config.tailnet),
        {
          method: "GET",
          query: { fields: "default" },
          authorization,
        },
        "devices.list",
      );
      const items = unwrapDevices(body);
      if (items === null) {
        throw new TailscaleAdapterError(
          "invalid_request",
          "Tailscale devices list was neither an array nor a wrapped array",
          { operation: "devices.list", path: tailscaleDevicesPath(config.tailnet) },
        );
      }
      return items;
    });

  return {
    async probe() {
      try {
        const items = await listDevicesRaw();
        return { reachable: true, authenticated: true, deviceCount: items.length };
      } catch (error) {
        if (error instanceof TailscaleAdapterError && error.kind === "auth") {
          return { reachable: true, authenticated: false, deviceCount: null };
        }
        throw error;
      }
    },

    async listDevices() {
      const items = await listDevicesRaw();
      const facts: TailscaleDeviceFact[] = [];
      for (const item of items) {
        const fact = toDeviceFact(item);
        if (fact === null) {
          logger?.warn?.(
            { operation: "devices.list" },
            "Tailscale returned a device Loxep could not read; skipping it",
          );
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    capabilities() {
      return {
        provider: "tailscale",
        readOnly: true,
        authMode: credentials.mode,
        unauthenticatedHealthProbe: false,
      };
    },

    stats() {
      return { rateBudget: rateBudget.stats(), oauthExchanges, reauthRetries };
    },
  };
}
