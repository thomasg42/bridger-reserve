/** Bridger Reserve trip charge, in cents. Rates are used as given. */

export const RATES = {
  baseCents: 2000,
  driveCentsPerMinute: 95,
  mileCents: 150,
  airportPickupCents: 1500,
  replaceCentsPerMinute: 130,
  includedWaitMinutes: 5,
};

function units(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function centsFor(amount, rate) {
  return Math.round(amount * rate);
}

export function formatDollars(cents) {
  const n = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}

export function quote(input = {}) {
  const driveMinutes = units(input.driveMinutes);
  const slowMinutes = units(input.slowMinutes);
  const miles = units(input.miles);
  const waitMinutes = units(input.waitMinutes);
  const stopMinutes = units(input.stopMinutes);
  const positionMinutes = units(input.positionMinutes);
  const positionMiles = units(input.positionMiles);
  const airport = input.airportPickup === true;

  const billableWait = Math.max(0, waitMinutes - RATES.includedWaitMinutes);
  const baseCents = RATES.baseCents;
  const driveCents = centsFor(driveMinutes, RATES.driveCentsPerMinute);
  const slowCents = centsFor(slowMinutes, RATES.replaceCentsPerMinute);
  const mileCents = centsFor(miles, RATES.mileCents);
  const airportCents = airport ? RATES.airportPickupCents : 0;
  const waitCents = centsFor(billableWait, RATES.replaceCentsPerMinute);
  const stopCents = centsFor(stopMinutes, RATES.replaceCentsPerMinute);
  const positionDriveCents = centsFor(positionMinutes, RATES.driveCentsPerMinute);
  const positionMileCents = centsFor(positionMiles, RATES.mileCents);
  const positionCents = positionDriveCents + positionMileCents;
  const totalCents =
    baseCents +
    driveCents +
    slowCents +
    mileCents +
    airportCents +
    waitCents +
    stopCents +
    positionCents;

  return {
    baseCents,
    driveCents,
    slowCents,
    mileCents,
    airportCents,
    waitCents,
    stopCents,
    positionDriveCents,
    positionMileCents,
    positionCents,
    totalCents,
    lines: [
      { id: "base", label: "Base fare", cents: baseCents },
      { id: "drive", label: "Driving time", cents: driveCents },
      { id: "miles", label: "Mileage", cents: mileCents },
      { id: "airport", label: "Airport pickup fee, Bridger Reserve", cents: airportCents },
      { id: "wait", label: "Waiting", cents: waitCents },
      { id: "stop", label: "Requested stop", cents: stopCents },
      { id: "slow", label: "Slow or crawling traffic", cents: slowCents },
      { id: "position", label: "Empty travel", cents: positionCents },
    ],
  };
}
