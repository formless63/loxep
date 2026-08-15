import { describe, expect, it } from "vitest";
import {
  NINJA_COUNTRY_ID_BY_ALPHA2,
  NINJA_CURRENCY_ID_BY_ISO4217,
  ninjaCountryIdForAlpha2,
  ninjaCurrencyIdForIso4217,
} from "../src/id-maps.ts";

describe("NINJA_COUNTRY_ID_BY_ALPHA2", () => {
  it("has 249 entries, matching the seeder's row count", () => {
    expect(Object.keys(NINJA_COUNTRY_ID_BY_ALPHA2)).toHaveLength(249);
  });

  it("equals the ISO-3166-1 numeric code for well-known countries", () => {
    expect(NINJA_COUNTRY_ID_BY_ALPHA2["US"]).toBe(840);
    expect(NINJA_COUNTRY_ID_BY_ALPHA2["GB"]).toBe(826);
    expect(NINJA_COUNTRY_ID_BY_ALPHA2["DE"]).toBe(276);
    expect(NINJA_COUNTRY_ID_BY_ALPHA2["JP"]).toBe(392);
  });
});

describe("NINJA_CURRENCY_ID_BY_ISO4217", () => {
  it("has 140 entries, matching the seeder's row count", () => {
    expect(Object.keys(NINJA_CURRENCY_ID_BY_ISO4217)).toHaveLength(140);
  });

  it("matches Ninja's own (non-ISO-derivable) sequence for well-known currencies", () => {
    expect(NINJA_CURRENCY_ID_BY_ISO4217["USD"]).toBe(1);
    expect(NINJA_CURRENCY_ID_BY_ISO4217["GBP"]).toBe(2);
    expect(NINJA_CURRENCY_ID_BY_ISO4217["EUR"]).toBe(3);
  });
});

describe("ninjaCountryIdForAlpha2", () => {
  it("is case-insensitive and trims", () => {
    expect(ninjaCountryIdForAlpha2("us")).toBe(840);
    expect(ninjaCountryIdForAlpha2(" US ")).toBe(840);
  });

  it("returns null rather than throwing for an unmapped or missing code", () => {
    expect(ninjaCountryIdForAlpha2("ZZ")).toBeNull();
    expect(ninjaCountryIdForAlpha2(null)).toBeNull();
    expect(ninjaCountryIdForAlpha2(undefined)).toBeNull();
  });
});

describe("ninjaCurrencyIdForIso4217", () => {
  it("is case-insensitive and trims", () => {
    expect(ninjaCurrencyIdForIso4217("usd")).toBe(1);
    expect(ninjaCurrencyIdForIso4217(" USD ")).toBe(1);
  });

  it("returns null rather than throwing for an unmapped or missing code", () => {
    expect(ninjaCurrencyIdForIso4217("ZZZ")).toBeNull();
    expect(ninjaCurrencyIdForIso4217(null)).toBeNull();
    expect(ninjaCurrencyIdForIso4217(undefined)).toBeNull();
  });
});
