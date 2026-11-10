import { formatDollars, quote } from "./fare.js";

const PAIRS = {
  "bzn|hotel": [10, 20],
  "bzn|bigsky": [55, 80],
  "bzn|moon": [60, 90],
  "moon|bzn": [60, 90],
};

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const pickup = document.querySelector("#pickup");
const arrival = document.querySelector("#arrival");
const miles = document.querySelector("#miles");
const minutes = document.querySelector("#minutes");
const airport = document.querySelector("#airport");
const wait = document.querySelector("#wait");
const stop = document.querySelector("#stop");
const slow = document.querySelector("#slow");
const emptyMiles = document.querySelector("#empty-miles");
const emptyMinutes = document.querySelector("#empty-minutes");
const lines = document.querySelector("#lines");
const total = document.querySelector("#total");
const email = document.querySelector("#email");
const status = document.querySelector("#quote-status");
const pairHint = document.querySelector("#pair-hint");
const clubNote = document.querySelector("#club-note");
const airportLock = document.querySelector("#airport-lock");

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

function render() {
  const known = PAIRS[`${pickup.value}|${arrival.value}`];
  pairHint.hidden = !known;
  clubNote.hidden = pickup.value !== "club" && arrival.value !== "club";

  const fields = [miles, minutes, wait, stop, slow, emptyMiles, emptyMinutes];
  const negative = fields.some((el) => el.value.trim() !== "" && Number(el.value) < 0);
  const tripMiles = required(miles);
  const tripMinutes = required(minutes);
  const extras = [wait, stop, slow, emptyMiles, emptyMinutes].map(optional);
  const ready = !negative && tripMiles !== null && tripMinutes !== null && extras.every((n) => n !== null);

  if (!ready) {
    lines.replaceChildren();
    total.textContent = "";
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

  lines.replaceChildren(
    ...q.lines.map((line) => {
      const row = document.createElement("div");
      const name = document.createElement("dt");
      const amount = document.createElement("dd");
      name.textContent = line.label;
      amount.textContent = formatDollars(line.cents);
      row.append(name, amount);
      return row;
    }),
  );
  total.textContent = formatDollars(q.totalCents);
  status.textContent = "The trip charge is the lines above. The car is not held until Max or Terry reply.";

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
    "The car is not held until Max or Terry reply.",
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

pickup.addEventListener("change", () => {
  syncAirport();
  applyPair();
});
arrival.addEventListener("change", applyPair);
for (const el of [miles, minutes, airport, wait, stop, slow, emptyMiles, emptyMinutes]) {
  el.addEventListener("input", render);
}

function reveal() {
  const nodes = document.querySelectorAll("[data-pause]");
  if (reduce || !("IntersectionObserver" in window)) {
    nodes.forEach((node) => node.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    },
    { threshold: 0.35, rootMargin: "0px 0px -8% 0px" },
  );
  nodes.forEach((node) => io.observe(node));
}

function countSums() {
  const sums = document.querySelectorAll(".sum[data-cents]");
  const finish = (el) => {
    el.textContent = formatDollars(Number(el.dataset.cents));
  };
  if (reduce || !("IntersectionObserver" in window)) {
    sums.forEach(finish);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);
        const end = Number(el.dataset.cents);
        const start = performance.now();
        const tick = (now) => {
          const p = Math.min(1, (now - start) / 700);
          const eased = 1 - (1 - p) ** 3;
          el.textContent = formatDollars(Math.round(end * eased));
          if (p < 1) requestAnimationFrame(tick);
          else finish(el);
        };
        requestAnimationFrame(tick);
      });
    },
    { threshold: 0.6 },
  );
  sums.forEach((el) => io.observe(el));
}

function ridge() {
  const node = document.querySelector(".ridge");
  if (!node || reduce) return;
  window.addEventListener(
    "scroll",
    () => {
      node.style.transform = `translate3d(0, ${Math.min(24, window.scrollY * 0.035)}px, 0)`;
    },
    { passive: true },
  );
}

document.querySelector("#quote").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!email.disabled && email.onclick) email.onclick();
});

syncAirport();
applyPair();
reveal();
countSums();
ridge();
