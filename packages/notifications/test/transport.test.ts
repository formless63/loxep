/**
 * ntfy transport tests (loxep-ubx.4): request shape via a captured fetch —
 * headers, auth, body, URL joining. NO real network anywhere.
 */
import { describe, expect, it } from "vitest";
import {
  NotificationTransportError,
  createNtfyTransport,
} from "../src/index.ts";
import type { FetchLike } from "../src/index.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function captureFetch(
  respond: (request: CapturedRequest) => {
    ok: boolean;
    status: number;
    text: string;
  } = () => ({ ok: true, status: 200, text: '{"id":"msg-1"}' }),
): { calls: CapturedRequest[]; fetch: FetchLike } {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = { url, ...init };
    calls.push(request);
    const response = respond(request);
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.text,
    };
  };
  return { calls, fetch };
}

const config = {
  baseUrl: "https://ntfy.example.test/",
  topic: "loxep-alerts",
  priority: "default",
};

describe("createNtfyTransport", () => {
  it("POSTs to <baseUrl>/<topic> with Title/Priority/Tags headers and bearer auth", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    const result = await transport.send({
      config,
      token: "tk_secret_token",
      message: {
        title: "Loxep: price dropped",
        body: "price_dropped for item X",
        priority: "high",
        tags: ["price_dropped", "moneybag"],
      },
    });
    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    // Trailing slash on baseUrl must not produce a double slash.
    expect(request.url).toBe("https://ntfy.example.test/loxep-alerts");
    expect(request.method).toBe("POST");
    expect(request.body).toBe("price_dropped for item X");
    expect(request.headers["Title"]).toBe("Loxep: price dropped");
    // Message priority overrides the endpoint config default.
    expect(request.headers["Priority"]).toBe("high");
    expect(request.headers["Tags"]).toBe("price_dropped,moneybag");
    expect(request.headers["Authorization"]).toBe("Bearer tk_secret_token");
    expect(result.providerMessageId).toBe("msg-1");
  });

  it("omits Authorization without a token and falls back to config priority", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config,
      token: null,
      message: { title: "t", body: "b" },
    });
    const request = calls[0]!;
    expect(request.headers["Authorization"]).toBeUndefined();
    expect(request.headers["Priority"]).toBe("default");
    expect(request.headers["Tags"]).toBeUndefined();
  });

  it("omits Priority entirely when neither message nor config set one", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config: { baseUrl: "https://ntfy.example.test", topic: "t1" },
      token: null,
      message: { title: "t", body: "b" },
    });
    expect(calls[0]!.headers["Priority"]).toBeUndefined();
  });

  it("sets the Click header to message.url when present", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config,
      token: null,
      message: {
        title: "Price drop: Widget",
        body: "Widget: $34.99\nhttps://www.ebay.com/itm/123456789",
        url: "https://www.ebay.com/itm/123456789",
      },
    });
    const request = calls[0]!;
    expect(request.headers["Click"]).toBe(
      "https://www.ebay.com/itm/123456789",
    );
    // The URL stays in the body too, for clients without click support.
    expect(request.body).toContain("https://www.ebay.com/itm/123456789");
  });

  it("omits the Click header when message.url is absent", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config,
      token: null,
      message: { title: "t", body: "b" },
    });
    expect(calls[0]!.headers["Click"]).toBeUndefined();
  });

  it("omits the Click header when message.url is empty", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config,
      token: null,
      message: { title: "t", body: "b", url: "" },
    });
    expect(calls[0]!.headers["Click"]).toBeUndefined();
  });

  it("collapses control characters in header values", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await transport.send({
      config,
      token: null,
      message: { title: "line one\r\nline two", body: "b" },
    });
    expect(calls[0]!.headers["Title"]).toBe("line one line two");
  });

  it("returns null providerMessageId for a non-JSON response body", async () => {
    const { fetch } = captureFetch(() => ({
      ok: true,
      status: 200,
      text: "ok",
    }));
    const transport = createNtfyTransport(fetch);
    const result = await transport.send({
      config,
      token: null,
      message: { title: "t", body: "b" },
    });
    expect(result.providerMessageId).toBeNull();
  });

  it("throws NotificationTransportError with status on non-2xx", async () => {
    const { fetch } = captureFetch(() => ({
      ok: false,
      status: 403,
      text: "forbidden",
    }));
    const transport = createNtfyTransport(fetch);
    await expect(
      transport.send({
        config,
        token: null,
        message: { title: "t", body: "b" },
      }),
    ).rejects.toMatchObject({
      name: "NotificationTransportError",
      status: 403,
    });
  });

  it("wraps a rejecting fetch in NotificationTransportError", async () => {
    const transport = createNtfyTransport(() =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    await expect(
      transport.send({
        config,
        token: null,
        message: { title: "t", body: "b" },
      }),
    ).rejects.toThrow(NotificationTransportError);
  });

  it("rejects an invalid config at send time", async () => {
    const { calls, fetch } = captureFetch();
    const transport = createNtfyTransport(fetch);
    await expect(
      transport.send({
        config: { baseUrl: "not-a-url", topic: "x" },
        token: null,
        message: { title: "t", body: "b" },
      }),
    ).rejects.toThrow(NotificationTransportError);
    expect(calls).toHaveLength(0);
  });
});
