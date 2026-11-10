import { formatDollars, quote } from "./fare.js";

// Illustrative miles and minutes from the fare sheet. Any other pair is entered by the guest.
const PAIRS = {
  "bzn|hotel": [10, 20],
  "bzn|bigsky": [55, 80],
  "bzn|moon": [60, 90],
  "moon|bzn": [60, 90],
};

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector) => document.querySelector(selector);
const pickup = $("#pickup");
const arrival = $("#arrival");
const miles = $("#miles");
const minutes = $("#minutes");
const airport = $("#airport");
const wait = $("#wait");
const stop = $("#stop");
const slow = $("#slow");
const emptyMiles = $("#empty-miles");
const emptyMinutes = $("#empty-minutes");
const lines = $("#lines");
const total = $("#total");
const totalVisual = $(".total-visual");
const email = $("#email");
const status = $("#quote-status");
const pairHint = $("#pair-hint");
const clubNote = $("#club-note");
const airportLock = $("#airport-lock");
const routeLabel = $("#receipt-route");
const swap = $("#swap");
const chips = [...document.querySelectorAll(".chip[data-pair]")];

const SHORT = {
  bzn: "BZN",
  hotel: "Downtown Bozeman",
  bigsky: "Big Sky",
  moon: "Moonlight Basin",
  club: "Yellowstone Club",
  other: "Another address",
};

function optional(el) {
  if (el.value.trim() === "") return 0;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function required(el) {
  if (el.value.trim() === "") return null;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function placeLabel(select) {
  return select.selectedOptions[0].textContent;
}

/* the total rolls to its new value */
let shownCents = null;
let tween = 0;
function showTotal(cents) {
  cancelAnimationFrame(tween);
  if (cents === null) {
    shownCents = null;
    totalVisual.textContent = "";
    return;
  }
  const from = shownCents === null ? cents : shownCents;
  shownCents = cents;
  if (reduce || from === cents) {
    totalVisual.textContent = formatDollars(cents);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 420);
    const eased = 1 - (1 - p) ** 3;
    totalVisual.textContent = formatDollars(Math.round(from + (cents - from) * eased));
    if (p < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

const previous = new Map();
function drawLines(q) {
  const rows = q.lines.map((line) => {
    const row = document.createElement("div");
    const name = document.createElement("dt");
    const amount = document.createElement("dd");
    name.textContent = line.label;
    amount.textContent = formatDollars(line.cents);
    if (line.cents === 0) row.classList.add("is-zero");
    if (previous.has(line.id) && previous.get(line.id) !== line.cents && !reduce) amount.classList.add("is-changed");
    previous.set(line.id, line.cents);
    row.append(name, amount);
    return row;
  });
  lines.replaceChildren(...rows);
}

function syncChips() {
  const key = `${pickup.value}|${arrival.value}`;
  const known = PAIRS[key];
  for (const chip of chips) {
    const on = chip.dataset.pair === key && known && Number(miles.value) === known[0] && Number(minutes.value) === known[1];
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  }
  routeLabel.textContent = `${SHORT[pickup.value]} to ${SHORT[arrival.value]}`;
}

function render() {
  const known = PAIRS[`${pickup.value}|${arrival.value}`];
  pairHint.hidden = !known;
  clubNote.hidden = pickup.value !== "club" && arrival.value !== "club";
  syncChips();

  const fields = [miles, minutes, wait, stop, slow, emptyMiles, emptyMinutes];
  const negative = fields.some((el) => el.value.trim() !== "" && Number(el.value) < 0);
  const tripMiles = required(miles);
  const tripMinutes = required(minutes);
  const extras = [wait, stop, slow, emptyMiles, emptyMinutes].map(optional);
  const ready = !negative && tripMiles !== null && tripMinutes !== null && extras.every((n) => n !== null);

  if (!ready) {
    lines.replaceChildren();
    previous.clear();
    total.textContent = "";
    showTotal(null);
    status.textContent = negative ? "Use zero or more." : "Enter miles and minutes.";
    email.disabled = true;
    email.onclick = null;
    return;
  }

  const [waitMinutes, stopMinutes, slowMinutes, positionMiles, positionMinutes] = extras;
  const q = quote({
    miles: tripMiles,
    driveMinutes: tripMinutes,
    airportPickup: airport.checked,
    waitMinutes,
    stopMinutes,
    slowMinutes,
    positionMiles,
    positionMinutes,
  });

  drawLines(q);
  total.textContent = `Trip charge ${formatDollars(q.totalCents)}`;
  showTotal(q.totalCents);
  status.textContent = "The trip charge is the lines above. The car is not held until Terry or Max reply.";

  const body = [
    "Bridger Reserve quote",
    "This is an estimate, not a confirmed car.",
    "",
    `Pickup: ${placeLabel(pickup)}`,
    `Arrival: ${placeLabel(arrival)}`,
    `Miles: ${tripMiles}`,
    `Driving minutes: ${tripMinutes}`,
    "",
    ...q.lines.map((line) => `${line.label}: ${formatDollars(line.cents)}`),
    "",
    `Trip charge: ${formatDollars(q.totalCents)}`,
    "",
    "The trip charge is the lines above.",
    "Waiting and slow traffic use $1.30 a minute in place of the $0.95 driving rate, only as entered.",
    "Empty travel is included only as entered.",
    "The airport pickup fee is charged by Bridger Reserve when the pickup is at BZN.",
    "Gratuity and tax are not added here.",
    "The car is not held until Terry or Max reply.",
  ].join("\n");
  const href = `mailto:BridgerReserve@gmail.com?subject=${encodeURIComponent("Bridger Reserve quote")}&body=${encodeURIComponent(body)}`;
  email.disabled = false;
  email.onclick = () => {
    window.location.href = href;
  };
}

function applyPair() {
  const pair = PAIRS[`${pickup.value}|${arrival.value}`];
  if (pair) {
    miles.value = String(pair[0]);
    minutes.value = String(pair[1]);
  } else {
    miles.value = "";
    minutes.value = "";
  }
  render();
}

function syncAirport() {
  if (pickup.value === "bzn") {
    airport.checked = true;
    airport.disabled = true;
    airportLock.hidden = false;
  } else if (airport.disabled) {
    airport.disabled = false;
    airport.checked = false;
    airportLock.hidden = true;
  } else {
    airportLock.hidden = true;
  }
}

function choose(from, to) {
  pickup.value = from;
  arrival.value = to;
  syncAirport();
  applyPair();
}

pickup.addEventListener("change", () => {
  syncAirport();
  applyPair();
});
arrival.addEventListener("change", applyPair);
for (const el of [miles, minutes, airport, wait, stop, slow, emptyMiles, emptyMinutes]) {
  el.addEventListener("input", render);
}

for (const chip of chips) {
  chip.addEventListener("click", () => {
    const [from, to] = chip.dataset.pair.split("|");
    choose(from, to);
  });
}

swap.addEventListener("click", () => {
  const from = pickup.value;
  choose(arrival.value, from);
  swap.classList.toggle("is-spun");
});

// "Price a Club trip" and similar links preset the route on the way down.
for (const link of document.querySelectorAll("[data-preset]")) {
  link.addEventListener("click", () => {
    const [from, to] = link.dataset.preset.split("|");
    choose(from, to);
  });
}

$("#quote").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!email.disabled && email.onclick) email.onclick();
});

syncAirport();
applyPair();
