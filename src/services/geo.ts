/**
 * Nearest police station lookup using OpenStreetMap (Nominatim + Overpass).
 * Falls back to a small offline list for Bengaluru when offline or on error.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Place {
  name: string;
  lat: number;
  lon: number;
  address?: string;
  phone?: string;
  distanceKm?: number;
}

export interface StationLookup {
  query: string;
  origin: { lat: number; lon: number; label: string };
  stations: Place[];
  source: "openstreetmap" | "offline";
  emergencyNumbers: { police: string; cyberFraud: string };
}

const USER_AGENT = "sarva-rakshak-demo/0.1 (hackathon prototype)";

export const OFFLINE_BENGALURU: Place[] = [
  { name: "Upparpet Police Station", lat: 12.9771, lon: 77.5713, address: "Gandhinagar, near Kempegowda Bus Station (Majestic)" },
  { name: "City Market Police Station", lat: 12.9656, lon: 77.5779, address: "Avenue Road, KR Market" },
  { name: "Cubbon Park Police Station", lat: 12.9763, lon: 77.5929, address: "Kasturba Road" },
  { name: "Halasuru Gate Police Station", lat: 12.9698, lon: 77.5846, address: "Nrupathunga Road" },
  { name: "Koramangala Police Station", lat: 12.9352, lon: 77.6245, address: "80 Feet Road, Koramangala" },
  { name: "Indiranagar Police Station", lat: 12.9719, lon: 77.6412, address: "HAL 2nd Stage, Indiranagar" },
  { name: "Whitefield Police Station", lat: 12.9698, lon: 77.7500, address: "Whitefield Main Road" },
];

const OFFLINE_LANDMARKS: Record<string, { lat: number; lon: number }> = {
  majestic: { lat: 12.9767, lon: 77.5713 },
  "kempegowda bus station": { lat: 12.9767, lon: 77.5713 },
  "mg road": { lat: 12.9756, lon: 77.6066 },
  koramangala: { lat: 12.9352, lon: 77.6245 },
  indiranagar: { lat: 12.9719, lon: 77.6412 },
  whitefield: { lat: 12.9698, lon: 77.75 },
  "kr market": { lat: 12.9656, lon: 77.5779 },
};

const EMERGENCY = { police: "112", cyberFraud: "1930" };

export const OVERPASS_ENDPOINTS = ["https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter"];

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

function withDistances(origin: { lat: number; lon: number }, places: Place[], limit: number): Place[] {
  return places
    .map((p) => ({ ...p, distanceKm: haversineKm(origin, p) }))
    .sort((a, b) => a.distanceKm! - b.distanceKm!)
    .slice(0, limit);
}

export function offlineLookup(query: string, limit = 3): StationLookup {
  const q = query.toLowerCase();
  const key = Object.keys(OFFLINE_LANDMARKS).find((k) => q.includes(k));
  const origin = key ? OFFLINE_LANDMARKS[key] : OFFLINE_LANDMARKS.majestic;
  return {
    query,
    origin: { ...origin, label: key ?? "Bengaluru (default: Majestic)" },
    stations: withDistances(origin, OFFLINE_BENGALURU, limit),
    source: "offline",
    emergencyNumbers: EMERGENCY,
  };
}

export class GeoService {
  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly mode: "live" | "offline" = "live",
    private readonly timeoutMs = 6000,
  ) {}

  private async getJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  async nearestPoliceStations(locationText: string, limit = 3): Promise<StationLookup> {
    if (this.mode === "offline") return offlineLookup(locationText, limit);
    let geo: Array<{ lat: string; lon: string; display_name: string }>;
    try {
      const q = /bengaluru|bangalore/i.test(locationText) ? locationText : `${locationText}, Bengaluru`;
      geo = (await this.getJson(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`,
      )) as typeof geo;
    } catch {
      return offlineLookup(locationText, limit);
    }
    if (!geo.length) return offlineLookup(locationText, limit);
    const origin = { lat: Number(geo[0].lat), lon: Number(geo[0].lon) };

    // Overpass mirrors first (precise amenity=police), then Nominatim's bounded search, then offline.
    let places: Place[] = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
      places = await this.overpass(endpoint, origin).catch(() => []);
      if (places.length) break;
    }
    if (!places.length) places = await this.nominatimPolice(origin).catch(() => []);
    if (!places.length) return offlineLookup(locationText, limit);
    return {
      query: locationText,
      origin: { ...origin, label: geo[0].display_name },
      stations: withDistances(origin, places, limit),
      source: "openstreetmap",
      emergencyNumbers: EMERGENCY,
    };
  }

  private async overpass(endpoint: string, origin: { lat: number; lon: number }): Promise<Place[]> {
    const query = `[out:json][timeout:6];nwr(around:4000,${origin.lat},${origin.lon})[amenity=police];out center 15;`;
    const data = (await this.getJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    })) as { elements: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> };
    return data.elements
      .map((e): Place | null => {
        const lat = e.lat ?? e.center?.lat;
        const lon = e.lon ?? e.center?.lon;
        if (lat == null || lon == null) return null;
        const t = e.tags ?? {};
        return {
          name: t.name || t["name:en"] || "Police Station",
          lat,
          lon,
          address: [t["addr:street"], t["addr:suburb"] ?? t["addr:city"]].filter(Boolean).join(", ") || undefined,
          phone: t.phone || t["contact:phone"],
        };
      })
      .filter((p): p is Place => p !== null);
  }

  private async nominatimPolice(origin: { lat: number; lon: number }): Promise<Place[]> {
    const d = 0.04;
    const viewbox = [origin.lon - d, origin.lat + d, origin.lon + d, origin.lat - d].join(",");
    const rows = (await this.getJson(
      `https://nominatim.openstreetmap.org/search?format=json&limit=15&q=police&bounded=1&viewbox=${viewbox}`,
    )) as Array<{ lat: string; lon: string; name?: string; display_name: string; type?: string }>;
    return rows
      .filter((r) => /police station/i.test(r.name ?? r.display_name) && !/traffic/i.test(r.name ?? ""))
      .map((r) => ({ name: r.name || r.display_name.split(",")[0], lat: Number(r.lat), lon: Number(r.lon), address: r.display_name.split(",").slice(1, 3).join(",").trim() }));
  }
}
