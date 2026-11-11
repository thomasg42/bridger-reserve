/**
 * Bridger Reserve fare engine, in cents. One module for the public estimate and the driver meter.
 *
 * The page never prints these rates. Guests see the estimated total, the fees, and the deposit.
 * Rules (Max Smith, 2026-11-10):
 * - Trip = base fare once + driving time + miles. Time keeps running in traffic; there is no slow-traffic surcharge.
 * - Airport pickup fee, Bridger Reserve's own, only when the pickup is at BZN.
 * - Waiting is started by hand. Each pickup or stop gets one grace period (15 minutes for an airport pickup,
 *   otherwise 5), then the waiting rate by the second. Regular time billing pauses while waiting.
 * - Deposit to book = 25% of the total, rounded up to the nearest $5. It applies toward the fare.
 */

export const DEFAULT_RATES = Object.freeze({
  baseCents: 2000,
  driveCentsPerMinute: 95,
  mileCents: 150,
  airportPickupCents: 1500,
  waitCentsPerMinute: 130,
  includedWaitMinutes: 5,
  airportIncludedWaitMinutes: 15,
  depositPercent: 25,
  depositRoundCents: 500,
});

/** The numbers the driver app may edit, with the limits its settings screen enforces. */
export const RATE_FIELDS = [
  { key: "baseCents", label: "Base fare", unit: "$", cents: true, min: 0, max: 50000 },
  { key: "driveCentsPerMinute", label: "Driving time, per minute", unit: "$", cents: true, min: 0, max: 2000 },
  { key: "mileCents", label: "Mileage, per mile", unit: "$", cents: true, min: 0, max: 2000 },
  { key: "airportPickupCents", label: "Airport pickup fee", unit: "$", cents: true, min: 0, max: 20000 },
  { key: "waitCentsPerMinute", label: "Waiting, per minute after the grace period", unit: "$", cents: true, min: 0, max: 2000 },
  { key: "includedWaitMinutes", label: "Grace period at a pickup or stop", unit: "min", min: 0, max: 120 },
  { key: "airportIncludedWaitMinutes", label: "Grace period at an airport pickup", unit: "min", min: 0, max: 180 },
  { key: "depositPercent", label: "Deposit to book", unit: "%", min: 0, max: 100 },
];

/** Accepts a partial or untrusted rate object and returns a complete, sane one. */
export function cleanRates(input) {
  const out = { ...DEFAULT_RATES };
  if (!input || typeof input !== "object") return out;
  for (const field of RATE_FIELDS) {
    const n = Number(input[field.key]);
    if (Number.isFinite(n) && n >= field.min && n <= field.max) out[field.key] = Math.round(n);
  }
  return out;
}

function units(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function formatDollars(cents) {
  const n = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}

/** 25% of the total, rounded up to the nearest $5. Integer math, so $172.25 gives exactly $45. */
export function depositFor(totalCents, rates = DEFAULT_RATES) {
  const total = Math.max(0, Math.round(units(totalCents)));
  if (total === 0 || rates.depositPercent <= 0) return 0;
  const step = rates.depositRoundCents || 500;
  return Math.ceil((total * rates.depositPercent) / (100 * step)) * step;
}

/** Base + time + miles for a known distance and drive time. */
export function tripCents(miles, minutes, rates = DEFAULT_RATES) {
  return rates.baseCents + Math.round(units(minutes) * rates.driveCentsPerMinute) + Math.round(units(miles) * rates.mileCents);
}

/** The public estimate: what a guest sees before booking. */
export function estimate({ miles, minutes, airportPickup = false } = {}, rates = DEFAULT_RATES) {
  const m = units(miles);
  const t = units(minutes);
  const trip = tripCents(m, t, rates);
  const airportCents = airportPickup === true ? rates.airportPickupCents : 0;
  const totalCents = trip + airportCents;
  const depositCents = depositFor(totalCents, rates);
  return {
    miles: m,
    minutes: t,
    tripCents: trip,
    airportCents,
    totalCents,
    depositCents,
    balanceCents: totalCents - depositCents,
  };
}

/** Seconds of each wait, grouped by stop, clipped to the trip. */
export function waitSecondsByStop(waits = [], endMs) {
  const byStop = new Map();
  for (const w of waits) {
    if (!w || !Number.isFinite(w.start)) continue;
    const end = Math.min(Number.isFinite(w.end) ? w.end : endMs, endMs);
    const seconds = Math.max(0, (end - w.start) / 1000);
    byStop.set(w.stop, (byStop.get(w.stop) || 0) + seconds);
  }
  return byStop;
}

/**
 * The driver meter. Pure: give it the trip record and a clock, get every line back.
 * trip = { startedAt, endedAt?, meters, airportPickup, stops: [{ id, kind: "pickup" | "stop" }], waits: [{ stop, start, end? }],
 *          adjust?: { miles?, driveMinutes?, waitMinutes?, airportPickup? }, depositPaidCents? }
 */
export function meterFare(trip, rates = DEFAULT_RATES, nowMs = Date.now()) {
  const start = Number(trip.startedAt);
  const end = Number.isFinite(trip.endedAt) ? trip.endedAt : nowMs;
  const elapsedSeconds = Math.max(0, (end - start) / 1000);
  const adjust = trip.adjust || {};
  const airportPickup = typeof adjust.airportPickup === "boolean" ? adjust.airportPickup : trip.airportPickup === true;

  const byStop = waitSecondsByStop(trip.waits || [], end);
  const stops = (trip.stops || []).map((stop) => {
    const waitedSeconds = byStop.get(stop.id) || 0;
    const airportGrace = stop.kind === "pickup" && airportPickup;
    const graceMinutes = airportGrace ? rates.airportIncludedWaitMinutes : rates.includedWaitMinutes;
    const billableSeconds = Math.max(0, waitedSeconds - graceMinutes * 60);
    return { id: stop.id, kind: stop.kind, airport: airportGrace, waitedSeconds, graceMinutes, billableSeconds };
  });
  const waitedSeconds = stops.reduce((sum, s) => sum + s.waitedSeconds, 0);
  const trackedBillableWaitSeconds = stops.reduce((sum, s) => sum + s.billableSeconds, 0);
  const trackedDriveSeconds = Math.max(0, elapsedSeconds - waitedSeconds);
  const trackedMiles = units(trip.meters) / 1609.344;

  const miles = adjust.miles != null && Number.isFinite(Number(adjust.miles)) ? units(adjust.miles) : trackedMiles;
  const driveMinutes = adjust.driveMinutes != null && Number.isFinite(Number(adjust.driveMinutes)) ? units(adjust.driveMinutes) : trackedDriveSeconds / 60;
  const waitMinutes = adjust.waitMinutes != null && Number.isFinite(Number(adjust.waitMinutes)) ? units(adjust.waitMinutes) : trackedBillableWaitSeconds / 60;

  const baseCents = rates.baseCents;
  const driveCents = Math.round(driveMinutes * rates.driveCentsPerMinute);
  const mileCents = Math.round(miles * rates.mileCents);
  const waitCents = Math.round(waitMinutes * rates.waitCentsPerMinute);
  const airportCents = airportPickup ? rates.airportPickupCents : 0;
  const totalCents = baseCents + driveCents + mileCents + waitCents + airportCents;
  const depositPaidCents = Math.max(0, Math.round(units(trip.depositPaidCents)));

  return {
    elapsedSeconds,
    waitedSeconds,
    trackedDriveSeconds,
    trackedBillableWaitSeconds,
    trackedMiles,
    miles,
    driveMinutes,
    waitMinutes,
    stops,
    airportPickup,
    baseCents,
    driveCents,
    mileCents,
    waitCents,
    airportCents,
    totalCents,
    depositPaidCents,
    balanceCents: totalCents - depositPaidCents,
    lines: [
      { id: "base", label: "Base fare", cents: baseCents },
      { id: "drive", label: "Driving time", cents: driveCents },
      { id: "miles", label: "Mileage", cents: mileCents },
      { id: "wait", label: "Waiting after the grace period", cents: waitCents },
      { id: "airport", label: "Airport pickup fee", cents: airportCents },
    ],
  };
}
