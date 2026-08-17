/**
 * `REGION_GEO_REGISTRY` — the map lens's location resolver (UI overhaul 2026
 * design §4, rule MAP1, `loxep-m4m`). `hosting_targets.provider` +
 * `.region` are free-text notes (see `packages/db/src/schema/
 * infrastructure.ts`'s own doc comment: "a denormalized note... No provider
 * adapter"); this registry resolves the common self-hosting providers'
 * region codes to a display label + lat/lon, entirely in Loxep code — no
 * migration, no coordinates column, no guessing.
 *
 * **A target whose `(provider, region)` is not in this table is never
 * placed.** `resolveRegionGeo` returns `null`, and the caller renders it in
 * the honest "Unplaced" list naming the exact provider/region string to fix
 * — never a best-effort guess, never IP geolocation (an external lookup and
 * a privacy leak, per the design's own rejected-alternatives list).
 *
 * ## The `home`/`lan` convention (PROVISIONAL — see this bead's report)
 *
 * The design calls for "a home/lan convention pinning to a configurable
 * 'home' marker". Every other row in this table is ALREADY exactly that
 * kind of "configurable": a plain exported code constant an operator edits
 * directly, because Loxep is a self-hosted, source-available product and
 * this registry is explicitly "REGION_GEO_REGISTRY in Loxep code", not a
 * database table (rule MAP1 rejects a coordinates column outright). {@link
 * HOME_MARKER} follows that same shape — a single named constant, `null` by
 * default. An operator whose `hosting_targets.provider` (or `.region`) is
 * literally `'home'` or `'lan'` places their home network on the map by
 * editing ONE constant in this file to their real coordinates; until they
 * do, `resolveRegionGeo` returns `null` for it and it lands in the honest
 * Unplaced list, exactly like any other unrecognized string — never a
 * guessed coordinate (Null Island, a country centroid, or any other
 * placeholder lat/lon would itself be a guess, which MAP1 forbids
 * outright). A live, in-app settings field for this is future work (it
 * would need a registered setting in `packages/domain`, out of this wave's
 * fence) — flagged in the design doc's implementation-status note.
 */

export interface RegionGeoEntry {
  lat: number;
  lon: number;
  /** Human display label — "Falkenstein, Germany (Hetzner fsn1)". */
  label: string;
}

/** `provider` (lowercased) -> `region` (lowercased) -> entry. Seeded with the design's named common self-host providers; coverage is deliberately partial — an unresolved region is an honest Unplaced entry, never a guess. */
export const REGION_GEO_REGISTRY: Record<string, Record<string, RegionGeoEntry>> = {
  hetzner: {
    fsn1: { lat: 50.4779, lon: 12.3713, label: 'Falkenstein, Germany (Hetzner fsn1)' },
    nbg1: { lat: 49.4468, lon: 11.0784, label: 'Nuremberg, Germany (Hetzner nbg1)' },
    hel1: { lat: 60.1699, lon: 24.9384, label: 'Helsinki, Finland (Hetzner hel1)' },
    ash: { lat: 39.0438, lon: -77.4874, label: 'Ashburn, Virginia (Hetzner ash)' },
    hil: { lat: 45.5228, lon: -122.9847, label: 'Hillsboro, Oregon (Hetzner hil)' },
    sin: { lat: 1.3521, lon: 103.8198, label: 'Singapore (Hetzner sin)' }
  },
  ovh: {
    gra: { lat: 50.9877, lon: 2.1291, label: 'Gravelines, France (OVH gra)' },
    sbg: { lat: 48.5734, lon: 7.7521, label: 'Strasbourg, France (OVH sbg)' },
    rbx: { lat: 50.6927, lon: 3.1746, label: 'Roubaix, France (OVH rbx)' },
    bhs: { lat: 45.3223, lon: -73.8697, label: 'Beauharnois, Canada (OVH bhs)' },
    waw: { lat: 52.2297, lon: 21.0122, label: 'Warsaw, Poland (OVH waw)' },
    lon: { lat: 51.5074, lon: -0.1278, label: 'London, United Kingdom (OVH lon)' },
    ynm: { lat: 42.6784, lon: -71.1512, label: 'Vint Hill, Virginia (OVH ynm)' }
  },
  digitalocean: {
    nyc1: { lat: 40.7128, lon: -74.006, label: 'New York (DigitalOcean nyc1)' },
    nyc3: { lat: 40.7128, lon: -74.006, label: 'New York (DigitalOcean nyc3)' },
    sfo2: { lat: 37.7749, lon: -122.4194, label: 'San Francisco (DigitalOcean sfo2)' },
    sfo3: { lat: 37.7749, lon: -122.4194, label: 'San Francisco (DigitalOcean sfo3)' },
    ams3: { lat: 52.3676, lon: 4.9041, label: 'Amsterdam (DigitalOcean ams3)' },
    sgp1: { lat: 1.3521, lon: 103.8198, label: 'Singapore (DigitalOcean sgp1)' },
    lon1: { lat: 51.5074, lon: -0.1278, label: 'London (DigitalOcean lon1)' },
    fra1: { lat: 50.1109, lon: 8.6821, label: 'Frankfurt (DigitalOcean fra1)' },
    tor1: { lat: 43.6532, lon: -79.3832, label: 'Toronto (DigitalOcean tor1)' },
    blr1: { lat: 12.9716, lon: 77.5946, label: 'Bangalore (DigitalOcean blr1)' },
    syd1: { lat: -33.8688, lon: 151.2093, label: 'Sydney (DigitalOcean syd1)' }
  },
  vultr: {
    ewr: { lat: 40.7357, lon: -74.1724, label: 'New Jersey (Vultr ewr)' },
    ord: { lat: 41.8781, lon: -87.6298, label: 'Chicago (Vultr ord)' },
    dfw: { lat: 32.7767, lon: -96.797, label: 'Dallas (Vultr dfw)' },
    sea: { lat: 47.6062, lon: -122.3321, label: 'Seattle (Vultr sea)' },
    lax: { lat: 34.0522, lon: -118.2437, label: 'Los Angeles (Vultr lax)' },
    atl: { lat: 33.749, lon: -84.388, label: 'Atlanta (Vultr atl)' },
    ams: { lat: 52.3676, lon: 4.9041, label: 'Amsterdam (Vultr ams)' },
    lhr: { lat: 51.5074, lon: -0.1278, label: 'London (Vultr lhr)' },
    fra: { lat: 50.1109, lon: 8.6821, label: 'Frankfurt (Vultr fra)' },
    cdg: { lat: 48.8566, lon: 2.3522, label: 'Paris (Vultr cdg)' },
    nrt: { lat: 35.6762, lon: 139.6503, label: 'Tokyo (Vultr nrt)' },
    sgp: { lat: 1.3521, lon: 103.8198, label: 'Singapore (Vultr sgp)' },
    syd: { lat: -33.8688, lon: 151.2093, label: 'Sydney (Vultr syd)' },
    yto: { lat: 43.6532, lon: -79.3832, label: 'Toronto (Vultr yto)' }
  },
  linode: {
    'us-east': { lat: 40.7357, lon: -74.1724, label: 'Newark (Linode us-east)' },
    'us-west': { lat: 37.5483, lon: -121.9886, label: 'Fremont (Linode us-west)' },
    'us-central': { lat: 32.7767, lon: -96.797, label: 'Dallas (Linode us-central)' },
    'us-southeast': { lat: 33.749, lon: -84.388, label: 'Atlanta (Linode us-southeast)' },
    'eu-west': { lat: 51.5074, lon: -0.1278, label: 'London (Linode eu-west)' },
    'eu-central': { lat: 50.1109, lon: 8.6821, label: 'Frankfurt (Linode eu-central)' },
    'ap-south': { lat: 1.3521, lon: 103.8198, label: 'Singapore (Linode ap-south)' },
    'ap-northeast': { lat: 35.6762, lon: 139.6503, label: 'Tokyo (Linode ap-northeast)' },
    'ap-southeast': { lat: -33.8688, lon: 151.2093, label: 'Sydney (Linode ap-southeast)' }
  },
  aws: {
    'us-east-1': { lat: 38.9587, lon: -77.3573, label: 'N. Virginia (AWS us-east-1)' },
    'us-east-2': { lat: 40.4173, lon: -82.9071, label: 'Ohio (AWS us-east-2)' },
    'us-west-1': { lat: 37.3541, lon: -121.9552, label: 'N. California (AWS us-west-1)' },
    'us-west-2': { lat: 45.8399, lon: -119.7006, label: 'Oregon (AWS us-west-2)' },
    'eu-west-1': { lat: 53.3498, lon: -6.2603, label: 'Ireland (AWS eu-west-1)' },
    'eu-west-2': { lat: 51.5074, lon: -0.1278, label: 'London (AWS eu-west-2)' },
    'eu-central-1': { lat: 50.1109, lon: 8.6821, label: 'Frankfurt (AWS eu-central-1)' },
    'ap-southeast-1': { lat: 1.3521, lon: 103.8198, label: 'Singapore (AWS ap-southeast-1)' },
    'ap-southeast-2': { lat: -33.8688, lon: 151.2093, label: 'Sydney (AWS ap-southeast-2)' },
    'ap-northeast-1': { lat: 35.6762, lon: 139.6503, label: 'Tokyo (AWS ap-northeast-1)' }
  },
  gcp: {
    'us-central1': { lat: 41.2619, lon: -95.8608, label: 'Iowa (GCP us-central1)' },
    'us-east1': { lat: 33.1959, lon: -80.0179, label: 'South Carolina (GCP us-east1)' },
    'us-west1': { lat: 45.5946, lon: -121.1787, label: 'Oregon (GCP us-west1)' },
    'europe-west1': { lat: 50.4477, lon: 3.8199, label: 'Belgium (GCP europe-west1)' },
    'europe-west4': { lat: 53.4386, lon: 6.8355, label: 'Netherlands (GCP europe-west4)' },
    'asia-east1': { lat: 24.0518, lon: 120.5161, label: 'Taiwan (GCP asia-east1)' },
    'asia-southeast1': { lat: 1.3521, lon: 103.8198, label: 'Singapore (GCP asia-southeast1)' }
  },
  azure: {
    eastus: { lat: 37.3719, lon: -79.8164, label: 'Virginia (Azure eastus)' },
    westus: { lat: 37.783, lon: -122.417, label: 'California (Azure westus)' },
    westeurope: { lat: 52.3676, lon: 4.9041, label: 'Netherlands (Azure westeurope)' },
    northeurope: { lat: 53.3498, lon: -6.2603, label: 'Ireland (Azure northeurope)' },
    southeastasia: { lat: 1.3521, lon: 103.8198, label: 'Singapore (Azure southeastasia)' }
  }
};

/** PROVISIONAL, `null` by default — see this file's module doc. Set to a real `{ lat, lon, label }` to place `provider`/`region` values of `'home'`/`'lan'` on the map. */
export const HOME_MARKER: RegionGeoEntry | null = null;

const HOME_KEYS = new Set(['home', 'lan']);

/** Normalizes and resolves `(provider, region)` to a display entry, or `null` when unresolved — the caller renders `null` as an "Unplaced" row naming the raw strings. Never guesses. */
export function resolveRegionGeo(
  provider: string | null,
  region: string | null
): RegionGeoEntry | null {
  const providerKey = provider?.trim().toLowerCase() ?? null;
  const regionKey = region?.trim().toLowerCase() ?? null;
  if (providerKey === null) return null;

  if (HOME_KEYS.has(providerKey) || (regionKey !== null && HOME_KEYS.has(regionKey))) {
    return HOME_MARKER;
  }

  const providerTable = REGION_GEO_REGISTRY[providerKey];
  if (providerTable === undefined || regionKey === null) return null;
  return providerTable[regionKey] ?? null;
}
