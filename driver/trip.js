/* Bridger Reserve driver trip: the state machine, GPS filtering, and records. No DOM, so it is tested in Node. */
import { DEFAULT_RATES, formatDollars, meterFare } from "../fare.js";
import { metersBetween } from "../quote-core.js";

export const GPS = Object.freeze({
  maxAccuracy: 65, // metres; worse fixes are ignored
  minStep: 8, // metres; smaller moves are parked-car jitter
  maxSpeed: 60, // metres a second (134 mph); faster is a glitch
  gapSeconds: 45, // no usable fix for this long while moving is a gap
  gapMinMeters: 200,
  roadFactor: 1.25, // straight line to road miles, only until the road route is known
});

export const STOP = Object.freeze({
  pickupMeters: 320, // the first wait is the pickup if the car has not left it
  sameStopMeters: 300, // a wait this close to the last one is the same stop: its grace is not renewed
  sameStopSeconds: 180, // the same rule by time when there is no GPS at all
});

const round1 = (n) => Math.round(n * 10) / 10;

export function makeId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `t${now.toString(36)}${rand}`;
}

export function newTrip({ customer = "", airportPickup = false, depositPaidCents = 0, now = Date.now(), id } = {}) {
  return {
    id: id || makeId(now),
    status: "active",
    customer: String(customer || "").trim(),
    airportPickup: Boolean(airportPickup),
    depositPaidCents: Math.max(0, Math.round(Number(depositPaidCents) || 0)),
    startedAt: now,
    endedAt: null,
    stops: [],
    waits: [],
    meters: 0,
    gps: { fixes: 0, last: null, lastSeen: null },
    gaps: [],
    adjust: {},
    notes: "",
    final: null,
    updatedAt: now,
  };
}

export function openWait(trip) {
  const w = trip.waits[trip.waits.length - 1];
  return w && !Number.isFinite(w.end) ? w : null;
}

/** Start Wait. The first wait before the car leaves is the pickup; a wait near the last one keeps that stop's grace. */
export function startWait(trip, now = Date.now()) {
  if (trip.status !== "active" || openWait(trip)) return trip;
  const last = trip.waits[trip.waits.length - 1];
  let stop = trip.stops[trip.stops.length - 1];
  let same = false;
  if (stop && last) {
    same = trip.gps.fixes > 0 ? trip.meters - (last.metersAtEnd ?? trip.meters) < STOP.sameStopMeters : now - last.end < STOP.sameStopSeconds * 1000;
  }
  if (!stop || !same) {
    const kind = trip.stops.length === 0 && trip.meters < STOP.pickupMeters ? "pickup" : "stop";
    stop = { id: trip.stops.length + 1, kind };
    trip.stops.push(stop);
  }
  trip.waits.push({ stop: stop.id, start: now, end: null });
  trip.updatedAt = now;
  return trip;
}

/** The driver says this wait is somewhere new: the whole open wait moves to a fresh stop with its own grace. */
export function makeNewStop(trip, now = Date.now()) {
  const w = openWait(trip);
  if (!w) return trip;
  const current = trip.stops.find((s) => s.id === w.stop);
  const otherWaits = trip.waits.filter((x) => x !== w && x.stop === w.stop);
  if (current && otherWaits.length === 0) {
    // only this wait used the stop, so it already has a full grace period of its own
    if (current.kind === "pickup") current.kind = "stop";
    trip.updatedAt = now;
    return trip;
  }
  const stop = { id: trip.stops.length + 1, kind: "stop" };
  trip.stops.push(stop);
  w.stop = stop.id;
  trip.updatedAt = now;
  return trip;
}

export function resumeTrip(trip, now = Date.now()) {
  const w = openWait(trip);
  if (w) {
    w.end = Math.max(w.start, now);
    w.metersAtEnd = trip.meters;
    trip.updatedAt = now;
  }
  return trip;
}

export function endTrip(trip, now = Date.now()) {
  if (trip.status !== "active") return trip;
  resumeTrip(trip, now);
  trip.endedAt = now;
  trip.status = "review";
  trip.updatedAt = now;
  return trip;
}

/** End Trip pressed by mistake: the meter keeps running from the original start. */
export function reopenTrip(trip, now = Date.now()) {
  if (trip.status !== "review") return trip;
  trip.status = "active";
  trip.endedAt = null;
  trip.updatedAt = now;
  return trip;
}

export function finalizeTrip(trip, rates = DEFAULT_RATES, now = Date.now()) {
  if (trip.status !== "review") return trip;
  const m = meterFare(trip, rates, now);
  trip.final = {
    at: now,
    rates: { ...rates },
    miles: round1(m.miles),
    driveMinutes: round1(m.driveMinutes),
    waitMinutes: round1(m.waitMinutes),
    baseCents: m.baseCents,
    driveCents: m.driveCents,
    mileCents: m.mileCents,
    waitCents: m.waitCents,
    airportCents: m.airportCents,
    totalCents: m.totalCents,
    depositPaidCents: m.depositPaidCents,
    balanceCents: m.balanceCents,
  };
  trip.status = "final";
  trip.updatedAt = now;
  return trip;
}

export function discardTrip(trip, now = Date.now()) {
  trip.status = "discarded";
  trip.updatedAt = now;
  return trip;
}

/**
 * One GPS fix. Returns { accepted, reason?, gap? }.
 * Jitter never moves the anchor, so a creeping car still adds up; a long silence over distance becomes a flagged gap.
 */
export function applyFix(trip, fix) {
  if (trip.status !== "active") return { accepted: false, reason: "not-running" };
  const t = Number(fix.t);
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(t)) return { accepted: false, reason: "bad" };
  trip.gps.lastSeen = t;
  if (!(fix.accuracy <= GPS.maxAccuracy)) return { accepted: false, reason: "accuracy" };
  const point = { lat: fix.lat, lon: fix.lon, t, accuracy: fix.accuracy };
  const last = trip.gps.last;
  if (!last) {
    trip.gps.last = point;
    trip.gps.fixes += 1;
    return { accepted: true };
  }
  const dt = (t - last.t) / 1000;
  if (dt <= 0) return { accepted: false, reason: "old" };
  const d = metersBetween(last, point);
  if (d / dt > GPS.maxSpeed) return { accepted: false, reason: "jump" };
  if (dt >= GPS.gapSeconds && d >= GPS.gapMinMeters) {
    const counted = d * GPS.roadFactor;
    const gap = { id: trip.gaps.length + 1, from: { lat: last.lat, lon: last.lon }, to: { lat: point.lat, lon: point.lon }, start: last.t, end: t, straight: Math.round(d), counted: Math.round(counted), road: null, status: "pending" };
    trip.gaps.push(gap);
    trip.meters += gap.counted;
    trip.gps.last = point;
    trip.gps.fixes += 1;
    trip.updatedAt = t;
    return { accepted: true, gap };
  }
  if (d < Math.max(GPS.minStep, point.accuracy * 0.5)) return { accepted: false, reason: "jitter" };
  trip.meters += d;
  trip.gps.last = point;
  trip.gps.fixes += 1;
  trip.updatedAt = t;
  return { accepted: true };
}

/** The road route for a gap came back: swap the straight-line guess for it. */
export function settleGap(trip, gapId, roadMeters, now = Date.now()) {
  const gap = trip.gaps.find((g) => g.id === gapId);
  if (!gap || gap.status === "routed" || !(roadMeters >= 0)) return trip;
  trip.meters += Math.round(roadMeters) - gap.counted;
  gap.road = Math.round(roadMeters);
  gap.counted = gap.road;
  gap.status = "routed";
  trip.updatedAt = now;
  return trip;
}

export function flagsFor(trip) {
  const flags = [];
  if (trip.gps.fixes === 0) flags.push("No GPS fixes were recorded. Enter the miles from the odometer or the route.");
  for (const gap of trip.gaps) {
    const minutes = Math.max(1, Math.round((gap.end - gap.start) / 60000));
    const miles = (gap.counted / 1609.344).toFixed(1);
    flags.push(
      gap.status === "routed"
        ? `GPS gap of ${minutes} min (screen off or another app open). Filled with the road route: ${miles} mi. Check the miles.`
        : `GPS gap of ${minutes} min with no road route yet. Estimated ${miles} mi from a straight line. Check the miles.`,
    );
  }
  return flags;
}

/** Sync merge: a final record is never replaced by a running copy; otherwise the newer edit wins. */
export function mergeTrip(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const rank = (t) => (t.status === "final" || t.status === "discarded" ? 1 : 0);
  if (rank(local) !== rank(remote)) return rank(local) > rank(remote) ? local : remote;
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // never let a spreadsheet run a formula from a name or note
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function clock(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function tripsCsv(trips) {
  const head = ["Start", "End", "Customer", "Miles", "Driving minutes", "Billed waiting minutes", "Base", "Driving time", "Mileage", "Waiting", "Airport pickup fee", "Final fare", "Deposit received", "Balance", "GPS gaps", "Notes", "Trip ID"];
  const rows = trips
    .filter((t) => t.status === "final" && t.final)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => {
      const f = t.final;
      return [clock(t.startedAt), clock(t.endedAt), t.customer, f.miles, f.driveMinutes, f.waitMinutes, formatDollars(f.baseCents), formatDollars(f.driveCents), formatDollars(f.mileCents), formatDollars(f.waitCents), formatDollars(f.airportCents), formatDollars(f.totalCents), formatDollars(f.depositPaidCents), formatDollars(f.balanceCents), t.gaps.length, t.notes, t.id];
    });
  return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
