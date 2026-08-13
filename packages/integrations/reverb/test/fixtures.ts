/**
 * Fixtures for the unit-test suite. Shapes cross-checked against Reverb's
 * own developer documentation (see each module's doc comment for the exact
 * source URLs and fetch date); every fixture is otherwise fabricated test
 * data, never a real listing/account.
 */

export const pingAccountResponse = {
  id: 424242,
  email: "seller@example.com",
  name: "Test Seller",
};

export const listingResponse = {
  id: 987654321,
  title: "1965 Fender Stratocaster",
  state: "live",
  price: { amount: "2999.99", currency: "USD" },
  shop: { id: "55555", name: "Vintage Gear Co" },
  _links: {
    web: { href: "https://reverb.com/item/987654321" },
  },
};

export const listingDraftResponse = {
  id: 111222333,
  title: "Draft — Gibson Les Paul",
  state: "draft",
  price: { amount: "1500.00", currency: "USD" },
  _links: {},
};

export const listingSoldResponse = {
  id: 444555666,
  title: "Sold — Vox AC30",
  state: "sold",
  price: { amount: "1200.00", currency: "USD" },
  _links: { web: { href: "https://reverb.com/item/444555666" } },
};

export const myListingsPage1Response = {
  listings: [listingResponse, listingDraftResponse],
  _links: {
    next: { href: "https://api.reverb.com/api/my/listings?state=all&page=2" },
  },
};

export const myListingsPage2Response = {
  listings: [listingSoldResponse],
  _links: {},
};

export const myListingsEmptyResponse = {
  listings: [],
  _links: {},
};

export function reverbErrorBody(
  message: string,
  errors?: Record<string, string[]>,
): { message: string; errors?: Record<string, string[]> } {
  return errors !== undefined ? { message, errors } : { message };
}
