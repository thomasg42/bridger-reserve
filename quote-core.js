/* Bridger Reserve estimator logic with no DOM, so it can be tested in Node. */
import { DEFAULT_RATES, estimate, formatDollars } from "./fare.js";
import { MILES, MINUTES, PLACES } from "./places.js";

export const BOOKING_EMAIL = "BridgerReserve@gmail.com";
export const ROUTER = "https://router.project-osrm.org/route/v1/driving/";
export const GEOCODER = "https://photon.komoot.io/api/";
/* geocoder bias and bounds: southwest Montana, wide enough for Helena, Butte, and Billings */
export const AREA = { lat: 45.55, lon: -111.15 };
export const BBOX = "-114.2,44.0,-108.0,47.6";

const INDEX = new Map(PLACES.map((place, i) => [place.id, i]));
export const BZN = PLACES.find((place) => place.airport);

/* other words people type for the same place */
const ALIASES = {
  bzn: "airport bozeman airport gallatin field bozeman yellowstone international belgrade airport",
  downtown: "bozeman main street",
  msu: "montana state bobcat stadium",
  belgrade: "belgrade",
  bridger: "bridger bowl ski",
  hotsprings: "four corners hot springs",
  gateway: "gallatin gateway inn",
  bigskytown: "big sky meadow village town center",
  lonemtn: "lone mountain ranch big sky",
  mtnvillage: "big sky resort mountain village huntley summit",
  montage: "montage spanish peaks big sky",
  moonlight: "one and only one&only oneonly moonlight basin big sky",
  yc: "yellowstone club the club big sky",
  westy: "west yellowstone park west entrance",
  gardiner: "gardiner yellowstone park north entrance",
  livingston: "livingston",
  sage: "sage lodge paradise valley pray emigrant",
  chico: "chico hot springs pray paradise valley",
  ennis: "ennis madison",
};

export function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KEYS = new Map(PLACES.map((place) => [place.id, fold(`${place.name} ${place.short} ${ALIASES[place.id] || ""}`)]));

export function placeById(id) {
  const i = INDEX.get(id);
  return i === undefined ? null : PLACES[i];
}

export function placeEnd(id) {
  const place = placeById(id);
  if (!place) return null;
  return { kind: "place", id: place.id, label: place.name, short: place.short, lat: place.lat, lon: place.lon, airport: place.airport === true };
}

/** Places whose words contain every word typed, best first. An empty query lists them all. */
export function matchPlaces(query) {
  const q = fold(query);
  if (!q) return PLACES.slice();
  const words = q.split(" ");
  const scored = [];
  for (const place of PLACES) {
    const key = KEYS.get(place.id);
    if (!words.every((word) => key.includes(word))) continue;
    const name = fold(place.name);
    const score = name === q ? 0 : name.startsWith(q) ? 1 : fold(place.short).startsWith(q) ? 2 : key.startsWith(q) ? 3 : 4;
    scored.push([score, INDEX.get(place.id), place]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((entry) => entry[2]);
}

/** Exact name match, so a typed "Yellowstone Club" counts as the place. */
export function exactPlace(text) {
  const q = fold(text);
  if (!q) return null;
  return PLACES.find((place) => fold(place.name) === q || fold(place.short) === q) || null;
}

/** Road miles and minutes between two listed places, from the built table. */
export function pairFor(fromId, toId) {
  const i = INDEX.get(fromId);
  const j = INDEX.get(toId);
  if (i === undefined || j === undefined || i === j) return null;
  return { miles: MILES[i][j], minutes: MINUTES[i][j] };
}

export function metersBetween(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A typed point counts as the airport at the terminal, or when it is mapped as part of the airfield. */
export function isAirportPoint(lat, lon, osmKey = "") {
  const d = metersBetween(BZN, { lat, lon });
  return d <= 800 || (osmKey === "aeroway" && d <= 3000);
}

/** Turns a Photon result into a pickup or drop-off. */
export function addressEnd(feature) {
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return null;
  const [lon, lat] = feature.geometry.coordinates.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = feature.properties || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const town = p.city || p.town || p.village || p.district || p.county || "";
  let title = p.name || street || town;
  if (!title) return null;
  const detailParts = [];
  if (p.name && street && street !== p.name) detailParts.push(street);
  if (town && town !== title) detailParts.push(town);
  if (p.state && p.state !== "Montana") detailParts.push(p.state);
  const detail = detailParts.join(", ");
  title = String(title).trim();
  return {
    kind: "address",
    id: `${lat.toFixed(5)},${lon.toFixed(5)}`,
    label: detail ? `${title}, ${detail}` : title,
    title,
    detail,
    lat,
    lon,
    airport: isAirportPoint(lat, lon, p.osm_key),
  };
}

export function addressEnds(json) {
  const seen = new Set();
  const out = [];
  for (const feature of (json && json.features) || []) {
    const end = addressEnd(feature);
    if (!end || seen.has(end.label)) continue;
    seen.add(end.label);
    out.push(end);
  }
  return out;
}

export function geocodeUrl(query) {
  const params = new URLSearchParams({ q: query, lat: String(AREA.lat), lon: String(AREA.lon), limit: "6", lang: "en", bbox: BBOX });
  return `${GEOCODER}?${params}`;
}

export function routeUrl(a, b) {
  return `${ROUTER}${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}?overview=false`;
}

/** OSRM answer to the same rounding the place table uses: tenths of a mile, whole minutes. */
export function routeFromOsrm(json) {
  const route = json && json.code === "Ok" && Array.isArray(json.routes) ? json.routes[0] : null;
  if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null;
  return { miles: Math.round(route.distance / 160.9344) / 10, minutes: Math.round(route.duration / 60) };
}

export function sameEnd(a, b) {
  if (!a || !b) return false;
  if (a.kind === "place" && b.kind === "place") return a.id === b.id;
  return metersBetween(a, b) < 150;
}

/** The whole priced trip, ready to draw. */
export function priceTrip(from, to, route, rates = DEFAULT_RATES) {
  const airportPickup = Boolean(from && from.airport);
  const airportDropoff = Boolean(to && to.airport);
  const e = estimate({ miles: route.miles, minutes: route.minutes, airportPickup }, rates);
  const lines = [{ id: "trip", label: "Trip, pickup to drop-off", cents: e.tripCents }];
  if (airportPickup || airportDropoff) lines.push({ id: "airport", label: "Airport pickup fee, Bridger Reserve", cents: e.airportCents });
  return {
    ...e,
    airportPickup,
    airportDropoff,
    lines,
    deposit: [
      { id: "deposit", label: `Deposit to book, ${rates.depositPercent}%`, cents: e.depositCents },
      { id: "balance", label: "Remaining balance", cents: e.balanceCents },
    ],
  };
}

export function shortName(end) {
  if (!end) return "";
  return end.kind === "place" ? end.short : end.title;
}

export function minutesText(minutes) {
  if (minutes < 60) return `about ${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `about ${h} hr${m ? ` ${m} min` : ""}`;
}

/** The email the guest sends to book. Plain text, every number spelled out. */
export function bookingEmail({ from, to, route, priced, when, name, phone, flight }) {
  const lines = [
    "Bridger Reserve booking request",
    "",
    `Pickup: ${from.label}`,
    `Drop-off: ${to.label}`,
    `When: ${when || "(please add)"}`,
    `Name: ${name || "(please add)"}`,
  ];
  if (phone) lines.push(`Phone: ${phone}`);
  if (priced.airportPickup) lines.push(`Flight number: ${flight || "(please add)"}`);
  lines.push(
    `Route: ${route.miles} miles, ${minutesText(route.minutes)}`,
    "",
    ...priced.lines.map((line) => `${line.label}: ${formatDollars(line.cents)}`),
    `Estimated total: ${formatDollars(priced.totalCents)}`,
    ...priced.deposit.map((line) => `${line.label}: ${formatDollars(line.cents)}`),
    "",
    `I understand the ${formatDollars(priced.depositCents)} deposit confirms my booking, applies toward my fare, and is not refunded if I cancel.`,
    "",
    "This is an estimate, not a fixed fare. The final fare follows the actual trip and can change with added stops, waiting, a route change, weather, or traffic.",
    "The car is not held until Terry or Max reply.",
  );
  const subject = `Booking request: ${shortName(from)} to ${shortName(to)}${when ? `, ${when}` : ""}`;
  return {
    subject,
    body: lines.join("\n"),
    href: `mailto:${BOOKING_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`,
  };
}

/** "Fri, Dec 18, 2026 at 2:30 PM" from the date and time inputs, in the guest's own words. */
export function whenText(dateValue, timeValue) {
  if (!dateValue || !timeValue) return "";
  const [y, mo, d] = dateValue.split("-").map(Number);
  const [h, mi] = timeValue.split(":").map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return "";
  const date = new Date(y, mo - 1, d, h, mi);
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}
