/**
 * Transport-neutral notification sending (loxep-ubx.4).
 *
 * `NotificationTransport` is the boundary the delivery pipeline talks to;
 * ntfy is the FIRST implementation, not the model (implementation contract
 * "Notifications"). Additional providers implement the same interface and
 * register their config schema in `endpoints.ts`.
 *
 * The ntfy transport publishes via `POST <baseUrl>/<topic>` with the message
 * body as the request body and `Title`/`Priority`/`Tags` headers, plus
 * `Authorization: Bearer <token>` when an access token is configured
 * (https://docs.ntfy.sh/publish/ — verified 2026-08). The HTTP client is an
 * injectable fetch-shaped function so tests capture requests without any
 * real network I/O.
 */
import { NotificationTransportError } from "./errors.ts";
import { ntfyEndpointConfigSchema } from "./endpoints.ts";
import type { NtfyPriority } from "./endpoints.ts";

/** Transport-neutral message shape. */
export interface NotificationMessage {
  title: string;
  body: string;
  priority?: NtfyPriority;
  tags?: readonly string[];
}

export interface TransportSendInput {
  /** The endpoint's non-secret `config` jsonb (validated per provider). */
  config: unknown;
  /** Decrypted endpoint token, or null when the endpoint has none. */
  token: string | null;
  message: NotificationMessage;
}

export interface TransportSendResult {
  /** Provider-assigned message id when the provider returns one. */
  providerMessageId: string | null;
}

/** The boundary the delivery pipeline depends on. */
export interface NotificationTransport {
  readonly provider: string;
  send: (input: TransportSendInput) => Promise<TransportSendResult>;
}

/** Minimal structural fetch so tests can capture requests (no network). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** Header values must be single-line; collapse control characters. */
function headerValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replaceAll(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

/**
 * ntfy transport. `fetchImpl` defaults to the global `fetch`; inject a
 * capture double in tests — tests never perform real network I/O.
 */
export function createNtfyTransport(
  fetchImpl?: FetchLike,
): NotificationTransport {
  const doFetch: FetchLike =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  return {
    provider: "ntfy",
    send: async ({ config, token, message }) => {
      const parsed = ntfyEndpointConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new NotificationTransportError(
          "ntfy endpoint config failed validation at send time",
        );
      }
      const { baseUrl, topic } = parsed.data;
      const url = `${baseUrl.replace(/\/+$/u, "")}/${topic}`;
      const headers: Record<string, string> = {
        Title: headerValue(message.title),
      };
      const priority = message.priority ?? parsed.data.priority;
      if (priority !== undefined) {
        headers["Priority"] = priority;
      }
      if (message.tags !== undefined && message.tags.length > 0) {
        headers["Tags"] = headerValue(message.tags.join(","));
      }
      if (token !== null) {
        headers["Authorization"] = `Bearer ${headerValue(token)}`;
      }

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: message.body,
        });
      } catch (error) {
        throw new NotificationTransportError(
          `ntfy publish failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        throw new NotificationTransportError(
          `ntfy publish returned HTTP ${response.status}: ${text.slice(0, 200)}`,
          { status: response.status },
        );
      }
      // ntfy answers with a JSON message envelope containing `id`.
      try {
        const body = JSON.parse(text) as { id?: unknown };
        return {
          providerMessageId: typeof body.id === "string" ? body.id : null,
        };
      } catch {
        return { providerMessageId: null };
      }
    },
  };
}
