/**
 * Fixture payloads for the Etsy Open API v3 shapes this package maps.
 *
 * PROVENANCE:
 * - `{amount, divisor, currency_code}` Money shape, endpoint paths
 *   (`/openapi-ping`, `/listings/{id}`, `/shops/{id}`,
 *   `/shops/{id}/listings/active`, `/shops/{id}/listings`), the fixed base
 *   URL `https://api.etsy.com/v3/application`, and the `x-api-key`/
 *   `Authorization: Bearer <userId>.<token>` header pair are SOURCE-VERIFIED
 *   against `anitabyte/etsyv3` (`main` branch, fetched 2026-08-13,
 *   `etsyv3/etsy_api.py` and `tests/test_listing.py`) — a third-party Python
 *   client for Etsy Open API v3.
 * - The OAuth2+PKCE flow (authorize URL, token URL, S256 code_challenge
 *   derivation) is SOURCE-VERIFIED against the same repository's
 *   `etsyv3/util/auth/auth_helper.py`.
 * - The error envelope `{"error": "<message>"}` is stated directly in the
 *   binding design (`etsy-integration-design.md`, "Error shape").
 * - The remaining Listing/Shop field NAMES below (`listing_id`, `state`,
 *   `quantity`, `title`, `url`, `taxonomy_id`, `listing_type`, `shop_id`,
 *   `num_favorers`, `shop_name`, `listing_active_count`,
 *   `review_average`/`review_count`) are DESIGN-DERIVED from Etsy Open API
 *   v3's long-standing public documentation and field-naming conventions —
 *   an automated fetch of the live interactive reference
 *   (`developers.etsy.com/documentation/reference`) during this work
 *   returned only a client-rendered Docusaurus shell with no spec reachable
 *   by a non-JS-executing fetch tool, the same kind of friction the design
 *   document's own survey hit fetching Etsy's ToS page. These field names
 *   are NOT independently confirmed against a live authenticated response in
 *   this session — flagged pending live verification, the same caveat
 *   `@loxep/integration-ebay/orders.ts`'s module doc carries for its own
 *   design-derived status enums.
 */

export const pingResponse = { application_id: 123456 };

export const listingResponse = {
  listing_id: 987654321,
  shop_id: 55555,
  user_id: 111222,
  title: "Hand-thrown ceramic mug",
  description: "A wheel-thrown stoneware mug, glazed and food-safe.",
  state: "active",
  quantity: 4,
  price: { amount: 2999, divisor: 100, currency_code: "USD" },
  url: "https://www.etsy.com/listing/987654321/hand-thrown-ceramic-mug",
  taxonomy_id: 1234,
  listing_type: "physical",
  tags: ["ceramic", "mug", "handmade"],
  num_favorers: 42,
  views: 310,
  created_timestamp: 1_754_000_000,
  last_modified_timestamp: 1_754_100_000,
};

export const draftListingResponse = {
  ...listingResponse,
  listing_id: 987654322,
  state: "draft",
  quantity: 1,
};

export const soldOutListingResponse = {
  ...listingResponse,
  listing_id: 987654323,
  state: "sold_out",
  quantity: 0,
  price: { amount: 4500, divisor: 100, currency_code: "USD" },
};

export const expiredListingResponse = {
  ...listingResponse,
  listing_id: 987654324,
  state: "expired",
};

/** A JPY listing — divisor 1, no fractional yen. */
export const jpyListingResponse = {
  ...listingResponse,
  listing_id: 987654325,
  price: { amount: 3200, divisor: 1, currency_code: "JPY" },
};

export const shopActiveListingsResponse = {
  count: 3,
  results: [listingResponse, soldOutListingResponse, jpyListingResponse],
};

export const shopListingsAllStatesResponse = {
  count: 4,
  results: [
    listingResponse,
    draftListingResponse,
    soldOutListingResponse,
    expiredListingResponse,
  ],
};

export const shopResponse = {
  shop_id: 55555,
  shop_name: "CeramicsByAlex",
  user_id: 111222,
  title: "Handmade stoneware, made in small batches",
  currency_code: "USD",
  listing_active_count: 128,
  digital_listing_count: 0,
  login_name: "ceramicsbyalex",
  url: "https://www.etsy.com/shop/CeramicsByAlex",
  review_count: 412,
  review_average: 4.9,
  is_vacation: false,
  transaction_sold_count: 900,
};

/** `{"error": "<message>"}` — the whole envelope, per the binding design. */
export function etsyErrorBody(message: string): { error: string } {
  return { error: message };
}

/** A raw OAuth2 token response, `access_token` shaped `<userId>.<opaque>`. */
export const oauthTokenResponse = {
  access_token: "111222333.aVeryOpaqueEtsyAccessTokenValue",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "aVeryOpaqueEtsyRefreshTokenValue",
};

export const oauthRefreshResponse = {
  access_token: "111222333.aRotatedOpaqueEtsyAccessTokenValue",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "aRotatedOpaqueEtsyRefreshTokenValue",
};
