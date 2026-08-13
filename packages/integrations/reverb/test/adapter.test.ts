import { describe, expect, it } from "vitest";
import { createRateBudget, createReverbAdapter, ReverbAdapterError } from "../src/index.ts";
import { createFailingFetchStub, createFetchStub, rejection, TEST_TOKEN } from "./http.ts";
import {
  listingResponse,
  myListingsEmptyResponse,
  myListingsPage1Response,
  myListingsPage2Response,
  pingAccountResponse,
  reverbErrorBody,
} from "./fixtures.ts";

function testAdapter(fetchImpl: ReturnType<typeof createFetchStub>["impl"]) {
  return createReverbAdapter({
    personalAccessToken: TEST_TOKEN,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 100 }),
    fetchImpl,
  });
}

describe("createReverbAdapter — headers", () => {
  it("sends Authorization: Bearer <token>, Accept-Version: 3.0, and application/hal+json", async () => {
    const stub = createFetchStub([{ status: 200, body: pingAccountResponse }]);
    const adapter = testAdapter(stub.impl);
    await adapter.getAccount();
    const call = stub.calls[0]!;
    expect(call.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call.headers["accept-version"]).toBe("3.0");
    expect(call.headers["accept"]).toBe("application/hal+json");
    expect(call.headers["content-type"]).toBe("application/hal+json");
  });

  it("acquires from the injected rate budget before every request", async () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 1000 });
    const stub = createFetchStub([
      { status: 200, body: pingAccountResponse },
      { status: 200, body: pingAccountResponse },
    ]);
    const adapter = createReverbAdapter({
      personalAccessToken: TEST_TOKEN,
      rateBudget: budget,
      fetchImpl: stub.impl,
    });
    await adapter.getAccount();
    expect(budget.stats().acquired).toBe(1);
    await adapter.getAccount();
    expect(budget.stats().acquired).toBe(2);
  });

  it("creates a conservative private default budget when none is injected", async () => {
    const stub = createFetchStub([{ status: 200, body: pingAccountResponse }]);
    const adapter = createReverbAdapter({
      personalAccessToken: TEST_TOKEN,
      fetchImpl: stub.impl,
    });
    await adapter.getAccount();
    expect(adapter.stats().rateBudget.capacity).toBe(5);
  });
});

describe("createReverbAdapter — getListing", () => {
  it("fetches one listing by id", async () => {
    const stub = createFetchStub([{ status: 200, body: listingResponse }]);
    const adapter = testAdapter(stub.impl);
    const listing = await adapter.getListing("987654321");
    expect(listing["id"]).toBe(987654321);
    expect(stub.pathOf(0)).toBe("/api/listings/987654321");
  });

  it("rejects an empty listingId before any network call", async () => {
    const stub = createFetchStub([]);
    const adapter = testAdapter(stub.impl);
    await expect(adapter.getListing("")).rejects.toThrowError(ReverbAdapterError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("createReverbAdapter — getMyListings", () => {
  it("defaults to state=all on the first page", async () => {
    const stub = createFetchStub([{ status: 200, body: myListingsPage1Response }]);
    const adapter = testAdapter(stub.impl);
    const page = await adapter.getMyListings();
    expect(stub.pathOf(0)).toBe("/api/my/listings");
    expect(stub.queryOf(0)["state"]).toEqual(["all"]);
    expect(page.results).toHaveLength(2);
    expect(page.nextHref).toBe("https://api.reverb.com/api/my/listings?state=all&page=2");
  });

  it("narrows by an explicit state", async () => {
    const stub = createFetchStub([{ status: 200, body: myListingsEmptyResponse }]);
    const adapter = testAdapter(stub.impl);
    await adapter.getMyListings({ state: "draft" });
    expect(stub.queryOf(0)["state"]).toEqual(["draft"]);
  });

  it("follows a returned nextHref verbatim rather than reconstructing it", async () => {
    const stub = createFetchStub([{ status: 200, body: myListingsPage2Response }]);
    const adapter = testAdapter(stub.impl);
    const page = await adapter.getMyListings({
      pageHref: "https://api.reverb.com/api/my/listings?state=all&page=2",
    });
    expect(stub.calls[0]!.url).toBe("https://api.reverb.com/api/my/listings?state=all&page=2");
    expect(page.results).toHaveLength(1);
    expect(page.nextHref).toBeNull();
  });

  it("throws provider_unavailable when the envelope has no listings array", async () => {
    const stub = createFetchStub([{ status: 200, body: { not: "a listings envelope" } }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getMyListings());
    expect(error.kind).toBe("provider_unavailable");
  });
});

describe("createReverbAdapter — error taxonomy end to end", () => {
  it("maps a 401 to auth", async () => {
    const stub = createFetchStub([{ status: 401, body: reverbErrorBody("bad token") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(error.kind).toBe("auth");
  });

  it("maps a 404 to not_found", async () => {
    const stub = createFetchStub([{ status: 404, body: reverbErrorBody("listing not found") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getListing("999"));
    expect(error.kind).toBe("not_found");
  });

  it("maps a 412 to invalid_request", async () => {
    const stub = createFetchStub([{ status: 412, body: reverbErrorBody("missing param") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getListing("999"));
    expect(error.kind).toBe("invalid_request");
  });

  it("maps a 429 to rate_limited", async () => {
    const stub = createFetchStub([{ status: 429, body: reverbErrorBody("too many requests") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(error.kind).toBe("rate_limited");
  });

  it("maps a 5xx to provider_unavailable", async () => {
    const stub = createFetchStub([{ status: 502, body: reverbErrorBody("upstream error") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(error.kind).toBe("provider_unavailable");
  });

  it("maps a network failure to provider_unavailable without leaking request material", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
    );
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(error.kind).toBe("provider_unavailable");
    expect(JSON.stringify(error.detail)).not.toContain(TEST_TOKEN);
  });

  it("credential material is never present in a thrown error's detail", async () => {
    const stub = createFetchStub([{ status: 401, body: reverbErrorBody("bad token") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(JSON.stringify(error.detail)).not.toContain(TEST_TOKEN);
  });

  it("throws provider_unavailable for a non-JSON body on a successful status", async () => {
    const stub = createFetchStub([
      { status: 200, text: "<html>not json</html>", contentType: "text/html" },
    ]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getAccount());
    expect(error.kind).toBe("provider_unavailable");
  });
});

describe("createReverbAdapter — stats", () => {
  it("reports rate budget stats and a running request count", async () => {
    const stub = createFetchStub([{ status: 200, body: pingAccountResponse }]);
    const adapter = testAdapter(stub.impl);
    expect(adapter.stats().requests).toBe(0);
    await adapter.getAccount();
    expect(adapter.stats().requests).toBe(1);
  });
});
